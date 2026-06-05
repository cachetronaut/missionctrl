import type { ApprovalSpec } from '@approval-surface/core';
import {
  expireIfDue,
  request as requestApproval,
  resolve as resolveApproval,
} from '@approval-surface/core';
import type { Reservation } from '@delta-v/core';
import { attenuate as attenuateToken, authorize, verify } from '@grantz/core';
import { GraphRecorder } from './graph.js';
import type {
  ApprovalResolution,
  DecisionStage,
  DecisionStep,
  Gateway,
  GatewayConfig,
  GatewayRequest,
  GatewayResponse,
  PendingApprovalState,
  RunState,
} from './types.js';

export function createGateway(config: GatewayConfig): Gateway {
  return new MissionCtrl(config);
}

class MissionCtrl implements Gateway {
  private readonly idempotency = new Map<string, Promise<GatewayResponse>>();
  private readonly pendingApprovals = new Map<string, PendingApprovalState>();
  private readonly resumedApprovals = new Map<string, Promise<GatewayResponse>>();
  private readonly runs = new Map<string, RunState>();
  private readonly recorder: GraphRecorder;

  constructor(private readonly config: GatewayConfig) {
    this.recorder = new GraphRecorder(config.graphStore);
  }

  async handle(request: GatewayRequest): Promise<GatewayResponse> {
    if (request.idempotencyKey !== undefined) {
      const existing = this.idempotency.get(request.idempotencyKey);
      if (existing !== undefined) {
        return existing;
      }
      const pending = this.handleOnce(request);
      this.idempotency.set(request.idempotencyKey, pending);
      return pending;
    }
    return this.handleOnce(request);
  }

  async resumeApproval(resolution: ApprovalResolution): Promise<GatewayResponse> {
    const existing = this.resumedApprovals.get(resolution.approvalId);
    if (existing !== undefined) {
      return existing;
    }
    const pending = this.resumeApprovalOnce(resolution);
    this.resumedApprovals.set(resolution.approvalId, pending);
    return pending;
  }

  async attenuate(
    parentToken: string,
    narrowing: Parameters<Gateway['attenuate']>[1],
  ): Promise<string> {
    if (this.config.signer === undefined) {
      throw new Error('Gateway signer is required to attenuate tokens');
    }
    return attenuateToken(parentToken, narrowing, this.config.signer, this.config.verifier, {
      now: this.now().toISOString(),
    });
  }

  async reapExpiredRuns(): Promise<readonly string[]> {
    const nowMs = this.now().getTime();
    const expired: string[] = [];
    for (const run of this.runs.values()) {
      if (run.status !== 'active' || run.expiresAtMs > nowMs) {
        continue;
      }
      run.status = 'stalled';
      for (const reservation of run.reservations.values()) {
        await this.config.budgetStore.release(this.config.budgetStackId, reservation);
      }
      run.reservations.clear();
      await this.recorder.recordResult(run.runId, 'failed');
      expired.push(run.runId);
    }
    return expired;
  }

  private async handleOnce(request: GatewayRequest): Promise<GatewayResponse> {
    const runId = request.action.context?.runId ?? request.action.estimate.runId ?? 'run_default';
    const run = this.ensureRun(runId, request.runTtlMs);
    const trail: DecisionStep[] = [];
    let reservation: Reservation | undefined;

    const addStep = async (
      stage: DecisionStage,
      ok: boolean,
      detail: Readonly<Record<string, unknown>>,
    ): Promise<void> => {
      const step = { stage, ok, detail };
      trail.push(step);
      await this.recorder.recordStep(runId, step);
    };

    try {
      const principal = await this.config.auth.resolve(request.credential);
      await addStep('authenticate', true, { principalId: principal.id, kind: principal.kind });

      const verified = await verify(request.token, this.config.verifier, {
        now: this.now().toISOString(),
      });
      if (!verified.ok) {
        await addStep('authorize', false, { reason: verified.code });
        await this.recorder.recordResult(runId, 'blocked');
        return deny('authorize', verified.code, trail);
      }

      const tokenDecision = authorize(verified.claims, {
        scope: request.action.scope,
        context: request.action.context,
      });
      if (!tokenDecision.ok) {
        await addStep('authorize', false, { reason: tokenDecision.reason });
        await this.recorder.recordResult(runId, 'blocked');
        return deny('authorize', tokenDecision.reason, trail);
      }

      const policyDecision = await this.config.policy.decide({
        principal,
        claims: verified.claims,
        scope: request.action.scope,
        context: request.action.context,
        estimate: request.action.estimate,
      });
      if (!policyDecision.allow) {
        await addStep('authorize', false, {
          reason: policyDecision.reason,
          obligations: policyDecision.obligations ?? [],
        });
        await this.recorder.recordResult(runId, 'blocked');
        return deny('authorize', policyDecision.reason, trail);
      }
      await addStep('authorize', true, { constraints: tokenDecision.constraints });

      const reserveDecision = await this.config.budgetStore.tryReserve(
        this.config.budgetStackId,
        request.action.estimate,
      );
      if (!reserveDecision.ok) {
        await addStep('reserve', false, { breach: reserveDecision.breach });
        await this.recorder.recordResult(runId, 'blocked');
        return {
          ...deny('reserve', 'budget_breach', trail),
          usage: await this.config.budgetStore.snapshot(this.config.budgetStackId),
        };
      }
      reservation = reserveDecision.reservation;
      run.reservations.set(reservation.id, reservation);
      await addStep('reserve', true, { reservationId: reservation.id });

      const approvalObligation = findApprovalObligation(policyDecision.obligations);
      if (approvalObligation !== undefined) {
        if (this.config.approvalStore === undefined) {
          await this.config.budgetStore.release(this.config.budgetStackId, reservation);
          run.reservations.delete(reservation.id);
          run.status = 'settled';
          await addStep('execute', false, { reason: 'approval_surface_unavailable' });
          await this.recorder.recordResult(runId, 'blocked');
          return {
            ...deny('execute', 'approval_surface_unavailable', trail),
            usage: await this.config.budgetStore.snapshot(this.config.budgetStackId),
          };
        }

        const approval = requestApproval(
          approvalSpecFromObligation({
            obligation: approvalObligation,
            request,
            principalId: principal.id,
            runId,
            expiresAt: new Date(run.expiresAtMs).toISOString(),
          }),
        );
        await this.config.approvalStore.put(approval);
        await this.config.approvalChannel?.notify(approval);
        this.pendingApprovals.set(approval.id, {
          request,
          principal,
          claims: verified.claims,
          runId,
        });
        await this.config.budgetStore.release(this.config.budgetStackId, reservation);
        run.reservations.delete(reservation.id);
        run.status = 'settled';
        await addStep('execute', false, { reason: 'approval_required', approvalId: approval.id });
        await this.recorder.recordResult(runId, 'blocked');
        return {
          ...deny('execute', 'approval_required', trail),
          approval,
          usage: await this.config.budgetStore.snapshot(this.config.budgetStackId),
        };
      }

      const executed = await this.config.executor.execute(request.action.payload, {
        principal,
        claims: verified.claims,
        scope: request.action.scope,
        context: request.action.context,
      });
      await addStep('execute', true, { actual: executed.actual });

      await this.config.budgetStore.settle(this.config.budgetStackId, reservation, executed.actual);
      run.reservations.delete(reservation.id);
      run.status = 'settled';
      const usage = await this.config.budgetStore.snapshot(this.config.budgetStackId);
      await addStep('settle', true, { reservationId: reservation.id });
      await this.recorder.recordResult(runId, 'completed');
      return { ok: true, result: executed.result, decisionTrail: trail, usage };
    } catch (error) {
      if (reservation !== undefined) {
        await this.config.budgetStore.release(this.config.budgetStackId, reservation);
        run.reservations.delete(reservation.id);
      }
      run.status = 'settled';
      await addStep('execute', false, { reason: errorMessage(error) });
      await this.recorder.recordResult(runId, 'failed');
      return {
        ...deny('execute', errorMessage(error), trail),
        usage: await this.config.budgetStore.snapshot(this.config.budgetStackId),
      };
    }
  }

  private async resumeApprovalOnce(resolution: ApprovalResolution): Promise<GatewayResponse> {
    if (this.config.approvalStore === undefined) {
      return deny('execute', 'approval_surface_unavailable', []);
    }

    const stored = await this.config.approvalStore.get(resolution.approvalId);
    if (stored === undefined) {
      return deny('execute', 'approval_not_found', []);
    }

    const now = this.now().toISOString();
    const unexpired = expireIfDue(stored, now);
    if (unexpired.status === 'expired') {
      await this.config.approvalStore.put(unexpired);
      this.pendingApprovals.delete(resolution.approvalId);
      return { ...deny('execute', 'approval_expired', []), approval: unexpired };
    }

    const approval = resolveApproval(
      unexpired,
      resolution.resolvedBy,
      resolution.decision,
      now,
      resolution.note,
    );
    await this.config.approvalStore.put(approval);

    const pending = this.pendingApprovals.get(resolution.approvalId);
    if (approval.status !== 'approved') {
      if (pending !== undefined) {
        await this.recorder.recordResult(pending.runId, 'blocked');
      }
      this.pendingApprovals.delete(resolution.approvalId);
      return { ...deny('execute', 'approval_denied', []), approval };
    }
    if (pending === undefined) {
      return { ...deny('execute', 'approval_state_missing', []), approval };
    }

    const run = this.ensureRun(pending.runId, pending.request.runTtlMs);
    const trail: DecisionStep[] = [];
    let reservation: Reservation | undefined;
    const addStep = async (
      stage: DecisionStage,
      ok: boolean,
      detail: Readonly<Record<string, unknown>>,
    ): Promise<void> => {
      const step = { stage, ok, detail };
      trail.push(step);
      await this.recorder.recordStep(pending.runId, step);
    };

    try {
      const reserveDecision = await this.config.budgetStore.tryReserve(
        this.config.budgetStackId,
        pending.request.action.estimate,
      );
      if (!reserveDecision.ok) {
        await addStep('reserve', false, { breach: reserveDecision.breach });
        await this.recorder.recordResult(pending.runId, 'blocked');
        return {
          ...deny('reserve', 'budget_breach', trail),
          approval,
          usage: await this.config.budgetStore.snapshot(this.config.budgetStackId),
        };
      }

      reservation = reserveDecision.reservation;
      run.reservations.set(reservation.id, reservation);
      await addStep('reserve', true, { reservationId: reservation.id, approvalId: approval.id });

      const executed = await this.config.executor.execute(pending.request.action.payload, {
        principal: pending.principal,
        claims: pending.claims,
        scope: pending.request.action.scope,
        context: pending.request.action.context,
      });
      await addStep('execute', true, { actual: executed.actual, approvalId: approval.id });

      await this.config.budgetStore.settle(this.config.budgetStackId, reservation, executed.actual);
      run.reservations.delete(reservation.id);
      run.status = 'settled';
      this.pendingApprovals.delete(resolution.approvalId);
      const usage = await this.config.budgetStore.snapshot(this.config.budgetStackId);
      await addStep('settle', true, { reservationId: reservation.id });
      await this.recorder.recordResult(pending.runId, 'completed');
      return { ok: true, result: executed.result, decisionTrail: trail, usage, approval };
    } catch (error) {
      if (reservation !== undefined) {
        await this.config.budgetStore.release(this.config.budgetStackId, reservation);
        run.reservations.delete(reservation.id);
      }
      run.status = 'settled';
      await addStep('execute', false, { reason: errorMessage(error), approvalId: approval.id });
      await this.recorder.recordResult(pending.runId, 'failed');
      return {
        ...deny('execute', errorMessage(error), trail),
        approval,
        usage: await this.config.budgetStore.snapshot(this.config.budgetStackId),
      };
    }
  }

  private ensureRun(runId: string, ttlMs: number | undefined): RunState {
    const existing = this.runs.get(runId);
    if (existing !== undefined) {
      return existing;
    }
    const run: RunState = {
      runId,
      expiresAtMs: this.now().getTime() + (ttlMs ?? this.config.defaultRunTtlMs ?? 60_000),
      status: 'active',
      reservations: new Map(),
    };
    this.runs.set(runId, run);
    return run;
  }

  private now(): Date {
    return this.config.now?.() ?? new Date();
  }
}

function deny(
  stage: DecisionStage,
  reason: string,
  trail: readonly DecisionStep[],
): GatewayResponse {
  return {
    ok: false,
    decisionTrail: trail,
    denied: { stage, reason },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Execution failed';
}

type ApprovalObligation = {
  readonly kind: string;
  readonly detail?: Readonly<Record<string, unknown>>;
};

function findApprovalObligation(
  obligations: readonly ApprovalObligation[] | undefined,
): ApprovalObligation | undefined {
  return obligations?.find((obligation) => obligation.kind === 'require_human_approval');
}

function approvalSpecFromObligation(input: {
  readonly obligation: ApprovalObligation;
  readonly request: GatewayRequest;
  readonly principalId: string;
  readonly runId: string;
  readonly expiresAt: string;
}): ApprovalSpec {
  const detail = input.obligation.detail ?? {};
  const scope = input.request.action.scope;
  return {
    runId: input.runId,
    taskId: stringDetail(detail.taskId),
    action: {
      scope: {
        action: scope.action,
        resource: scope.resource,
        qualifier: scope.qualifier,
      },
      summary: stringDetail(detail.summary) ?? `${scope.action} ${scope.resource}`,
    },
    requestedBy: input.principalId,
    approvers: stringArrayDetail(detail.approvers),
    reason: stringDetail(detail.reason) ?? 'Human approval is required',
    expiresAt: stringDetail(detail.expiresAt) ?? input.expiresAt,
  };
}

function stringDetail(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArrayDetail(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  return value.every((item) => typeof item === 'string') ? value : undefined;
}
