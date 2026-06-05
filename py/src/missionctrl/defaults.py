from __future__ import annotations

from dataclasses import dataclass

from axiongraph_core import GraphStore
from axiongraph_store_local import InMemoryStore
from deltav import Budget, BudgetStore, InMemoryBudgetStore
from grantz import LocalKeyPair, generate_local_key_pair
from plugg import Principal

from .core import (
    EchoExecutor,
    MissionCtrl,
    StaticAuthAdapter,
    allow_within_token,
    create_gateway,
)
from .types import GatewayConfig


@dataclass(frozen=True)
class MissionCtrlDefaults:
    gateway: MissionCtrl
    key_pair: LocalKeyPair
    budget_store: BudgetStore
    graph_store: GraphStore
    budget_stack_id: str


def create_missionctrl(
    *,
    config: GatewayConfig | None = None,
    budget_stack: list[Budget] | None = None,
) -> MissionCtrlDefaults:
    if config is not None:
        return MissionCtrlDefaults(
            gateway=create_gateway(config),
            key_pair=config.key_pair,
            budget_store=config.budget_store,
            graph_store=config.graph_store,
            budget_stack_id=config.budget_stack_id,
        )

    key_pair = generate_local_key_pair("missionctrl-local")
    budget_stack_id = "default"
    budget_store = InMemoryBudgetStore(
        {
            budget_stack_id: (
                budget_stack or [_default_budget()],
                {},
            )
        }
    )
    graph_store = InMemoryStore()
    gateway_config = GatewayConfig(
        auth=StaticAuthAdapter({"dev-credential": _default_dev_principal()}),
        key_pair=key_pair,
        budget_store=budget_store,
        graph_store=graph_store,
        policy=allow_within_token(),
        executor=EchoExecutor(),
        budget_stack_id=budget_stack_id,
    )
    return MissionCtrlDefaults(
        gateway=create_gateway(gateway_config),
        key_pair=key_pair,
        budget_store=budget_store,
        graph_store=graph_store,
        budget_stack_id=budget_stack_id,
    )


def _default_budget() -> Budget:
    return Budget(
        id="budget_local_task",
        layer="task",
        limits={
            "model_cost_usd": 10,
            "tool_calls": 100,
        },
    )


def _default_dev_principal() -> Principal:
    return {
        "id": "dev-user",
        "kind": "user",
        "claims": {"role": "developer"},
    }
