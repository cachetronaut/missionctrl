from __future__ import annotations

from dataclasses import asdict, dataclass, is_dataclass
from typing import cast

from axiongraph_core import GraphStore
from deltav import BudgetStore, Reservation, Spend, SpendRequest
from grantz import Grant

from .types import Gateway, GatewayRequest


@dataclass(frozen=True)
class HttpResponse:
    status: int
    body: object


@dataclass(frozen=True)
class MissionCtrlHttpSurface:
    gateway: Gateway
    graph_store: GraphStore | None = None
    budget_store: BudgetStore | None = None
    budget_stack_id: str | None = None

    async def handle(self, method: str, path: str, body: object | None = None) -> HttpResponse:
        try:
            if method == "POST" and path == "/actions":
                if not isinstance(body, GatewayRequest):
                    return HttpResponse(400, {"error": "invalid_request"})
                return HttpResponse(200, _jsonable(await self.gateway.handle(body)))
            if method == "POST" and path == "/attenuate":
                if not isinstance(body, dict):
                    return HttpResponse(400, {"error": "invalid_request"})
                body_map = cast(dict[str, object], body)
                parent_token = body_map.get("parentToken")
                narrowing = body_map.get("narrowing")
                if not isinstance(parent_token, str) or not isinstance(narrowing, dict):
                    return HttpResponse(400, {"error": "invalid_request"})
                token = await self.gateway.attenuate(parent_token, cast(Grant, narrowing))
                return HttpResponse(200, {"token": token})
            if method == "GET" and path.startswith("/runs/"):
                return await self._handle_run_graph(path)
            if method == "POST" and path.startswith("/budget/"):
                return await self._handle_budget(path, body)
            return HttpResponse(404, {"error": "not_found"})
        except Exception as error:
            return HttpResponse(500, {"error": str(error)})

    async def _handle_run_graph(self, path: str) -> HttpResponse:
        parts = path.strip("/").split("/")
        if len(parts) != 3 or parts[0] != "runs" or parts[2] != "graph":
            return HttpResponse(404, {"error": "not_found"})
        if self.graph_store is None:
            return HttpResponse(501, {"error": "graph_store_unavailable"})
        return HttpResponse(200, _jsonable(await self.graph_store.snapshot(parts[1])))

    async def _handle_budget(self, path: str, body: object | None) -> HttpResponse:
        if self.budget_store is None or self.budget_stack_id is None:
            return HttpResponse(501, {"error": "budget_store_unavailable"})
        if not isinstance(body, dict):
            return HttpResponse(400, {"error": "invalid_request"})
        body_map = cast(dict[str, object], body)
        stack_id = body_map.get("stackId", self.budget_stack_id)
        if not isinstance(stack_id, str):
            return HttpResponse(400, {"error": "invalid_request"})
        if path == "/budget/load":
            stack, usages = await self.budget_store.load(stack_id)
            return HttpResponse(200, {"stack": _jsonable(stack), "usages": _jsonable(usages)})
        if path == "/budget/try-reserve":
            request = body_map.get("request")
            if not isinstance(request, SpendRequest):
                return HttpResponse(400, {"error": "invalid_request"})
            return HttpResponse(
                200, _jsonable(await self.budget_store.try_reserve(stack_id, request))
            )
        if path == "/budget/settle":
            reservation = body_map.get("reservation")
            actual = body_map.get("actual")
            if not isinstance(reservation, Reservation) or not isinstance(actual, dict):
                return HttpResponse(400, {"error": "invalid_request"})
            await self.budget_store.settle(stack_id, reservation, cast(Spend, actual))
            return HttpResponse(200, {"ok": True})
        if path == "/budget/release":
            reservation = body_map.get("reservation")
            if not isinstance(reservation, Reservation):
                return HttpResponse(400, {"error": "invalid_request"})
            await self.budget_store.release(stack_id, reservation)
            return HttpResponse(200, {"ok": True})
        if path == "/budget/snapshot":
            return HttpResponse(200, _jsonable(await self.budget_store.snapshot(stack_id)))
        return HttpResponse(404, {"error": "not_found"})


def create_missionctrl_http_surface(
    *,
    gateway: Gateway,
    graph_store: GraphStore | None = None,
    budget_store: BudgetStore | None = None,
    budget_stack_id: str | None = None,
) -> MissionCtrlHttpSurface:
    return MissionCtrlHttpSurface(
        gateway=gateway,
        graph_store=graph_store,
        budget_store=budget_store,
        budget_stack_id=budget_stack_id,
    )


def _jsonable(value: object) -> object:
    if is_dataclass(value) and not isinstance(value, type):
        return {key: _jsonable(item) for key, item in asdict(value).items()}
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [_jsonable(item) for item in value]
    return value
