import type { GraphStore } from '@axiongraph/core';
import type { BudgetStore, Reservation, Spend, SpendRequest } from '@delta-v/core';
import type { Narrowing } from '@grantz/core';
import type { Gateway, GatewayRequest } from '@missionctrl/core';

export interface MissionCtrlHttpSurfaceOptions {
  readonly gateway: Gateway;
  readonly graphStore?: GraphStore;
  readonly budgetStore?: BudgetStore;
  readonly budgetStackId?: string;
}

export interface MissionCtrlHttpSurface {
  handle(request: Request): Promise<Response>;
}

export function createMissionCtrlHttpSurface(
  options: MissionCtrlHttpSurfaceOptions,
): MissionCtrlHttpSurface {
  return new DefaultMissionCtrlHttpSurface(options);
}

class DefaultMissionCtrlHttpSurface implements MissionCtrlHttpSurface {
  constructor(private readonly options: MissionCtrlHttpSurfaceOptions) {}

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/actions') {
        const body = (await request.json()) as GatewayRequest;
        return json(await this.options.gateway.handle(body));
      }
      if (request.method === 'POST' && url.pathname === '/attenuate') {
        const body = (await request.json()) as {
          readonly parentToken?: string;
          readonly narrowing?: Narrowing;
        };
        if (body.parentToken === undefined || body.narrowing === undefined) {
          return json({ error: 'invalid_request' }, 400);
        }
        return json({
          token: await this.options.gateway.attenuate(body.parentToken, body.narrowing),
        });
      }
      if (request.method === 'GET' && url.pathname.startsWith('/runs/')) {
        return this.handleRunGraph(url.pathname);
      }
      if (request.method === 'POST' && url.pathname.startsWith('/budget/')) {
        return this.handleBudget(url.pathname, await request.json());
      }
      return json({ error: 'not_found' }, 404);
    } catch (error) {
      return json({ error: errorMessage(error) }, 500);
    }
  }

  private async handleRunGraph(pathname: string): Promise<Response> {
    const match = /^\/runs\/([^/]+)\/graph$/.exec(pathname);
    if (match === null) {
      return json({ error: 'not_found' }, 404);
    }
    if (this.options.graphStore === undefined) {
      return json({ error: 'graph_store_unavailable' }, 501);
    }
    const runId = decodeURIComponent(match[1] ?? '');
    return json(await this.options.graphStore.snapshot(runId));
  }

  private async handleBudget(pathname: string, body: unknown): Promise<Response> {
    if (this.options.budgetStore === undefined || this.options.budgetStackId === undefined) {
      return json({ error: 'budget_store_unavailable' }, 501);
    }
    const request = body as {
      readonly stackId?: string;
      readonly request?: SpendRequest;
      readonly reservation?: Reservation;
      readonly actual?: Spend;
    };
    const stackId = request.stackId ?? this.options.budgetStackId;
    if (pathname === '/budget/load') {
      return json(await this.options.budgetStore.load(stackId));
    }
    if (pathname === '/budget/try-reserve') {
      if (request.request === undefined) {
        return json({ error: 'invalid_request' }, 400);
      }
      return json(await this.options.budgetStore.tryReserve(stackId, request.request));
    }
    if (pathname === '/budget/settle') {
      if (request.reservation === undefined || request.actual === undefined) {
        return json({ error: 'invalid_request' }, 400);
      }
      await this.options.budgetStore.settle(stackId, request.reservation, request.actual);
      return json({ ok: true });
    }
    if (pathname === '/budget/release') {
      if (request.reservation === undefined) {
        return json({ error: 'invalid_request' }, 400);
      }
      await this.options.budgetStore.release(stackId, request.reservation);
      return json({ ok: true });
    }
    if (pathname === '/budget/snapshot') {
      return json(await this.options.budgetStore.snapshot(stackId));
    }
    return json({ error: 'not_found' }, 404);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'request_failed';
}
