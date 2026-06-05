from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, TypedDict

from approval_surface import Approval
from axiongraph_core import GraphStore
from deltav import BudgetStore, Reservation, SpendRequest, UsageMap
from grantz import Grant, LocalKeyPair, Scope, TokenClaims
from plugg import AuthAdapter, Principal

DecisionStage = Literal["authenticate", "authorize", "reserve", "execute", "settle"]


@dataclass(frozen=True)
class GatewayRequestAction:
    scope: Scope
    estimate: SpendRequest
    payload: object
    context: dict[str, str] | None = None


@dataclass(frozen=True)
class GatewayRequest:
    credential: str
    token: str
    action: GatewayRequestAction
    idempotency_key: str | None = None
    run_ttl_ms: int | None = None


@dataclass(frozen=True)
class DecisionStep:
    stage: DecisionStage
    ok: bool
    detail: dict[str, object]


@dataclass(frozen=True)
class Denied:
    stage: DecisionStage
    reason: str


@dataclass(frozen=True)
class GatewayResponse:
    ok: bool
    decision_trail: list[DecisionStep]
    result: object | None = None
    usage: UsageMap | None = None
    approval: Approval | None = None
    denied: Denied | None = None


@dataclass(frozen=True)
class ApprovalResolution:
    approval_id: str
    resolved_by: str
    decision: Literal["approve", "deny"]
    note: str | None = None


class PolicyInput(TypedDict):
    principal: Principal
    claims: TokenClaims
    scope: Scope
    context: dict[str, str] | None
    estimate: SpendRequest


@dataclass(frozen=True)
class PolicyDecision:
    allow: bool
    reason: str
    obligations: list[dict[str, object]] = field(default_factory=list)


class PolicyPort(Protocol):
    async def decide(self, value: PolicyInput) -> PolicyDecision: ...


class ExecuteContext(TypedDict):
    principal: Principal
    claims: TokenClaims
    scope: Scope
    context: dict[str, str] | None


class Executor(Protocol):
    async def execute(
        self, payload: object, context: ExecuteContext
    ) -> tuple[object, dict[str, float]]: ...


class ApprovalPendingStore(Protocol):
    async def put(self, approval: Approval) -> None: ...
    async def get(self, approval_id: str) -> Approval | None: ...


class ApprovalChannel(Protocol):
    async def notify(self, approval: Approval) -> None: ...


@dataclass(frozen=True)
class GatewayConfig:
    auth: AuthAdapter
    key_pair: LocalKeyPair
    budget_store: BudgetStore
    graph_store: GraphStore
    policy: PolicyPort
    executor: Executor
    budget_stack_id: str
    approval_store: ApprovalPendingStore | None = None
    approval_channel: ApprovalChannel | None = None
    default_run_ttl_ms: int = 60_000
    now: Any | None = None


@dataclass
class RunState:
    run_id: str
    expires_at_ms: int
    status: Literal["active", "settled", "stalled"] = "active"
    reservations: dict[str, Reservation] = field(default_factory=dict)


@dataclass(frozen=True)
class PendingApprovalState:
    request: GatewayRequest
    principal: Principal
    claims: TokenClaims
    run_id: str


class Gateway(Protocol):
    async def handle(self, request: GatewayRequest) -> GatewayResponse: ...
    async def resume_approval(self, resolution: ApprovalResolution) -> GatewayResponse: ...
    async def attenuate(self, parent_token: str, narrowing: Grant) -> str: ...
    async def reap_expired_runs(self) -> list[str]: ...
