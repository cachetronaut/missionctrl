import { InMemoryBudgetStore } from '@delta-v/store-local';
import { mint } from '@grantz/core';
import { describe, expect, it } from 'vitest';
import { createMissionCtrl } from '../../default-wiring/src/index.js';
import { createMissionCtrlHttpSurface } from '../src/index.js';

const NOW = new Date('2026-06-04T12:00:00.000Z');

describe('MissionCtrl HTTP surface', () => {
  it('maps POST /actions to the gateway pipeline', async () => {
    const wiring = createMissionCtrl({ now: () => NOW });
    const token = await tokenFor(wiring.signer);
    const surface = createMissionCtrlHttpSurface({
      gateway: wiring.gateway,
      graphStore: wiring.graphStore,
      budgetStore: wiring.budgetStore,
      budgetStackId: wiring.budgetStackId,
    });

    const response = await surface.handle(
      jsonRequest('/actions', {
        credential: 'dev-credential',
        token,
        action: {
          scope: { action: 'tool.call', resource: 'mcp://browser.open' },
          context: { runId: 'run_surface' },
          estimate: { runId: 'run_surface', estimate: { model_cost_usd: 1 } },
          payload: { result: 'surface-ok', actual: { model_cost_usd: 0.25 } },
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; result: unknown };
    expect(body.ok).toBe(true);
    expect(body.result).toBe('surface-ok');
  });

  it('maps POST /attenuate to mediated token attenuation', async () => {
    const wiring = createMissionCtrl({ now: () => NOW });
    const parentToken = await tokenFor(wiring.signer);
    const surface = createMissionCtrlHttpSurface({ gateway: wiring.gateway });

    const response = await surface.handle(
      jsonRequest('/attenuate', {
        parentToken,
        narrowing: {
          scopes: [{ action: 'tool.call', resource: 'mcp://browser.open' }],
          expiresAt: '2026-06-04T12:30:00.000Z',
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string };
    expect(body.token).toContain('.');
  });

  it('serves budget endpoints for remote stores', async () => {
    const budgetStore = new InMemoryBudgetStore({
      default: {
        stack: [{ id: 'budget_task', layer: 'task', limits: { model_cost_usd: 1 } }],
      },
    });
    const wiring = createMissionCtrl({ now: () => NOW, budgetStore, budgetStackId: 'default' });
    const surface = createMissionCtrlHttpSurface({
      gateway: wiring.gateway,
      budgetStore,
      budgetStackId: 'default',
    });

    const response = await surface.handle(
      jsonRequest('/budget/try-reserve', {
        request: { runId: 'run_budget', estimate: { model_cost_usd: 0.5 } },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; reservation?: { id: string } };
    expect(body.ok).toBe(true);
    expect(body.reservation?.id).toBeDefined();
  });
});

async function tokenFor(signer: Parameters<typeof mint>[1]): Promise<string> {
  return mint(
    {
      issuer: 'issuer_gateway',
      subject: 'principal_dev_agent',
      audience: 'gateway',
      scopes: [{ action: 'tool.call', resource: 'mcp://browser.open' }],
      binding: { runId: 'run_surface' },
      expiresAt: '2026-06-04T13:00:00.000Z',
    },
    signer,
    { now: NOW.toISOString(), id: 'jti_surface' },
  );
}

function jsonRequest(pathname: string, body: unknown): Request {
  return new Request(`https://missionctrl.test${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
