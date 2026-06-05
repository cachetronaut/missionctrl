import { InMemoryPendingStore, RecordingApprovalChannel } from '@approval-surface/local';
import { InMemoryStore } from '@axiongraph/store-local';
import { InMemoryBudgetStore } from '@delta-v/store-local';
import { mint } from '@grantz/core';
import {
  Ed25519LocalSigner,
  Ed25519LocalVerifier,
  generateLocalKeyPair,
} from '@grantz/signer-local';
import { describe, expect, it } from 'vitest';
import type { Executor, GatewayRequest } from '../src/index';
import { createGateway } from '../src/index';

const NOW = new Date('2026-06-04T12:00:00.000Z');
const RUN = 'run_gateway_core';

async function setup(executor: Executor = echoExecutor()) {
  const keyPair = generateLocalKeyPair('test-key');
  const signer = new Ed25519LocalSigner(keyPair);
  const verifier = new Ed25519LocalVerifier([keyPair]);
  const token = await mint(
    {
      issuer: 'issuer_gateway',
      subject: 'principal_dev_agent',
      audience: 'gateway',
      scopes: [{ action: 'tool.call', resource: 'mcp://browser.open' }],
      binding: { runId: RUN },
      expiresAt: '2026-06-04T13:00:00.000Z',
    },
    signer,
    { now: NOW.toISOString(), id: 'jti_gateway' },
  );
  const budgetStore = new InMemoryBudgetStore({
    default: {
      stack: [{ id: 'budget_task', layer: 'task', limits: { model_cost_usd: 2 } }],
    },
  });
  const graphStore = new InMemoryStore();
  const gateway = createGateway({
    auth: {
      async resolve() {
        return { id: 'principal_dev_agent', kind: 'agent', claims: {} };
      },
    },
    verifier,
    budgetStore,
    graphStore,
    policy: {
      async decide() {
        return { allow: true, reason: 'within_token' };
      },
    },
    executor,
    budgetStackId: 'default',
    now: () => NOW,
  });
  return { gateway, token, budgetStore, graphStore };
}

async function setupApprovalGate(executor: Executor = echoExecutor()) {
  const keyPair = generateLocalKeyPair('test-key');
  const signer = new Ed25519LocalSigner(keyPair);
  const verifier = new Ed25519LocalVerifier([keyPair]);
  const token = await mint(
    {
      issuer: 'issuer_gateway',
      subject: 'principal_dev_agent',
      audience: 'gateway',
      scopes: [{ action: 'tool.call', resource: 'mcp://browser.open' }],
      binding: { runId: RUN },
      expiresAt: '2026-06-04T13:00:00.000Z',
    },
    signer,
    { now: NOW.toISOString(), id: 'jti_gateway_approval' },
  );
  const budgetStore = new InMemoryBudgetStore({
    default: {
      stack: [{ id: 'budget_task', layer: 'task', limits: { model_cost_usd: 2 } }],
    },
  });
  const approvalStore = new InMemoryPendingStore();
  const approvalChannel = new RecordingApprovalChannel();
  const gateway = createGateway({
    auth: {
      async resolve() {
        return { id: 'principal_dev_agent', kind: 'agent', claims: {} };
      },
    },
    verifier,
    budgetStore,
    graphStore: new InMemoryStore(),
    policy: {
      async decide() {
        return {
          allow: true,
          reason: 'within_token',
          obligations: [
            {
              kind: 'require_human_approval',
              detail: {
                reason: 'Sensitive browser action',
                approvers: ['principal_reviewer'],
                summary: 'Open browser for review',
              },
            },
          ],
        };
      },
    },
    executor,
    approvalStore,
    approvalChannel,
    budgetStackId: 'default',
    now: () => NOW,
  });
  return { gateway, token, budgetStore, approvalStore, approvalChannel };
}

function request(token: string, overrides: Partial<GatewayRequest> = {}): GatewayRequest {
  return {
    credential: 'dev-credential',
    token,
    idempotencyKey: 'idem-1',
    action: {
      scope: { action: 'tool.call', resource: 'mcp://browser.open' },
      context: { runId: RUN },
      estimate: { runId: RUN, estimate: { model_cost_usd: 1 } },
      payload: { result: 'ok', actual: { model_cost_usd: 0.5 } },
    },
    ...overrides,
  };
}

describe('MissionCtrl core', () => {
  it('runs authenticate to authorize to reserve to execute to settle and records graph events', async () => {
    const { gateway, token, budgetStore, graphStore } = await setup();

    const response = await gateway.handle(request(token));

    expect(response.ok).toBe(true);
    expect(response.result).toBe('ok');
    expect(response.decisionTrail.map((step) => step.stage)).toEqual([
      'authenticate',
      'authorize',
      'reserve',
      'execute',
      'settle',
    ]);
    expect(response.usage?.budget_task?.cumulative.model_cost_usd).toBe(0.5);
    expect(response.usage?.budget_task?.reserved.model_cost_usd).toBeUndefined();
    expect((await budgetStore.snapshot('default')).budget_task?.cumulative.model_cost_usd).toBe(
      0.5,
    );
    const graph = await graphStore.snapshot(RUN);
    expect(graph.nodes.has(`${RUN}:authenticate`)).toBe(true);
    expect(graph.nodes.has(`${RUN}:result`)).toBe(true);
  });

  it('denies before budget reservation when token scope is not covered', async () => {
    const { gateway, token, budgetStore } = await setup();

    const response = await gateway.handle(
      request(token, {
        idempotencyKey: 'idem-deny',
        action: {
          ...request(token).action,
          scope: { action: 'tool.call', resource: 'filesystem.write' },
        },
      }),
    );

    expect(response.ok).toBe(false);
    expect(response.denied).toEqual({ stage: 'authorize', reason: 'scope' });
    expect(await budgetStore.snapshot('default')).toEqual({});
  });

  it('releases budget reservations when execution fails', async () => {
    const { gateway, token, budgetStore } = await setup({
      async execute() {
        throw new Error('executor failed');
      },
    });

    const response = await gateway.handle(request(token, { idempotencyKey: 'idem-fail' }));

    expect(response.ok).toBe(false);
    expect(response.denied?.stage).toBe('execute');
    const usage = await budgetStore.snapshot('default');
    expect(usage.budget_task?.reserved.model_cost_usd).toBeUndefined();
    expect(usage.budget_task?.cumulative.model_cost_usd).toBeUndefined();
  });

  it('creates a pending approval and skips execution when policy requires human approval', async () => {
    let calls = 0;
    const { gateway, token, approvalStore, approvalChannel } = await setupApprovalGate({
      async execute() {
        calls += 1;
        return { result: 'should-not-run', actual: { model_cost_usd: 1 } };
      },
    });

    const response = await gateway.handle(request(token, { idempotencyKey: 'idem-approval' }));

    expect(response.ok).toBe(false);
    expect(response.denied).toEqual({ stage: 'execute', reason: 'approval_required' });
    expect(response.approval?.status).toBe('pending');
    expect(response.approval?.reason).toBe('Sensitive browser action');
    expect(response.approval?.approvers).toEqual(['principal_reviewer']);
    expect(await approvalStore.listPending(RUN)).toEqual([response.approval]);
    expect(approvalChannel.sent).toEqual([response.approval]);
    expect(calls).toBe(0);
    expect(response.usage?.budget_task?.reserved.model_cost_usd).toBeUndefined();
    expect(response.usage?.budget_task?.cumulative.model_cost_usd).toBeUndefined();
    expect(response.decisionTrail.map((step) => step.stage)).toEqual([
      'authenticate',
      'authorize',
      'reserve',
      'execute',
    ]);
  });

  it('resumes an approved pending approval exactly once', async () => {
    let calls = 0;
    const { gateway, token, budgetStore } = await setupApprovalGate({
      async execute() {
        calls += 1;
        return { result: `approved-${calls}`, actual: { model_cost_usd: 0.5 } };
      },
    });
    const blocked = await gateway.handle(request(token, { idempotencyKey: 'idem-resume' }));

    const first = await gateway.resumeApproval({
      approvalId: blocked.approval?.id ?? '',
      resolvedBy: 'principal_reviewer',
      decision: 'approve',
      note: 'Reviewed',
    });
    const second = await gateway.resumeApproval({
      approvalId: blocked.approval?.id ?? '',
      resolvedBy: 'principal_reviewer',
      decision: 'approve',
      note: 'Reviewed again',
    });

    expect(first.ok).toBe(true);
    expect(first.result).toBe('approved-1');
    expect(first.approval?.status).toBe('approved');
    expect(second.result).toBe('approved-1');
    expect(calls).toBe(1);
    expect((await budgetStore.snapshot('default')).budget_task?.cumulative.model_cost_usd).toBe(
      0.5,
    );
  });

  it('records a denied approval without executing', async () => {
    let calls = 0;
    const { gateway, token, approvalStore } = await setupApprovalGate({
      async execute() {
        calls += 1;
        return { result: 'should-not-run', actual: { model_cost_usd: 1 } };
      },
    });
    const blocked = await gateway.handle(request(token, { idempotencyKey: 'idem-deny-approval' }));

    const response = await gateway.resumeApproval({
      approvalId: blocked.approval?.id ?? '',
      resolvedBy: 'principal_reviewer',
      decision: 'deny',
      note: 'No',
    });

    expect(response.ok).toBe(false);
    expect(response.denied).toEqual({ stage: 'execute', reason: 'approval_denied' });
    expect(response.approval?.status).toBe('denied');
    expect(await approvalStore.listPending(RUN)).toEqual([]);
    expect(calls).toBe(0);
  });

  it('dedupes repeated idempotency keys to one execution and spend', async () => {
    let calls = 0;
    const { gateway, token, budgetStore } = await setup({
      async execute() {
        calls += 1;
        return { result: calls, actual: { model_cost_usd: 1 } };
      },
    });

    const first = await gateway.handle(request(token));
    const second = await gateway.handle(request(token));

    expect(first.result).toBe(1);
    expect(second.result).toBe(1);
    expect(calls).toBe(1);
    expect((await budgetStore.snapshot('default')).budget_task?.cumulative.model_cost_usd).toBe(1);
  });
});

function echoExecutor(): Executor {
  return {
    async execute(payload: unknown) {
      const value = payload as { result: unknown; actual: Record<string, number> };
      return { result: value.result, actual: value.actual };
    },
  };
}
