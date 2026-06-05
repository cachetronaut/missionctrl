import { mint } from '@grantz/core';
import { describe, expect, it } from 'vitest';
import { createMissionCtrl } from '../src/index';

describe('createMissionCtrl', () => {
  it('proves the no-service laptop demo path', async () => {
    const wiring = createMissionCtrl({
      now: () => new Date('2026-06-04T12:00:00.000Z'),
    });
    const token = await mint(
      {
        issuer: 'issuer_gateway',
        subject: 'principal_dev_agent',
        audience: 'gateway',
        scopes: [{ action: 'tool.call', resource: 'mcp://browser.open' }],
        binding: { runId: 'run_laptop_demo' },
        expiresAt: '2026-06-04T13:00:00.000Z',
      },
      wiring.signer,
      { now: '2026-06-04T12:00:00.000Z', id: 'jti_laptop_demo' },
    );

    const response = await wiring.gateway.handle({
      credential: 'dev-credential',
      token,
      idempotencyKey: 'laptop-demo',
      action: {
        scope: { action: 'tool.call', resource: 'mcp://browser.open' },
        context: { runId: 'run_laptop_demo' },
        estimate: { runId: 'run_laptop_demo', estimate: { model_cost_usd: 1 } },
        payload: { result: 'demo-ok', actual: { model_cost_usd: 0.25 } },
      },
    });

    expect(response.ok).toBe(true);
    expect(response.result).toBe('demo-ok');
    expect(response.decisionTrail.map((step) => step.stage)).toEqual([
      'authenticate',
      'authorize',
      'reserve',
      'execute',
      'settle',
    ]);
    expect(response.usage?.budget_local_task?.cumulative.model_cost_usd).toBe(0.25);
    const graph = await wiring.graphStore.snapshot('run_laptop_demo');
    expect(graph.nodes.has('run_laptop_demo:authenticate')).toBe(true);
    expect(graph.nodes.has('run_laptop_demo:result')).toBe(true);
  });

  it('reaps expired active reservations', async () => {
    let now = new Date('2026-06-04T12:00:00.000Z');
    let unblockExecutor!: () => void;
    let markExecutorEntered!: () => void;
    const executorEntered = new Promise<void>((resolve) => {
      markExecutorEntered = resolve;
    });
    const unblock = new Promise<void>((resolve) => {
      unblockExecutor = resolve;
    });
    const wiring = createMissionCtrl({
      defaultRunTtlMs: 1,
      now: () => now,
      executor: {
        async execute() {
          markExecutorEntered();
          await unblock;
          return { result: 'late', actual: { model_cost_usd: 1 } };
        },
      },
    });
    const token = await mint(
      {
        issuer: 'issuer_gateway',
        subject: 'principal_dev_agent',
        scopes: [{ action: 'tool.call', resource: 'mcp://browser.open' }],
        binding: { runId: 'run_expired' },
        expiresAt: '2026-06-04T13:00:00.000Z',
      },
      wiring.signer,
      { now: now.toISOString(), id: 'jti_expired' },
    );

    const pending = wiring.gateway.handle({
      credential: 'dev-credential',
      token,
      action: {
        scope: { action: 'tool.call', resource: 'mcp://browser.open' },
        context: { runId: 'run_expired' },
        estimate: { runId: 'run_expired', estimate: { model_cost_usd: 1 } },
        payload: {},
      },
    });
    await executorEntered;
    now = new Date('2026-06-04T12:00:01.000Z');

    expect(await wiring.gateway.reapExpiredRuns()).toEqual(['run_expired']);
    expect(
      (await wiring.budgetStore.snapshot(wiring.budgetStackId)).budget_local_task?.reserved
        .model_cost_usd,
    ).toBeUndefined();
    unblockExecutor();
    await pending;
  });
});
