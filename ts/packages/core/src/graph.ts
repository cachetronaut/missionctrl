import type { GraphEvent, GraphStore } from '@axiongraph/core';
import type { DecisionStep } from './types.js';

export class GraphRecorder {
  private readonly nextSeqByRun = new Map<string, number>();

  constructor(private readonly graphStore: GraphStore) {}

  async recordStep(runId: string, step: DecisionStep): Promise<void> {
    const stageNodeId = `${runId}:${step.stage}`;
    await this.append(runId, [
      {
        type: 'node_created',
        node: {
          id: stageNodeId,
          kind: 'gateway_stage',
          label: step.stage,
          metadata: { ok: step.ok, ...step.detail },
        },
      },
    ]);
  }

  async recordResult(runId: string, status: 'completed' | 'failed' | 'blocked'): Promise<void> {
    await this.append(runId, [
      {
        type: 'node_created',
        node: {
          id: `${runId}:result`,
          kind: 'gateway_result',
          label: status,
        },
      },
      {
        type: 'edge_created',
        edge: {
          id: `${runId}:pipeline:${status}`,
          kind: 'gateway_pipeline',
          from: `${runId}:authenticate`,
          to: `${runId}:result`,
          status,
        },
      },
    ]);
  }

  private async append(
    runId: string,
    entries: readonly (
      | Omit<Extract<GraphEvent, { type: 'node_created' }>, 'id' | 'runId' | 'seq' | 'ts'>
      | Omit<Extract<GraphEvent, { type: 'edge_created' }>, 'id' | 'runId' | 'seq' | 'ts'>
    )[],
  ): Promise<void> {
    const events: GraphEvent[] = entries.map((entry) => {
      const seq = this.nextSeq(runId);
      return {
        id: `${runId}:event:${seq}`,
        runId,
        seq,
        ts: new Date().toISOString(),
        ...entry,
      } as GraphEvent;
    });
    await this.graphStore.append(events);
  }

  private nextSeq(runId: string): number {
    const seq = this.nextSeqByRun.get(runId) ?? 1;
    this.nextSeqByRun.set(runId, seq + 1);
    return seq;
  }
}
