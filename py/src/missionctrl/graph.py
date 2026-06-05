from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal, cast

from axiongraph_core import GraphEvent, GraphStore

from .types import DecisionStep

ResultStatus = Literal["completed", "failed", "blocked"]


class GraphRecorder:
    def __init__(self, graph_store: GraphStore) -> None:
        self._graph_store = graph_store
        self._next_seq_by_run: dict[str, int] = {}

    async def record_step(self, run_id: str, step: DecisionStep) -> None:
        await self._append(
            run_id,
            [
                {
                    "type": "node_created",
                    "node": {
                        "id": f"{run_id}:{step.stage}",
                        "kind": "gateway_stage",
                        "label": step.stage,
                        "metadata": {"ok": step.ok, **step.detail},
                    },
                }
            ],
        )

    async def record_result(self, run_id: str, status: ResultStatus) -> None:
        await self._append(
            run_id,
            [
                {
                    "type": "node_created",
                    "node": {
                        "id": f"{run_id}:result",
                        "kind": "gateway_result",
                        "label": status,
                    },
                },
                {
                    "type": "edge_created",
                    "edge": {
                        "id": f"{run_id}:pipeline:{status}",
                        "kind": "gateway_pipeline",
                        "from": f"{run_id}:authenticate",
                        "to": f"{run_id}:result",
                        "status": status,
                    },
                },
            ],
        )

    async def _append(self, run_id: str, entries: list[dict[str, object]]) -> None:
        events: list[GraphEvent] = []
        for entry in entries:
            seq = self._next_seq(run_id)
            event = {
                "id": f"{run_id}:event:{seq}",
                "runId": run_id,
                "seq": seq,
                "ts": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                **entry,
            }
            events.append(cast(GraphEvent, event))
        await self._graph_store.append(events)

    def _next_seq(self, run_id: str) -> int:
        seq = self._next_seq_by_run.get(run_id, 1)
        self._next_seq_by_run[run_id] = seq + 1
        return seq
