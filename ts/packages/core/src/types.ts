import type {
  Approval,
  ApprovalChannel,
  ApprovalDecision,
  PendingStore,
} from '@approval-surface/core';
import type { GraphStore } from '@axiongraph/core';
import type { BudgetStore, Reservation, Spend, SpendRequest, UsageMap } from '@delta-v/core';
import type { AuthorizationRequest, Narrowing, Signer, TokenClaims, Verifier } from '@grantz/core';
import type { AuthAdapter, Principal } from '@plugg/core';

export type DecisionStage = 'authenticate' | 'authorize' | 'reserve' | 'execute' | 'settle';

export interface GatewayRequest {
  readonly credential: string;
  readonly token: string;
  readonly idempotencyKey?: string;
  readonly runTtlMs?: number;
  readonly action: {
    readonly scope: AuthorizationRequest['scope'];
    readonly context?: AuthorizationRequest['context'];
    readonly estimate: SpendRequest;
    readonly payload: unknown;
  };
}

export interface DecisionStep {
  readonly stage: DecisionStage;
  readonly ok: boolean;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface GatewayResponse {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly decisionTrail: readonly DecisionStep[];
  readonly usage?: UsageMap;
  readonly approval?: Approval;
  readonly denied?: { readonly stage: DecisionStage; readonly reason: string };
}

export interface ApprovalResolution {
  readonly approvalId: string;
  readonly resolvedBy: string;
  readonly decision: ApprovalDecision;
  readonly note?: string;
}

export interface PolicyInput {
  readonly principal: Principal;
  readonly claims: TokenClaims;
  readonly scope: AuthorizationRequest['scope'];
  readonly context?: AuthorizationRequest['context'];
  readonly estimate: SpendRequest;
}

export interface PolicyDecision {
  readonly allow: boolean;
  readonly reason: string;
  readonly obligations?: readonly {
    readonly kind: string;
    readonly detail?: Readonly<Record<string, unknown>>;
  }[];
}

export interface PolicyPort {
  decide(input: PolicyInput): Promise<PolicyDecision>;
}

export interface ExecuteContext {
  readonly principal: Principal;
  readonly claims: TokenClaims;
  readonly scope: AuthorizationRequest['scope'];
  readonly context?: AuthorizationRequest['context'];
}

export interface Executor {
  execute(payload: unknown, ctx: ExecuteContext): Promise<{ result: unknown; actual: Spend }>;
}

export interface GatewayConfig {
  readonly auth: AuthAdapter;
  readonly verifier: Verifier;
  readonly signer?: Signer;
  readonly budgetStore: BudgetStore;
  readonly graphStore: GraphStore;
  readonly policy: PolicyPort;
  readonly executor: Executor;
  readonly approvalStore?: PendingStore;
  readonly approvalChannel?: ApprovalChannel;
  readonly budgetStackId: string;
  readonly defaultRunTtlMs?: number;
  readonly now?: () => Date;
}

export interface Gateway {
  handle(request: GatewayRequest): Promise<GatewayResponse>;
  resumeApproval(resolution: ApprovalResolution): Promise<GatewayResponse>;
  attenuate(parentToken: string, narrowing: Narrowing): Promise<string>;
  reapExpiredRuns(): Promise<readonly string[]>;
}

export interface RunState {
  readonly runId: string;
  readonly expiresAtMs: number;
  status: 'active' | 'settled' | 'stalled';
  readonly reservations: Map<string, Reservation>;
}

export interface PendingApprovalState {
  readonly request: GatewayRequest;
  readonly principal: Principal;
  readonly claims: TokenClaims;
  readonly runId: string;
}
