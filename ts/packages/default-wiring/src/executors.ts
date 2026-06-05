import type { Spend } from '@delta-v/core';
import type { Executor } from '@missionctrl/core';
import { inProcessConnector } from '@nvoke/registry-local';

export interface EchoPayload {
  readonly result?: unknown;
  readonly actual?: Spend;
}

export function echoExecutor(defaultActual: Spend = { model_cost_usd: 0 }): Executor {
  const connector = inProcessConnector({
    id: 'missionctrl_echo',
    requiredScope: { action: '*', resource: '*' },
    reversibility: 'read',
    estimate: () => ({ estimate: defaultActual }),
    execute: async (payload: unknown): Promise<{ result: unknown; actual: Spend }> => {
      const echo = isEchoPayload(payload) ? payload : {};
      return {
        result: echo.result ?? payload,
        actual: echo.actual ?? defaultActual,
      };
    },
  });
  return connector;
}

function isEchoPayload(value: unknown): value is EchoPayload {
  return value !== null && typeof value === 'object';
}
