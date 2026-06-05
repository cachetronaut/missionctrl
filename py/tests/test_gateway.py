from __future__ import annotations

import asyncio

from approval_surface import InMemoryPendingStore, RecordingApprovalChannel
from axiongraph_store_local import InMemoryStore
from deltav import Budget, InMemoryBudgetStore, SpendRequest
from grantz import generate_local_key_pair, mint
from plugg import Principal

from missionctrl import (
    ApprovalResolution,
    GatewayConfig,
    GatewayRequest,
    GatewayRequestAction,
    MissionCtrl,
    PolicyDecision,
    create_gateway,
    create_missionctrl,
)


def test_missionctrl_executes_and_records_graph() -> None:
    asyncio.run(_assert_missionctrl_executes_and_records_graph())


async def _assert_missionctrl_executes_and_records_graph() -> None:
    defaults = create_missionctrl()
    token = await mint(
        {
            "issuer": "issuer",
            "subject": "dev-user",
            "audience": "missionctrl",
            "scopes": [{"action": "echo", "resource": "tool.echo"}],
            "expiresAt": "2100-01-01T00:00:00Z",
        },
        defaults.key_pair,
        now="2026-01-01T00:00:00Z",
    )

    response = await defaults.gateway.handle(
        GatewayRequest(
            credential="dev-credential",
            token=token,
            action=GatewayRequestAction(
                scope={"action": "echo", "resource": "tool.echo"},
                estimate=SpendRequest({"tool_calls": 1, "model_cost_usd": 0.01}, run_id="run_1"),
                payload={"message": "hello"},
                context={"runId": "run_1"},
            ),
        )
    )

    assert response.ok
    assert response.result == {"payload": {"message": "hello"}, "principalId": "dev-user"}
    assert [step.stage for step in response.decision_trail] == [
        "authenticate",
        "authorize",
        "reserve",
        "execute",
        "settle",
    ]
    usage = await defaults.budget_store.snapshot(defaults.budget_stack_id)
    assert usage["budget_local_task"].cumulative["tool_calls"] == 1

    graph = await defaults.graph_store.snapshot("run_1")
    assert graph.nodes["run_1:authenticate"]["kind"] == "gateway_stage"
    assert graph.nodes["run_1:result"]["label"] == "completed"


def test_missionctrl_denies_uncovered_scope() -> None:
    asyncio.run(_assert_missionctrl_denies_uncovered_scope())


async def _assert_missionctrl_denies_uncovered_scope() -> None:
    defaults = create_missionctrl()
    token = await mint(
        {
            "issuer": "issuer",
            "subject": "dev-user",
            "scopes": [{"action": "echo", "resource": "tool.echo"}],
            "expiresAt": "2100-01-01T00:00:00Z",
        },
        defaults.key_pair,
        now="2026-01-01T00:00:00Z",
    )

    response = await defaults.gateway.handle(
        GatewayRequest(
            credential="dev-credential",
            token=token,
            action=GatewayRequestAction(
                scope={"action": "delete", "resource": "tool.echo"},
                estimate=SpendRequest({"tool_calls": 1}, run_id="run_denied"),
                payload={},
                context={"runId": "run_denied"},
            ),
        )
    )

    assert not response.ok
    assert response.denied is not None
    assert response.denied.stage == "authorize"
    assert response.denied.reason == "scope"


def test_missionctrl_creates_pending_approval_without_executing() -> None:
    asyncio.run(_assert_missionctrl_creates_pending_approval_without_executing())


async def _assert_missionctrl_creates_pending_approval_without_executing() -> None:
    key_pair = generate_local_key_pair("missionctrl-test")
    token = await mint(
        {
            "issuer": "issuer",
            "subject": "dev-user",
            "audience": "missionctrl",
            "scopes": [{"action": "echo", "resource": "tool.echo"}],
            "expiresAt": "2100-01-01T00:00:00Z",
        },
        key_pair,
        now="2026-01-01T00:00:00Z",
    )
    budget_stack_id = "default"
    budget_store = InMemoryBudgetStore(
        {
            budget_stack_id: (
                [
                    Budget(
                        id="budget_task",
                        layer="task",
                        limits={"tool_calls": 10, "model_cost_usd": 10},
                    )
                ],
                {},
            )
        }
    )
    approval_store = InMemoryPendingStore()
    approval_channel = RecordingApprovalChannel()
    executor = CountingExecutor()
    gateway = create_gateway(
        GatewayConfig(
            auth=StaticTestAuth(),
            key_pair=key_pair,
            budget_store=budget_store,
            graph_store=InMemoryStore(),
            policy=ApprovalPolicy(),
            executor=executor,
            budget_stack_id=budget_stack_id,
            approval_store=approval_store,
            approval_channel=approval_channel,
        )
    )

    response = await gateway.handle(
        GatewayRequest(
            credential="dev-credential",
            token=token,
            action=GatewayRequestAction(
                scope={"action": "echo", "resource": "tool.echo"},
                estimate=SpendRequest(
                    {"tool_calls": 1, "model_cost_usd": 0.01}, run_id="run_approval"
                ),
                payload={"message": "hello"},
                context={"runId": "run_approval"},
            ),
            idempotency_key="idem-approval",
        )
    )

    assert not response.ok
    assert response.denied is not None
    assert response.denied.stage == "execute"
    assert response.denied.reason == "approval_required"
    assert response.approval is not None
    assert response.approval.status == "pending"
    assert response.approval.reason == "Sensitive echo action"
    assert response.approval.approvers == ["reviewer"]
    assert await approval_store.list_pending("run_approval") == [response.approval]
    assert approval_channel.sent == [response.approval]
    assert executor.calls == 0
    assert response.usage is not None
    assert response.usage["budget_task"].reserved == {}
    assert response.usage["budget_task"].cumulative == {}
    assert [step.stage for step in response.decision_trail] == [
        "authenticate",
        "authorize",
        "reserve",
        "execute",
    ]


def test_missionctrl_resumes_approved_approval_once() -> None:
    asyncio.run(_assert_missionctrl_resumes_approved_approval_once())


async def _assert_missionctrl_resumes_approved_approval_once() -> None:
    executor = CountingExecutor()
    gateway, token, budget_store, _approval_store, _approval_channel = await _approval_gateway(
        executor
    )
    blocked = await gateway.handle(
        GatewayRequest(
            credential="dev-credential",
            token=token,
            action=GatewayRequestAction(
                scope={"action": "echo", "resource": "tool.echo"},
                estimate=SpendRequest(
                    {"tool_calls": 1, "model_cost_usd": 0.01}, run_id="run_resume"
                ),
                payload={"message": "hello"},
                context={"runId": "run_resume"},
            ),
            idempotency_key="idem-resume",
        )
    )

    assert blocked.approval is not None
    first = await gateway.resume_approval(
        ApprovalResolution(
            approval_id=blocked.approval.id,
            resolved_by="reviewer",
            decision="approve",
            note="Reviewed",
        )
    )
    second = await gateway.resume_approval(
        ApprovalResolution(
            approval_id=blocked.approval.id,
            resolved_by="reviewer",
            decision="approve",
            note="Reviewed again",
        )
    )

    assert first.ok
    assert first.result == {"approved": 1}
    assert first.approval is not None
    assert first.approval.status == "approved"
    assert second.result == {"approved": 1}
    assert executor.calls == 1
    usage = await budget_store.snapshot("default")
    assert usage["budget_task"].cumulative["model_cost_usd"] == 0.5


def test_missionctrl_denies_approval_without_executing() -> None:
    asyncio.run(_assert_missionctrl_denies_approval_without_executing())


async def _assert_missionctrl_denies_approval_without_executing() -> None:
    executor = CountingExecutor()
    gateway, token, _budget_store, approval_store, _approval_channel = await _approval_gateway(
        executor
    )
    blocked = await gateway.handle(
        GatewayRequest(
            credential="dev-credential",
            token=token,
            action=GatewayRequestAction(
                scope={"action": "echo", "resource": "tool.echo"},
                estimate=SpendRequest(
                    {"tool_calls": 1, "model_cost_usd": 0.01}, run_id="run_denied_approval"
                ),
                payload={"message": "hello"},
                context={"runId": "run_denied_approval"},
            ),
            idempotency_key="idem-denied-approval",
        )
    )

    assert blocked.approval is not None
    response = await gateway.resume_approval(
        ApprovalResolution(
            approval_id=blocked.approval.id,
            resolved_by="reviewer",
            decision="deny",
            note="No",
        )
    )

    assert not response.ok
    assert response.denied is not None
    assert response.denied.stage == "execute"
    assert response.denied.reason == "approval_denied"
    assert response.approval is not None
    assert response.approval.status == "denied"
    assert await approval_store.list_pending("run_denied_approval") == []
    assert executor.calls == 0


async def _approval_gateway(
    executor: CountingExecutor,
) -> tuple[
    MissionCtrl,
    str,
    InMemoryBudgetStore,
    InMemoryPendingStore,
    RecordingApprovalChannel,
]:
    key_pair = generate_local_key_pair("missionctrl-test")
    token = await mint(
        {
            "issuer": "issuer",
            "subject": "dev-user",
            "audience": "missionctrl",
            "scopes": [{"action": "echo", "resource": "tool.echo"}],
            "expiresAt": "2100-01-01T00:00:00Z",
        },
        key_pair,
        now="2026-01-01T00:00:00Z",
    )
    budget_stack_id = "default"
    budget_store = InMemoryBudgetStore(
        {
            budget_stack_id: (
                [
                    Budget(
                        id="budget_task",
                        layer="task",
                        limits={"tool_calls": 10, "model_cost_usd": 10},
                    )
                ],
                {},
            )
        }
    )
    approval_store = InMemoryPendingStore()
    approval_channel = RecordingApprovalChannel()
    gateway = create_gateway(
        GatewayConfig(
            auth=StaticTestAuth(),
            key_pair=key_pair,
            budget_store=budget_store,
            graph_store=InMemoryStore(),
            policy=ApprovalPolicy(),
            executor=executor,
            budget_stack_id=budget_stack_id,
            approval_store=approval_store,
            approval_channel=approval_channel,
        )
    )
    return gateway, token, budget_store, approval_store, approval_channel


class StaticTestAuth:
    async def resolve(self, credential: str) -> Principal:
        return {"id": "dev-user", "kind": "user", "claims": {}}


class ApprovalPolicy:
    async def decide(self, value: object) -> PolicyDecision:
        return PolicyDecision(
            allow=True,
            reason="within_token",
            obligations=[
                {
                    "kind": "require_human_approval",
                    "detail": {
                        "reason": "Sensitive echo action",
                        "approvers": ["reviewer"],
                        "summary": "Echo for review",
                    },
                }
            ],
        )


class CountingExecutor:
    def __init__(self) -> None:
        self.calls = 0

    async def execute(self, payload: object, context: object) -> tuple[object, dict[str, float]]:
        self.calls += 1
        return {"approved": self.calls}, {"tool_calls": 1, "model_cost_usd": 0.5}
