import type { Project } from '../models';
import type {
  ProjectConflictLocalHandoff,
  ProjectConflictLocalHandoffState,
  ProjectPayload,
  QueuedAction,
} from './action-queue.types';
import type {
  LocalHandoffIdentity,
  LocalHandoffQueueMutationResult,
  LocalHandoffTransitionInput,
} from './action-queue-held-action.controller';
import {
  createProjectConflictRecordFingerprint,
  type AdvanceProjectConflictLocalHandoffInput,
  type PersistProjectConflictLocalHandoffRequirementInput,
  type ProjectConflictLocalHandoffMutationResult,
  type ProjectConflictLocalHandoffReservationResult,
  type ReserveProjectConflictLocalHandoffInput,
  type VerifyProjectConflictLocalHandoffInput,
} from './conflict-storage.helpers';
import { applyPendingProjectActionsToSnapshot } from './user-session-pending-project-actions.helpers';
import { createDerivedSyncOperationId } from '../utils/sync-operation-id';

export interface ProjectConflictRetrySettlementInput extends LocalHandoffIdentity {
  sessionGeneration: number;
  authFence: string;
  resolvedProject: Project;
}

export type ProjectConflictRetrySettlementResult = 'complete' | 'retry' | 'stale';

export function createProjectConflictHandoffReservationId(
  operationId: string,
  payloadDigest: string,
  conflictFingerprint: string,
): string {
  return createDerivedSyncOperationId(
    operationId,
    `project-conflict-handoff:${payloadDigest}:${conflictFingerprint}`,
  );
}

export function createProjectConflictHandoffPayloadDigest(payload: ProjectPayload): string {
  return stableStringify(payload);
}

export function isCanonicalProjectConflictHandoffAction(
  action: QueuedAction,
  ownerUserId: string,
): boolean {
  const candidate = resolveProjectConflictHandoffCandidate(action, ownerUserId);
  return candidate !== null
    && candidate.handoff.state !== 'required'
    && candidate.handoff.reservationId === candidate.reservationId;
}

interface ProjectConflictHandoffCandidate {
  action: QueuedAction<ProjectPayload>;
  payload: ProjectPayload;
  handoff: ProjectConflictLocalHandoff;
  conflictRecord: NonNullable<ProjectPayload['conflictHandoff']>['conflictRecord'];
  reservationId: string;
}

function resolveProjectConflictHandoffCandidate(
  action: QueuedAction,
  ownerUserId: string,
): ProjectConflictHandoffCandidate | null {
  const payload = action.payload as ProjectPayload | undefined;
  const project = payload?.project;
  const handoff = action.localHandoff;
  const conflictRecord = payload?.conflictHandoff?.conflictRecord;
  if (!project || !payload || !handoff || !conflictRecord) return null;
  const reservationId = createProjectConflictHandoffReservationId(
    action.operationId, handoff.payloadDigest, handoff.conflictFingerprint,
  );
  const baseIdentityMatches = action.type === 'update' && action.entityType === 'project'
    && action.entityId === project.id && payload.sourceUserId === ownerUserId
    && handoff.kind === 'resolved-project-conflict' && handoff.ownerUserId === ownerUserId
    && handoff.projectId === action.entityId && handoff.actionId === action.id
    && handoff.operationId === action.operationId
    && conflictRecord.ownerUserId === ownerUserId && conflictRecord.projectId === action.entityId
    && handoff.payloadDigest === createProjectConflictHandoffPayloadDigest(payload)
    && handoff.conflictFingerprint === createProjectConflictRecordFingerprint(conflictRecord);
  return baseIdentityMatches
    ? { action: action as QueuedAction<ProjectPayload>, payload, handoff, conflictRecord, reservationId }
    : null;
}

export interface ProjectConflictRetrySettlementOptions {
  isFenceCurrent: (input: ProjectConflictRetrySettlementInput) => boolean;
  reserveConflictLocalHandoff: (
    input: ReserveProjectConflictLocalHandoffInput,
  ) => Promise<ProjectConflictLocalHandoffReservationResult>;
  transitionActionLocalHandoff: (
    input: LocalHandoffTransitionInput,
  ) => Promise<LocalHandoffQueueMutationResult>;
  verifyConflictReservation: (
    input: VerifyProjectConflictLocalHandoffInput,
  ) => Promise<ProjectConflictLocalHandoffMutationResult>;
  advanceConflictLocalHandoff: (
    input: AdvanceProjectConflictLocalHandoffInput,
  ) => Promise<ProjectConflictLocalHandoffMutationResult>;
  persistOwnerSnapshot: (input: ProjectConflictRetrySettlementInput) => Promise<boolean>;
  publishResolvedProject: (input: ProjectConflictRetrySettlementInput) => void;
  clearCompletedConflict: (input: ProjectConflictRetrySettlementInput) => Promise<boolean>;
  removeCompletedAction: (input: LocalHandoffIdentity) => Promise<LocalHandoffQueueMutationResult>;
  now: () => string;
}

export class ProjectOperationConflictRetrySettlementController {
  constructor(private readonly options: ProjectConflictRetrySettlementOptions) {}

  async settle(
    input: ProjectConflictRetrySettlementInput,
  ): Promise<ProjectConflictRetrySettlementResult> {
    if (!this.options.isFenceCurrent(input)) return 'stale';
    const reservation = await this.options.reserveConflictLocalHandoff({
      ...this.identity(input),
      reservationId: input.reservationId,
      reservedAt: this.options.now(),
    });
    if (!this.options.isFenceCurrent(input)) return 'stale';
    if (reservation.status !== 'committed') {
      if (reservation.status !== 'missing') return 'retry';
      const removed = await this.options.removeCompletedAction(this.identity(input));
      if (!this.options.isFenceCurrent(input)) return 'stale';
      return removed.status === 'committed' ? 'complete' : 'retry';
    }
    if (reservation.reservationId !== input.reservationId) {
      return 'retry';
    }

    const reservedAction = await this.transitionAction(input, 'required', 'reserved');
    if (!this.options.isFenceCurrent(input)) return 'stale';
    if (reservedAction.status !== 'committed' || !reservedAction.action) return 'retry';
    let state = reservedAction.action.localHandoff?.state;
    if (state === 'reserved') {
      const prepared = await this.prepareAndPublish(input);
      if (prepared !== 'complete') return prepared;
      if (!this.options.isFenceCurrent(input)) return 'stale';
      const effectsApplied = await this.transitionAction(input, 'reserved', 'effects-applied');
      if (!this.options.isFenceCurrent(input)) return 'stale';
      if (effectsApplied.status !== 'committed' || !effectsApplied.action) return 'retry';
      state = effectsApplied.action.localHandoff?.state;
    }

    if (state === 'effects-applied') {
      const conflictCompleted = await this.completeConflictReservation(input);
      if (conflictCompleted !== 'complete') return conflictCompleted;
      if (!this.options.isFenceCurrent(input)) return 'stale';
      const completedAction = await this.transitionAction(input, 'effects-applied', 'complete');
      if (!this.options.isFenceCurrent(input)) return 'stale';
      if (completedAction.status !== 'committed') return 'retry';
      const cleared = await this.options.clearCompletedConflict(input);
      if (!this.options.isFenceCurrent(input)) return 'stale';
      if (!cleared) return 'retry';
      state = 'complete';
    }

    if (state !== 'complete') return 'retry';
    const removed = await this.options.removeCompletedAction(this.identity(input));
    if (!this.options.isFenceCurrent(input)) return 'stale';
    return removed.status === 'committed' ? 'complete' : 'retry';
  }

  private async prepareAndPublish(
    input: ProjectConflictRetrySettlementInput,
  ): Promise<ProjectConflictRetrySettlementResult> {
    const verified = await this.options.verifyConflictReservation({
      ...this.identity(input),
      reservationId: input.reservationId,
    });
    if (!this.options.isFenceCurrent(input)) return 'stale';
    if (verified.status !== 'committed') return 'retry';
    const persisted = await this.options.persistOwnerSnapshot(input);
    if (!this.options.isFenceCurrent(input)) return 'stale';
    if (!persisted) return 'retry';
    const reverified = await this.options.verifyConflictReservation({
      ...this.identity(input),
      reservationId: input.reservationId,
    });
    if (!this.options.isFenceCurrent(input)) return 'stale';
    if (reverified.status !== 'committed') return 'retry';
    this.options.publishResolvedProject(input);
    return 'complete';
  }

  private async completeConflictReservation(
    input: ProjectConflictRetrySettlementInput,
  ): Promise<ProjectConflictRetrySettlementResult> {
    for (const transition of [
      ['reserved', 'effects-applied'],
      ['effects-applied', 'complete'],
    ] as const) {
      const result = await this.options.advanceConflictLocalHandoff({
        ...this.identity(input),
        reservationId: input.reservationId,
        expectedState: transition[0],
        nextState: transition[1],
        transitionedAt: this.options.now(),
      });
      if (!this.options.isFenceCurrent(input)) return 'stale';
      if (result.status !== 'committed') return 'retry';
    }
    return 'complete';
  }

  private transitionAction(
    input: ProjectConflictRetrySettlementInput,
    expectedState: ProjectConflictLocalHandoffState,
    nextState: ProjectConflictLocalHandoffState,
  ): Promise<LocalHandoffQueueMutationResult> {
    return this.options.transitionActionLocalHandoff({
      ...this.identity(input),
      expectedState,
      nextState,
      transitionedAt: this.options.now(),
    });
  }

  private identity(input: ProjectConflictRetrySettlementInput): LocalHandoffIdentity {
    const {
      ownerUserId, projectId, actionId, operationId,
      payloadDigest, conflictFingerprint, reservationId,
    } = input;
    return {
      ownerUserId, projectId, actionId, operationId,
      payloadDigest, conflictFingerprint, reservationId,
    };
  }
}

export interface ProjectConflictHandoffSettlementDeps {
  isFenceCurrent: (input: ProjectConflictRetrySettlementInput) => boolean;
  getCurrentProjects: () => Project[];
  getPendingProjectActions: (projectId: string) => QueuedAction[];
  persistProjects: (projects: Project[]) => Promise<void>;
  publishProjects: (projects: Project[]) => void;
  reserveConflictLocalHandoff: ProjectConflictRetrySettlementOptions['reserveConflictLocalHandoff'];
  transitionActionLocalHandoff: ProjectConflictRetrySettlementOptions['transitionActionLocalHandoff'];
  verifyConflictReservation: ProjectConflictRetrySettlementOptions['verifyConflictReservation'];
  advanceConflictLocalHandoff: ProjectConflictRetrySettlementOptions['advanceConflictLocalHandoff'];
  clearCompletedConflict: (input: VerifyProjectConflictLocalHandoffInput) => Promise<ProjectConflictLocalHandoffMutationResult>;
  removeCompletedAction: ProjectConflictRetrySettlementOptions['removeCompletedAction'];
  now: () => string;
}

export type ProjectConflictHandoffSettlement = (
  input: ProjectConflictRetrySettlementInput,
  additionalFence?: () => boolean,
) => Promise<ProjectConflictRetrySettlementResult>;

export function createProjectConflictHandoffSettlement(
  deps: ProjectConflictHandoffSettlementDeps,
): ProjectConflictHandoffSettlement {
  return async (input, additionalFence = () => true) => {
    const isCurrent = (): boolean => additionalFence() && deps.isFenceCurrent(input);
    const buildProjects = (): Project[] => {
      const current = deps.getCurrentProjects();
      const hasProject = current.some(project => project.id === input.projectId);
      const base = hasProject
        ? current.map(project => project.id === input.projectId ? input.resolvedProject : project)
        : [...current, input.resolvedProject];
      return applyPendingProjectActionsToSnapshot(
        base, deps.getPendingProjectActions(input.projectId),
      ).projects;
    };
    const controller = new ProjectOperationConflictRetrySettlementController({
      isFenceCurrent: isCurrent,
      reserveConflictLocalHandoff: deps.reserveConflictLocalHandoff,
      transitionActionLocalHandoff: deps.transitionActionLocalHandoff,
      verifyConflictReservation: deps.verifyConflictReservation,
      advanceConflictLocalHandoff: deps.advanceConflictLocalHandoff,
      persistOwnerSnapshot: async () => {
        try {
          await deps.persistProjects(buildProjects());
          return true;
        } catch {
          return false;
        }
      },
      publishResolvedProject: () => deps.publishProjects(buildProjects()),
      clearCompletedConflict: async () => (await deps.clearCompletedConflict(input)).status === 'committed',
      removeCompletedAction: deps.removeCompletedAction,
      now: deps.now,
    });
    return controller.settle(input);
  };
}

export interface ActionQueueProjectConflictHandoffInput {
  action: QueuedAction;
  resolvedProject: Project;
  ownerUserId: string;
  sessionGeneration: number;
  authFence: string;
  queueViewGeneration: number;
  projectMutationViewGeneration: number;
}

export interface ActionQueueProjectConflictHandoffDeps {
  isFenceCurrent: (input: ActionQueueProjectConflictHandoffInput) => boolean;
  getCurrentProjects: () => Project[];
  getPendingProjectActions: (projectId: string) => QueuedAction[];
  persistProjects: (projects: Project[]) => Promise<void>;
  publishProjects: (projects: Project[]) => void;
  reserveConflictLocalHandoff: ProjectConflictRetrySettlementOptions['reserveConflictLocalHandoff'];
  transitionActionLocalHandoff: ProjectConflictRetrySettlementOptions['transitionActionLocalHandoff'];
  verifyConflictReservation: ProjectConflictRetrySettlementOptions['verifyConflictReservation'];
  advanceConflictLocalHandoff: ProjectConflictRetrySettlementOptions['advanceConflictLocalHandoff'];
  clearCompletedConflict: (input: VerifyProjectConflictLocalHandoffInput) => Promise<ProjectConflictLocalHandoffMutationResult>;
  removeCompletedAction: ProjectConflictRetrySettlementOptions['removeCompletedAction'];
  now: () => string;
}

export function createActionQueueProjectConflictHandoffSettlement(
  deps: ActionQueueProjectConflictHandoffDeps,
): (
  input: ActionQueueProjectConflictHandoffInput,
  additionalFence?: () => boolean,
) => Promise<ProjectConflictRetrySettlementResult> {
  return async (input, additionalFence = () => true) => {
    const handoff = input.action.localHandoff;
    if (!handoff) return 'retry';
    const reservationId = handoff.reservationId ?? createProjectConflictHandoffReservationId(
      input.action.operationId, handoff.payloadDigest, handoff.conflictFingerprint,
    );
    const settlementInput: ProjectConflictRetrySettlementInput = {
      ownerUserId: input.ownerUserId,
      sessionGeneration: input.sessionGeneration,
      authFence: input.authFence,
      projectId: input.resolvedProject.id,
      actionId: input.action.id,
      operationId: input.action.operationId,
      payloadDigest: handoff.payloadDigest,
      conflictFingerprint: handoff.conflictFingerprint,
      reservationId,
      resolvedProject: input.resolvedProject,
    };
    const identity = {
      ownerUserId: settlementInput.ownerUserId,
      projectId: settlementInput.projectId,
      actionId: settlementInput.actionId,
      operationId: settlementInput.operationId,
      payloadDigest: settlementInput.payloadDigest,
      conflictFingerprint: settlementInput.conflictFingerprint,
      reservationId,
    };
    const buildProjects = (): Project[] => {
      const current = deps.getCurrentProjects();
      const hasProject = current.some(project => project.id === input.resolvedProject.id);
      const base = hasProject
        ? current.map(project => project.id === input.resolvedProject.id ? input.resolvedProject : project)
        : [...current, input.resolvedProject];
      return applyPendingProjectActionsToSnapshot(
        base,
        deps.getPendingProjectActions(input.resolvedProject.id),
      ).projects;
    };
    const controller = new ProjectOperationConflictRetrySettlementController({
      isFenceCurrent: () => additionalFence() && deps.isFenceCurrent(input),
      reserveConflictLocalHandoff: deps.reserveConflictLocalHandoff,
      transitionActionLocalHandoff: deps.transitionActionLocalHandoff,
      verifyConflictReservation: deps.verifyConflictReservation,
      advanceConflictLocalHandoff: deps.advanceConflictLocalHandoff,
      persistOwnerSnapshot: async () => {
        try {
          await deps.persistProjects(buildProjects());
          return true;
        } catch {
          return false;
        }
      },
      publishResolvedProject: () => deps.publishProjects(buildProjects()),
      clearCompletedConflict: async () =>
        (await deps.clearCompletedConflict(identity)).status === 'committed',
      removeCompletedAction: deps.removeCompletedAction,
      now: deps.now,
    });
    return controller.settle(settlementInput);
  };
}

export async function runActivatedProjectHandoff<T>(input: {
  leaseSignal?: AbortSignal;
  action?: QueuedAction;
  ownerUserId?: string;
  execute: (signal: AbortSignal) => Promise<{ status: string } | null>;
  settle: (additionalFence: () => boolean) => Promise<ProjectConflictRetrySettlementResult>;
  complete: () => T;
  defer: (outcome: string) => T;
}): Promise<T> {
  const signal = input.leaseSignal;
  let outcome = 'missing-lease';
  if (signal && !signal.aborted) {
    try {
      const terminal = input.action?.localHandoff?.state === 'complete';
      const canonicalTerminal = terminal
        && input.action?.syncState === 'pending_sync'
        && typeof input.ownerUserId === 'string'
        && isCanonicalProjectConflictHandoffAction(input.action, input.ownerUserId);
      const result = terminal
        ? canonicalTerminal ? { status: 'applied' } : null
        : await input.execute(signal);
      outcome = result?.status ?? 'unavailable';
      if (result?.status === 'applied') {
        const settled = await input.settle(() => !signal.aborted);
        if (settled === 'complete') return input.complete();
        outcome = settled;
      }
    } catch {
      outcome = 'failed';
    }
  }
  return input.defer(outcome);
}

export interface ActionQueueProjectConflictHandoffRecoveryDeps {
  isOwnerStorageLoaded: () => boolean;
  getCurrentOwnerUserId: () => string | null;
  getSessionGeneration: () => number;
  captureAuthFence: () => string;
  getQueueViewGeneration: () => number;
  isSessionContextCurrent: (generation: number, ownerUserId: string) => boolean;
  isQueueViewCurrent: (generation: number, ownerUserId: string) => boolean;
  getPendingActions: () => QueuedAction[];
  acquireLease: (ownerUserId: string) => Promise<{
    mode: string;
    signal?: AbortSignal;
    release(): Promise<void>;
  } | null>;
  persistRequirement: (
    input: PersistProjectConflictLocalHandoffRequirementInput,
  ) => Promise<ProjectConflictLocalHandoffMutationResult>;
  reserveConflictHandoff: (
    input: ReserveProjectConflictLocalHandoffInput,
  ) => Promise<ProjectConflictLocalHandoffReservationResult>;
  verifyConflictReservation: (
    input: VerifyProjectConflictLocalHandoffInput,
  ) => Promise<ProjectConflictLocalHandoffMutationResult>;
  transitionActionHandoff: (
    input: LocalHandoffTransitionInput,
  ) => Promise<LocalHandoffQueueMutationResult>;
  activateHandoff: (input: LocalHandoffIdentity) => Promise<LocalHandoffQueueMutationResult>;
  processQueue: () => Promise<unknown>;
  scheduleRetry: (callback: () => void, delayMs: number) => unknown;
  clearRetry: (handle: unknown) => void;
  now: () => string;
}

export class ActionQueueProjectConflictHandoffRecoveryController {
  private static readonly RETRY_DELAY_MS = 1_000;
  private requested = false;
  private flight: Promise<void> | null = null;
  private retryHandle: unknown | null = null;
  private generation = 0;
  private destroyed = false;

  constructor(private readonly deps: ActionQueueProjectConflictHandoffRecoveryDeps) {}

  request(): void {
    if (this.destroyed) return;
    this.cancelRetry();
    this.requested = true;
    if (this.flight) return;
    const flight = this.runLoop().finally(() => {
      if (this.flight === flight) this.flight = null;
      if (this.requested) this.request();
    });
    this.flight = flight;
  }

  destroy(): void {
    this.destroyed = true;
    this.generation += 1;
    this.requested = false;
    this.cancelRetry();
  }

  private async runLoop(): Promise<void> {
    do {
      this.requested = false;
      await this.recoverCurrentOwner();
    } while (this.requested);
  }

  private async recoverCurrentOwner(): Promise<void> {
    if (!this.deps.isOwnerStorageLoaded()) return;
    const ownerUserId = this.deps.getCurrentOwnerUserId();
    if (!ownerUserId) return;
    const sessionGeneration = this.deps.getSessionGeneration();
    const authFence = this.deps.captureAuthFence();
    const queueViewGeneration = this.deps.getQueueViewGeneration();
    const recoveryGeneration = this.generation;
    const isIdentityCurrent = (): boolean => !this.destroyed
      && recoveryGeneration === this.generation
      && this.deps.getCurrentOwnerUserId() === ownerUserId
      && this.deps.captureAuthFence() === authFence
      && this.deps.isSessionContextCurrent(sessionGeneration, ownerUserId)
      && this.deps.isQueueViewCurrent(queueViewGeneration, ownerUserId);
    let lease: Awaited<ReturnType<ActionQueueProjectConflictHandoffRecoveryDeps['acquireLease']>>;
    try {
      lease = await this.deps.acquireLease(ownerUserId);
    } catch {
      if (isIdentityCurrent()) this.scheduleRetry();
      return;
    }
    if (!isIdentityCurrent()) {
      await this.releaseLease(lease);
      return;
    }
    if (!lease || lease.mode === 'memory-only' || !lease.signal) {
      await this.releaseLease(lease);
      if (isIdentityCurrent()) this.scheduleRetry();
      return;
    }
    const isCurrent = (): boolean => isIdentityCurrent() && !lease.signal!.aborted;
    let shouldProcess = false;
    let retry = false;
    let stale = false;

    for (const action of this.deps.getPendingActions()) {
      if (!isCurrent()) { stale = true; break; }
      const candidate = resolveProjectConflictHandoffCandidate(action, ownerUserId);
      if (!candidate) continue;
      const result = await this.recoverAction(candidate, isCurrent);
      if (result === 'stale') { stale = true; break; }
      if (result === 'retry') { retry = true; break; }
      shouldProcess ||= result === 'process';
    }
    const released = await this.releaseLease(lease);
    if (stale || !isIdentityCurrent()) return;
    if (retry || !released) {
      this.scheduleRetry();
      return;
    }
    if (!shouldProcess) return;
    try {
      if (isIdentityCurrent()) await this.deps.processQueue();
    } catch {
      if (isIdentityCurrent()) this.scheduleRetry();
    }
  }

  private async recoverAction(
    candidate: ProjectConflictHandoffCandidate,
    isCurrent: () => boolean,
  ): Promise<'blocked' | 'process' | 'retry' | 'stale'> {
    const { action, handoff, conflictRecord, reservationId } = candidate;
    const identity: LocalHandoffIdentity = {
      ownerUserId: handoff.ownerUserId, projectId: handoff.projectId,
      actionId: action.id, operationId: action.operationId,
      payloadDigest: handoff.payloadDigest, conflictFingerprint: handoff.conflictFingerprint,
      reservationId,
    };
    if (action.syncState === 'pending_sync') {
      if (handoff.state === 'required' || handoff.reservationId !== reservationId) return 'blocked';
      if (handoff.state === 'complete') return isCurrent() ? 'process' : 'stale';
      const verification = await this.verifyCanonicalConflictReservation(identity, isCurrent);
      return verification === 'verified' ? 'process' : verification;
    }
    if (action.syncState !== 'held') return 'blocked';
    try {
      if (handoff.state === 'required') {
        if (handoff.reservationId !== undefined) return 'blocked';
        const required = await this.deps.persistRequirement({ ...identity, conflictRecord });
        if (!isCurrent()) return 'stale';
        if (required.status === 'storage-failed') return 'retry';
        if (required.status !== 'committed') return 'blocked';
        const reservation = await this.deps.reserveConflictHandoff({
          ...identity, reservedAt: this.deps.now(),
        });
        if (!isCurrent()) return 'stale';
        if (reservation.status === 'storage-failed') return 'retry';
        if (reservation.status !== 'committed' || reservation.reservationId !== reservationId) {
          return 'blocked';
        }
        const transitioned = await this.deps.transitionActionHandoff({
          ...identity, expectedState: 'required', nextState: 'reserved',
          transitionedAt: this.deps.now(),
        });
        if (!isCurrent()) return 'stale';
        if (transitioned.status === 'storage-failed') return 'retry';
        if (!this.isCommittedCanonicalAction(transitioned, identity)) return 'blocked';
      } else if (handoff.reservationId !== reservationId) {
        return 'blocked';
      } else if (handoff.state === 'reserved') {
        const verification = await this.verifyCanonicalConflictReservation(identity, isCurrent);
        if (verification !== 'verified') return verification;
      }
      const activated = await this.deps.activateHandoff(identity);
      if (!isCurrent()) return 'stale';
      if (activated.status === 'storage-failed') return 'retry';
      return this.isCommittedCanonicalAction(activated, identity, 'pending_sync')
        ? 'process' : 'blocked';
    } catch {
      return isCurrent() ? 'retry' : 'stale';
    }
  }

  private async verifyCanonicalConflictReservation(
    identity: LocalHandoffIdentity,
    isCurrent: () => boolean,
  ): Promise<'blocked' | 'retry' | 'stale' | 'verified'> {
    if (!isCurrent()) return 'stale';
    try {
      const verified = await this.deps.verifyConflictReservation(identity);
      if (!isCurrent()) return 'stale';
      if (verified.status === 'storage-failed') return 'retry';
      return verified.status === 'committed' ? 'verified' : 'blocked';
    } catch {
      return isCurrent() ? 'retry' : 'stale';
    }
  }

  private isCommittedCanonicalAction(
    result: LocalHandoffQueueMutationResult,
    identity: LocalHandoffIdentity,
    expectedSyncState?: QueuedAction['syncState'],
  ): boolean {
    const action = result.status === 'committed' ? result.action : undefined;
    const handoff = action?.localHandoff;
    return !!action && !!handoff && action.id === identity.actionId
      && action.operationId === identity.operationId
      && handoff.ownerUserId === identity.ownerUserId
      && handoff.projectId === identity.projectId
      && handoff.actionId === identity.actionId
      && handoff.operationId === identity.operationId
      && handoff.payloadDigest === identity.payloadDigest
      && handoff.conflictFingerprint === identity.conflictFingerprint
      && handoff.state !== 'required'
      && handoff.reservationId === identity.reservationId
      && (!expectedSyncState || action.syncState === expectedSyncState);
  }

  private scheduleRetry(): void {
    if (this.destroyed || this.retryHandle !== null) return;
    this.requested = false;
    const generation = this.generation;
    const handle = this.deps.scheduleRetry(
      () => {
        if (this.destroyed || generation !== this.generation || this.retryHandle !== handle) return;
        this.retryHandle = null;
        this.request();
      },
      ActionQueueProjectConflictHandoffRecoveryController.RETRY_DELAY_MS,
    );
    this.retryHandle = handle;
  }

  private cancelRetry(): void {
    const handle = this.retryHandle;
    this.retryHandle = null;
    if (handle !== null) this.deps.clearRetry(handle);
  }

  private async releaseLease(
    lease: Awaited<ReturnType<ActionQueueProjectConflictHandoffRecoveryDeps['acquireLease']>>,
  ): Promise<boolean> {
    if (!lease) return true;
    try {
      await lease.release();
      return true;
    } catch {
      return false;
    }
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
