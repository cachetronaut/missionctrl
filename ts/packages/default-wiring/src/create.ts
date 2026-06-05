import type { GraphStore } from '@axiongraph/core';
import { InMemoryStore } from '@axiongraph/store-local';
import type { Budget, BudgetStack, BudgetStore } from '@delta-v/core';
import { InMemoryBudgetStore } from '@delta-v/store-local';
import {
  Ed25519LocalSigner,
  Ed25519LocalVerifier,
  generateLocalKeyPair,
} from '@grantz/signer-local';
import { createGateway, type Gateway, type GatewayConfig } from '@missionctrl/core';
import { defaultDevPrincipal, devAuth } from './dev-auth.js';
import { echoExecutor } from './executors.js';
import { allowWithinToken } from './policy.js';

export interface MissionCtrlDefaults {
  readonly gateway: Gateway;
  readonly signer: Ed25519LocalSigner;
  readonly verifier: Ed25519LocalVerifier;
  readonly budgetStore: BudgetStore;
  readonly graphStore: GraphStore;
  readonly budgetStackId: string;
}

export function createMissionCtrl(
  overrides: Partial<GatewayConfig> & { budgetStack?: BudgetStack } = {},
): MissionCtrlDefaults {
  const keyPair = generateLocalKeyPair('missionctrl-local');
  const signer = new Ed25519LocalSigner(keyPair);
  const verifier = new Ed25519LocalVerifier([keyPair]);
  const budgetStackId = overrides.budgetStackId ?? 'default';
  const budgetStore =
    overrides.budgetStore ??
    new InMemoryBudgetStore({
      [budgetStackId]: {
        stack: overrides.budgetStack ?? [defaultBudget()],
      },
    });
  const graphStore = overrides.graphStore ?? new InMemoryStore();
  const config: GatewayConfig = {
    auth: overrides.auth ?? devAuth({ 'dev-credential': defaultDevPrincipal }),
    verifier: overrides.verifier ?? verifier,
    signer: overrides.signer ?? signer,
    budgetStore,
    graphStore,
    policy: overrides.policy ?? allowWithinToken(),
    executor: overrides.executor ?? echoExecutor(),
    budgetStackId,
    defaultRunTtlMs: overrides.defaultRunTtlMs,
    now: overrides.now,
  };
  return {
    gateway: createGateway(config),
    signer,
    verifier,
    budgetStore,
    graphStore,
    budgetStackId,
  };
}

function defaultBudget(): Budget {
  return {
    id: 'budget_local_task',
    layer: 'task',
    limits: {
      model_cost_usd: 10,
      tool_calls: 100,
    },
  };
}
