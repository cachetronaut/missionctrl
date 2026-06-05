from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, cast

from approval_surface import ApprovalSpec, expire_if_due
from approval_surface import request as request_approval
from approval_surface import resolve as resolve_approval
from deltav import Reservation
from grantz import Grant, TokenClaims, attenuate, authorize, verify
from nvoke import ExecuteContext as ConnectorExecuteContext
from nvoke import in_process_connector
from plugg import AuthError, Principal
from verdik import allow_within_token_policy

from .graph import GraphRecorder
from .types import (
    ApprovalResolution,
    DecisionStage,
    DecisionStep,
    Denied,
    ExecuteContext,
    GatewayConfig,
    GatewayRequest,
    GatewayResponse,
    PendingApprovalState,
    PolicyDecision,
    PolicyInput,
    RunState,
)


class MissionCtrl:
    def __init__(self, config: GatewayConfig) -> None:
        self._config = config
        self._idempotency: dict[str, GatewayResponse] = {}
        self._pending_approvals: dict[str, PendingApprovalState] = {}
        self._resumed_approvals: dict[str, GatewayResponse] = {}
        self._runs: dict[str, RunState] = {}
        self._recorder = GraphRecorder(config.graph_store)

    async def handle(self, request: GatewayRequest) -> GatewayResponse:
        if request.idempotency_key is not None and request.idempotency_key in self._idempotency:
            return self._idempotency[request.idempotency_key]
        response = await self._handle_once(request)
        if request.idempotency_key is not None:
            self._idempotency[request.idempotency_key] = response
        return response

    async def resume_approval(self, resolution: ApprovalResolution) -> GatewayResponse:
        if resolution.approval_id in self._resumed_approvals:
            return self._resumed_approvals[resolution.approval_id]
        response = await self._resume_approval_once(resolution)
        self._resumed_approvals[resolution.approval_id] = response
        return response

    async def attenuate(self, parent_token: str, narrowing: Grant) -> str:
        return await attenuate(parent_token, narrowing, self._config.key_pair, now=self._now_iso())

    async def reap_expired_runs(self) -> list[str]:
        now_ms = self._now_ms()
        expired: list[str] = []
        for run in self._runs.values():
            if run.status != "active" or run.expires_at_ms > now_ms:
                continue
            run.status = "stalled"
            for reservation in run.reservations.values():
                await self._config.budget_store.release(self._config.budget_stack_id, reservation)
            run.reservations.clear()
            await self._recorder.record_result(run.run_id, "failed")
            expired.append(run.run_id)
        return expired

    async def _handle_once(self, request: GatewayRequest) -> GatewayResponse:
        run_id = request.action.context.get("runId") if request.action.context else None
        run_id = run_id or request.action.estimate.run_id or "run_default"
        run = self._ensure_run(run_id, request.run_ttl_ms)
        trail: list[DecisionStep] = []
        reservation: Reservation | None = None

        async def add_step(
            stage: DecisionStage,
            ok: bool,
            detail: dict[str, object],
        ) -> None:
            step = DecisionStep(stage, ok, detail)
            trail.append(step)
            await self._recorder.record_step(run_id, step)

        try:
            principal = await self._config.auth.resolve(request.credential)
            await add_step(
                "authenticate", True, {"principalId": principal["id"], "kind": principal["kind"]}
            )

            verified, claims_or_reason = await verify(
                request.token,
                self._config.key_pair,
                now=self._now_iso(),
            )
            if not verified or not isinstance(claims_or_reason, dict):
                reason = str(claims_or_reason)
                await add_step("authorize", False, {"reason": reason})
                await self._recorder.record_result(run_id, "blocked")
                return _deny("authorize", reason, trail)
            claims: TokenClaims = claims_or_reason  # type: ignore[assignment]

            token_ok, token_reason = authorize(
                claims,
                request.action.scope,
                request.action.context,
            )
            if not token_ok:
                await add_step("authorize", False, {"reason": token_reason})
                await self._recorder.record_result(run_id, "blocked")
                return _deny("authorize", token_reason, trail)

            policy_decision = await self._config.policy.decide(
                {
                    "principal": principal,
                    "claims": claims,
                    "scope": request.action.scope,
                    "context": request.action.context,
                    "estimate": request.action.estimate,
                }
            )
            if not policy_decision.allow:
                await add_step(
                    "authorize",
                    False,
                    {"reason": policy_decision.reason, "obligations": policy_decision.obligations},
                )
                await self._recorder.record_result(run_id, "blocked")
                return _deny("authorize", policy_decision.reason, trail)
            await add_step("authorize", True, {})

            reserve_decision = await self._config.budget_store.try_reserve(
                self._config.budget_stack_id,
                request.action.estimate,
            )
            if not reserve_decision.ok or reserve_decision.reservation is None:
                await add_step("reserve", False, {"breach": reserve_decision.breach})
                await self._recorder.record_result(run_id, "blocked")
                return GatewayResponse(
                    ok=False,
                    decision_trail=trail,
                    denied=Denied("reserve", "budget_breach"),
                    usage=await self._config.budget_store.snapshot(self._config.budget_stack_id),
                )
            reservation = reserve_decision.reservation
            run.reservations[reservation.id] = reservation
            await add_step("reserve", True, {"reservationId": reservation.id})

            approval_obligation = _find_approval_obligation(policy_decision.obligations)
            if approval_obligation is not None:
                if self._config.approval_store is None:
                    await self._config.budget_store.release(
                        self._config.budget_stack_id, reservation
                    )
                    run.reservations.pop(reservation.id, None)
                    run.status = "settled"
                    await add_step("execute", False, {"reason": "approval_surface_unavailable"})
                    await self._recorder.record_result(run_id, "blocked")
                    return GatewayResponse(
                        ok=False,
                        decision_trail=trail,
                        denied=Denied("execute", "approval_surface_unavailable"),
                        usage=await self._config.budget_store.snapshot(
                            self._config.budget_stack_id
                        ),
                    )

                approval = request_approval(
                    _approval_spec_from_obligation(
                        obligation=approval_obligation,
                        request=request,
                        principal_id=principal["id"],
                        run_id=run_id,
                        expires_at=datetime.fromtimestamp(run.expires_at_ms / 1000, UTC)
                        .isoformat()
                        .replace("+00:00", "Z"),
                    )
                )
                await self._config.approval_store.put(approval)
                if self._config.approval_channel is not None:
                    await self._config.approval_channel.notify(approval)
                self._pending_approvals[approval.id] = PendingApprovalState(
                    request=request,
                    principal=principal,
                    claims=claims,
                    run_id=run_id,
                )
                await self._config.budget_store.release(self._config.budget_stack_id, reservation)
                run.reservations.pop(reservation.id, None)
                run.status = "settled"
                await add_step(
                    "execute", False, {"reason": "approval_required", "approvalId": approval.id}
                )
                await self._recorder.record_result(run_id, "blocked")
                return GatewayResponse(
                    ok=False,
                    decision_trail=trail,
                    denied=Denied("execute", "approval_required"),
                    approval=approval,
                    usage=await self._config.budget_store.snapshot(self._config.budget_stack_id),
                )

            result, actual = await self._config.executor.execute(
                request.action.payload,
                {
                    "principal": principal,
                    "claims": claims,
                    "scope": request.action.scope,
                    "context": request.action.context,
                },
            )
            await add_step("execute", True, {"actual": actual})

            await self._config.budget_store.settle(
                self._config.budget_stack_id, reservation, actual
            )
            run.reservations.pop(reservation.id, None)
            run.status = "settled"
            usage = await self._config.budget_store.snapshot(self._config.budget_stack_id)
            await add_step("settle", True, {"reservationId": reservation.id})
            await self._recorder.record_result(run_id, "completed")
            return GatewayResponse(ok=True, result=result, decision_trail=trail, usage=usage)
        except Exception as error:
            if reservation is not None:
                await self._config.budget_store.release(self._config.budget_stack_id, reservation)
                run.reservations.pop(reservation.id, None)
            run.status = "settled"
            reason = _error_message(error)
            await add_step("execute", False, {"reason": reason})
            await self._recorder.record_result(run_id, "failed")
            return GatewayResponse(
                ok=False,
                decision_trail=trail,
                denied=Denied("execute", reason),
                usage=await self._config.budget_store.snapshot(self._config.budget_stack_id),
            )

    async def _resume_approval_once(self, resolution: ApprovalResolution) -> GatewayResponse:
        if self._config.approval_store is None:
            return _deny("execute", "approval_surface_unavailable", [])

        stored = await self._config.approval_store.get(resolution.approval_id)
        if stored is None:
            return _deny("execute", "approval_not_found", [])

        now = self._now_iso()
        unexpired = expire_if_due(stored, now)
        if unexpired.status == "expired":
            await self._config.approval_store.put(unexpired)
            self._pending_approvals.pop(resolution.approval_id, None)
            return GatewayResponse(
                ok=False,
                decision_trail=[],
                denied=Denied("execute", "approval_expired"),
                approval=unexpired,
            )

        approval = resolve_approval(
            unexpired,
            by=resolution.resolved_by,
            decision=resolution.decision,
            now=now,
            note=resolution.note,
        )
        await self._config.approval_store.put(approval)
        pending = self._pending_approvals.get(resolution.approval_id)
        if approval.status != "approved":
            if pending is not None:
                await self._recorder.record_result(pending.run_id, "blocked")
            self._pending_approvals.pop(resolution.approval_id, None)
            return GatewayResponse(
                ok=False,
                decision_trail=[],
                denied=Denied("execute", "approval_denied"),
                approval=approval,
            )
        if pending is None:
            return GatewayResponse(
                ok=False,
                decision_trail=[],
                denied=Denied("execute", "approval_state_missing"),
                approval=approval,
            )

        run = self._ensure_run(pending.run_id, pending.request.run_ttl_ms)
        trail: list[DecisionStep] = []
        reservation: Reservation | None = None

        async def add_step(
            stage: DecisionStage,
            ok: bool,
            detail: dict[str, object],
        ) -> None:
            step = DecisionStep(stage, ok, detail)
            trail.append(step)
            await self._recorder.record_step(pending.run_id, step)

        try:
            reserve_decision = await self._config.budget_store.try_reserve(
                self._config.budget_stack_id,
                pending.request.action.estimate,
            )
            if not reserve_decision.ok or reserve_decision.reservation is None:
                await add_step("reserve", False, {"breach": reserve_decision.breach})
                await self._recorder.record_result(pending.run_id, "blocked")
                return GatewayResponse(
                    ok=False,
                    decision_trail=trail,
                    denied=Denied("reserve", "budget_breach"),
                    approval=approval,
                    usage=await self._config.budget_store.snapshot(self._config.budget_stack_id),
                )

            reservation = reserve_decision.reservation
            run.reservations[reservation.id] = reservation
            await add_step(
                "reserve", True, {"reservationId": reservation.id, "approvalId": approval.id}
            )

            result, actual = await self._config.executor.execute(
                pending.request.action.payload,
                {
                    "principal": pending.principal,
                    "claims": pending.claims,
                    "scope": pending.request.action.scope,
                    "context": pending.request.action.context,
                },
            )
            await add_step("execute", True, {"actual": actual, "approvalId": approval.id})

            await self._config.budget_store.settle(
                self._config.budget_stack_id, reservation, actual
            )
            run.reservations.pop(reservation.id, None)
            run.status = "settled"
            self._pending_approvals.pop(resolution.approval_id, None)
            usage = await self._config.budget_store.snapshot(self._config.budget_stack_id)
            await add_step("settle", True, {"reservationId": reservation.id})
            await self._recorder.record_result(pending.run_id, "completed")
            return GatewayResponse(
                ok=True,
                result=result,
                decision_trail=trail,
                usage=usage,
                approval=approval,
            )
        except Exception as error:
            if reservation is not None:
                await self._config.budget_store.release(self._config.budget_stack_id, reservation)
                run.reservations.pop(reservation.id, None)
            run.status = "settled"
            reason = _error_message(error)
            await add_step("execute", False, {"reason": reason, "approvalId": approval.id})
            await self._recorder.record_result(pending.run_id, "failed")
            return GatewayResponse(
                ok=False,
                decision_trail=trail,
                denied=Denied("execute", reason),
                approval=approval,
                usage=await self._config.budget_store.snapshot(self._config.budget_stack_id),
            )

    def _ensure_run(self, run_id: str, ttl_ms: int | None) -> RunState:
        if run_id in self._runs:
            return self._runs[run_id]
        run = RunState(
            run_id=run_id,
            expires_at_ms=self._now_ms() + (ttl_ms or self._config.default_run_ttl_ms),
        )
        self._runs[run_id] = run
        return run

    def _now(self) -> datetime:
        if self._config.now is not None:
            return self._config.now()
        return datetime.now(UTC)

    def _now_iso(self) -> str:
        return self._now().isoformat().replace("+00:00", "Z")

    def _now_ms(self) -> int:
        return int(self._now().timestamp() * 1000)


class StaticAuthAdapter:
    def __init__(self, credentials: dict[str, Principal]) -> None:
        self._credentials = credentials

    async def resolve(self, credential: str) -> Principal:
        try:
            return self._credentials[credential]
        except KeyError as error:
            raise AuthError("invalid_credential", "Unknown credential") from error


class AllowWithinTokenPolicy:
    def __init__(self) -> None:
        self._engine = allow_within_token_policy()

    async def decide(self, value: PolicyInput) -> PolicyDecision:
        decision = await self._engine.decide(dict(value))
        return PolicyDecision(
            allow=decision.allow,
            reason=decision.reason,
            obligations=[dict(obligation) for obligation in decision.obligations],
        )


class EchoExecutor:
    def __init__(self) -> None:
        self._connector = in_process_connector(
            id="missionctrl_echo",
            required_scope={"action": "*", "resource": "*", "qualifier": None},
            reversibility="read",
            execute=self._execute,
        )

    async def execute(
        self, payload: object, context: ExecuteContext
    ) -> tuple[object, dict[str, float]]:
        connector_context = cast(
            ConnectorExecuteContext,
            {
                "principal": context["principal"],
                "claims": context["claims"],
                "scope": dict(context["scope"]),
                "context": context["context"] or {},
            },
        )
        return await self._connector.execute(payload, connector_context)

    async def _execute(
        self, payload: object, context: ConnectorExecuteContext
    ) -> tuple[object, dict[str, float]]:
        principal = cast(dict[str, object], context["principal"])
        return {"payload": payload, "principalId": principal["id"]}, {
            "tool_calls": 1,
            "model_cost_usd": 0,
        }


def create_gateway(config: GatewayConfig) -> MissionCtrl:
    return MissionCtrl(config)


def allow_within_token() -> AllowWithinTokenPolicy:
    return AllowWithinTokenPolicy()


def _deny(stage: DecisionStage, reason: str, trail: list[DecisionStep]) -> GatewayResponse:
    return GatewayResponse(ok=False, decision_trail=trail, denied=Denied(stage, reason))


def _error_message(error: object) -> str:
    return str(error) if str(error) else "Execution failed"


def _find_approval_obligation(obligations: list[dict[str, object]]) -> dict[str, object] | None:
    for obligation in obligations:
        if obligation.get("kind") == "require_human_approval":
            return obligation
    return None


def _approval_spec_from_obligation(
    *,
    obligation: dict[str, object],
    request: GatewayRequest,
    principal_id: str,
    run_id: str,
    expires_at: str,
) -> ApprovalSpec:
    detail = cast(dict[str, Any], obligation.get("detail") or {})
    scope = request.action.scope
    return ApprovalSpec(
        run_id=run_id,
        task_id=_string_detail(detail.get("taskId")),
        action={
            "scope": {
                "action": scope["action"],
                "resource": scope["resource"],
                "qualifier": scope.get("qualifier"),
            },
            "summary": _string_detail(detail.get("summary"))
            or f"{scope['action']} {scope['resource']}",
        },
        requested_by=principal_id,
        approvers=_string_list_detail(detail.get("approvers")),
        reason=_string_detail(detail.get("reason")) or "Human approval is required",
        expires_at=_string_detail(detail.get("expiresAt")) or expires_at,
    )


def _string_detail(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _string_list_detail(value: object) -> list[str] | None:
    if not isinstance(value, list) or not value:
        return None
    if not all(isinstance(item, str) for item in value):
        return None
    return cast(list[str], value)
