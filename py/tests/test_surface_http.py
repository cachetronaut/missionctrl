from __future__ import annotations

import asyncio
from typing import cast

from deltav import Budget, SpendRequest
from grantz import LocalKeyPair, mint

from missionctrl import GatewayRequest, GatewayRequestAction, create_missionctrl
from missionctrl.surface_http import create_missionctrl_http_surface


def test_http_surface_maps_actions_to_gateway() -> None:
    asyncio.run(_assert_http_surface_maps_actions_to_gateway())


async def _assert_http_surface_maps_actions_to_gateway() -> None:
    defaults = create_missionctrl()
    token = await _token(defaults.key_pair)
    surface = create_missionctrl_http_surface(
        gateway=defaults.gateway,
        graph_store=defaults.graph_store,
        budget_store=defaults.budget_store,
        budget_stack_id=defaults.budget_stack_id,
    )

    response = await surface.handle(
        "POST",
        "/actions",
        GatewayRequest(
            credential="dev-credential",
            token=token,
            action=GatewayRequestAction(
                scope={"action": "echo", "resource": "tool.echo"},
                estimate=SpendRequest({"tool_calls": 1}, run_id="run_surface"),
                payload={"message": "hello"},
                context={"runId": "run_surface"},
            ),
        ),
    )

    assert response.status == 200
    assert isinstance(response.body, dict)
    body = cast(dict[str, object], response.body)
    assert body["ok"] is True
    assert body["result"] == {"payload": {"message": "hello"}, "principalId": "dev-user"}


def test_http_surface_maps_attenuate_to_gateway() -> None:
    asyncio.run(_assert_http_surface_maps_attenuate_to_gateway())


async def _assert_http_surface_maps_attenuate_to_gateway() -> None:
    defaults = create_missionctrl()
    parent_token = await _token(defaults.key_pair)
    surface = create_missionctrl_http_surface(gateway=defaults.gateway)

    response = await surface.handle(
        "POST",
        "/attenuate",
        {
            "parentToken": parent_token,
            "narrowing": {
                "scopes": [{"action": "echo", "resource": "tool.echo"}],
                "expiresAt": "2099-01-01T00:00:00Z",
            },
        },
    )

    assert response.status == 200
    assert isinstance(response.body, dict)
    body = cast(dict[str, object], response.body)
    assert "." in str(body["token"])


def test_http_surface_serves_budget_endpoints() -> None:
    asyncio.run(_assert_http_surface_serves_budget_endpoints())


async def _assert_http_surface_serves_budget_endpoints() -> None:
    defaults = create_missionctrl(
        budget_stack=[Budget(id="budget_task", layer="task", limits={"model_cost_usd": 1})]
    )
    surface = create_missionctrl_http_surface(
        gateway=defaults.gateway,
        budget_store=defaults.budget_store,
        budget_stack_id=defaults.budget_stack_id,
    )

    response = await surface.handle(
        "POST",
        "/budget/try-reserve",
        {"request": SpendRequest({"model_cost_usd": 0.5}, run_id="run_budget")},
    )

    assert response.status == 200
    assert isinstance(response.body, dict)
    body = cast(dict[str, object], response.body)
    assert body["ok"] is True
    reservation = body["reservation"]
    assert isinstance(reservation, dict)
    reservation_map = cast(dict[str, object], reservation)
    assert str(reservation_map["id"]).startswith("reservation_")


async def _token(key_pair: LocalKeyPair) -> str:
    return await mint(
        {
            "issuer": "issuer",
            "subject": "dev-user",
            "audience": "missionctrl",
            "scopes": [{"action": "echo", "resource": "tool.echo"}],
            "binding": {"runId": "run_surface"},
            "expiresAt": "2100-01-01T00:00:00Z",
        },
        key_pair,
        now="2026-01-01T00:00:00Z",
    )
