import type { EnqueueMutationResult } from './action-queue-enqueue-mutation.service';
import type {
  EnqueueParams,
  ProjectConflictLocalHandoffState,
  QueuedAction,
} from './action-queue.types';
import type {
  QueueBackupProtectedHandoffReason,
  QueueBackupStrictUpdateResult,
} from './queue-backup.service';
import { createProjectConflictHandoffReservationId } from './project-operation-conflict-retry-settlement.controller';

class IntentionalQueueNoMutation extends Error {}

export interface HeldActionReceipt {
  actionId: string;
  operationId: string;
}

export interface HeldActionLocalHandoffSeed {
  projectId: string;
  payloadDigest: string;
  conflictFingerprint: string;
}

export type LocalHandoffProtectionResult =
  | { status: 'unprotected' }
  | {
    status: 'protected-handoff';
    reason: QueueBackupProtectedHandoffReason;
    actionIds: string[];
  }
  | { status: 'complete' };

export type DeadLetterHandoffAuthorizationResult =
  | Extract<LocalHandoffProtectionResult, { status: 'protected-handoff' }>
  | { status: 'authorized'; action: QueuedAction };

export interface LocalHandoffIdentity {
  ownerUserId: string;
  projectId: string;
  actionId: string;
  operationId: string;
  payloadDigest: string;
  conflictFingerprint: string;
  reservationId: string;
}

export interface LocalHandoffTransitionInput extends LocalHandoffIdentity {
  expectedState: ProjectConflictLocalHandoffState;
  nextState: ProjectConflictLocalHandoffState;
  transitionedAt: string;
}

export type LocalHandoffQueueMutationResult =
  | { status: 'committed'; action?: QueuedAction }
  | { status: 'missing' | 'identity-mismatch' | 'state-mismatch' | 'storage-failed' };

export class ProtectedQueueMutationError extends Error {
  override readonly name = 'ProtectedQueueMutationError';

  constructor(
    readonly reason: QueueBackupProtectedHandoffReason,
    readonly actionIds: string[],
  ) {
    super(`protected ActionQueue handoff cannot be removed: ${reason}`);
  }
}

export interface ActionQueueHeldActionControllerOptions {
  createQueuedAction: (action: EnqueueParams) => QueuedAction;
  getCurrentOwnerUserId: () => string;
  persistQueueMutationStrictlyForOwner: (
    ownerUserId: string,
    updater: (queue: QueuedAction[]) => QueuedAction[],
  ) => Promise<QueueBackupStrictUpdateResult>;
  buildCurrentOwnerEnqueueMutation: (
    queue: QueuedAction[],
    action: EnqueueParams,
    queuedAction: QueuedAction,
  ) => EnqueueMutationResult;
  buildForeignOwnerEnqueueMutation: (
    queue: QueuedAction[],
    action: EnqueueParams,
    queuedAction: QueuedAction,
    ownerUserId: string,
  ) => EnqueueMutationResult;
  applyPersistedCurrentOwnerQueue: (queue: QueuedAction[]) => void;
}

export class ActionQueueHeldActionController {
  constructor(private readonly options: ActionQueueHeldActionControllerOptions) {}

  async enqueueHeldDurablyForOwner(
    ownerUserId: string,
    action: EnqueueParams,
    localHandoff?: HeldActionLocalHandoffSeed,
  ): Promise<HeldActionReceipt | null> {
    const createdAction = this.options.createQueuedAction(action);
    const queuedAction: QueuedAction = {
      ...createdAction,
      syncState: 'held' as const,
      localHandoff: localHandoff ? {
        kind: 'resolved-project-conflict',
        state: 'required',
        ownerUserId,
        projectId: localHandoff.projectId,
        actionId: createdAction.id,
        operationId: createdAction.operationId,
        payloadDigest: localHandoff.payloadDigest,
        conflictFingerprint: localHandoff.conflictFingerprint,
      } : undefined,
    };
    const mutations: EnqueueMutationResult[] = [];
    const persistence = await this.options.persistQueueMutationStrictlyForOwner(
      ownerUserId,
      queue => {
        const mutation = ownerUserId === this.options.getCurrentOwnerUserId()
          ? this.options.buildCurrentOwnerEnqueueMutation(queue, action, queuedAction)
          : this.options.buildForeignOwnerEnqueueMutation(
            queue,
            action,
            queuedAction,
            ownerUserId,
          );
        mutations.push(mutation);
        return mutation.nextQueue;
      },
    );
    const [mutation] = mutations;
    if (persistence.status !== 'committed' || !mutation?.resolvedActionId) return null;
    const persistedQueue = persistence.queue;

    const canonical = persistedQueue.find(item =>
      item.id === mutation?.resolvedActionId
      && item.operationId === queuedAction.operationId
      && item.syncState === 'held'
    );
    if (!canonical) return null;
    if (ownerUserId === this.options.getCurrentOwnerUserId()) {
      this.options.applyPersistedCurrentOwnerQueue(persistedQueue);
    }
    return { actionId: canonical.id, operationId: canonical.operationId };
  }

  async transitionLocalHandoffStrictlyForOwner(
    input: LocalHandoffTransitionInput,
  ): Promise<LocalHandoffQueueMutationResult> {
    let outcome: LocalHandoffQueueMutationResult = { status: 'missing' };
    const sentinel = new IntentionalQueueNoMutation();
    let intentionallyAborted = false;
    const stop = (result: LocalHandoffQueueMutationResult): never => {
      outcome = result;
      intentionallyAborted = true;
      throw sentinel;
    };
    const persistence = await this.options.persistQueueMutationStrictlyForOwner(
      input.ownerUserId,
      queue => {
        const index = queue.findIndex(action => action.id === input.actionId);
        if (index < 0) return stop({ status: 'missing' });
        const action = queue[index]!;
        const handoff = action.localHandoff;
        if (!handoff || !isValidLocalHandoff(action, handoff)
          || !matchesLocalHandoffBaseIdentity(action, handoff, input)) {
          return stop({ status: 'identity-mismatch' });
        }
        const canonicalReservationId = createProjectConflictHandoffReservationId(
          action.operationId, handoff.payloadDigest, handoff.conflictFingerprint,
        );
        if (input.reservationId !== canonicalReservationId
          || !isSupportedLocalHandoffTransition(input)) {
          return stop({ status: 'identity-mismatch' });
        }
        if (localHandoffStateRank(handoff.state) >= localHandoffStateRank(input.nextState)) {
          return handoff.state !== 'required' && handoff.reservationId === canonicalReservationId
            ? stop({ status: 'committed', action })
            : stop({ status: 'identity-mismatch' });
        }
        if (handoff.state !== input.expectedState) {
          return stop({ status: 'state-mismatch' });
        }
        if (handoff.state === 'required') {
          if (action.syncState !== 'held') return stop({ status: 'state-mismatch' });
          if (handoff.reservationId !== undefined) return stop({ status: 'identity-mismatch' });
        } else if (handoff.reservationId !== canonicalReservationId) {
          return stop({ status: 'identity-mismatch' });
        }
        const timestamp = input.nextState === 'reserved'
          ? { reservedAt: input.transitionedAt }
          : input.nextState === 'effects-applied'
            ? { effectsAppliedAt: input.transitionedAt }
            : input.nextState === 'complete'
              ? { completedAt: input.transitionedAt }
              : {};
        const updatedAction: QueuedAction = {
          ...action,
          localHandoff: {
            ...handoff,
            ...timestamp,
            state: input.nextState,
            reservationId: input.reservationId,
          },
        };
        outcome = { status: 'committed', action: updatedAction };
        return queue.map((item, itemIndex) => itemIndex === index ? updatedAction : item);
      },
    );
    if (persistence.status !== 'committed') {
      return intentionallyAborted ? outcome : { status: 'storage-failed' };
    }
    if (input.ownerUserId === this.options.getCurrentOwnerUserId()) {
      this.options.applyPersistedCurrentOwnerQueue(persistence.queue);
    }
    return outcome;
  }

  async removeCompletedLocalHandoffStrictlyForOwner(
    input: LocalHandoffIdentity,
  ): Promise<LocalHandoffQueueMutationResult> {
    let outcome: LocalHandoffQueueMutationResult = { status: 'missing' };
    const sentinel = new IntentionalQueueNoMutation();
    let intentionallyAborted = false;
    const stop = (result: LocalHandoffQueueMutationResult): never => {
      outcome = result;
      intentionallyAborted = true;
      throw sentinel;
    };
    const persistence = await this.options.persistQueueMutationStrictlyForOwner(
      input.ownerUserId,
      queue => {
        const index = queue.findIndex(action => action.id === input.actionId);
        if (index < 0) return stop({ status: 'missing' });
        const action = queue[index]!;
        const handoff = action.localHandoff;
        if (!handoff || !isValidLocalHandoff(action, handoff)
          || !matchesLocalHandoffBaseIdentity(action, handoff, input)) {
          return stop({ status: 'identity-mismatch' });
        }
        if (handoff.state !== 'complete') return stop({ status: 'state-mismatch' });
        const canonicalReservationId = createProjectConflictHandoffReservationId(
          action.operationId, handoff.payloadDigest, handoff.conflictFingerprint,
        );
        if (input.reservationId !== canonicalReservationId
          || !matchesLocalHandoffIdentity(action, handoff, input)) {
          return stop({ status: 'identity-mismatch' });
        }
        outcome = { status: 'committed' };
        return queue.filter((_item, itemIndex) => itemIndex !== index);
      },
    );
    if (persistence.status !== 'committed') {
      return intentionallyAborted ? outcome : { status: 'storage-failed' };
    }
    if (input.ownerUserId === this.options.getCurrentOwnerUserId()) {
      this.options.applyPersistedCurrentOwnerQueue(persistence.queue);
    }
    return outcome;
  }

  async activateLocalHandoffStrictlyForOwner(
    input: LocalHandoffIdentity,
  ): Promise<LocalHandoffQueueMutationResult> {
    let outcome: LocalHandoffQueueMutationResult = { status: 'missing' };
    const sentinel = new IntentionalQueueNoMutation();
    let intentionallyAborted = false;
    const stop = (result: LocalHandoffQueueMutationResult): never => {
      outcome = result;
      intentionallyAborted = true;
      throw sentinel;
    };
    const persistence = await this.options.persistQueueMutationStrictlyForOwner(
      input.ownerUserId,
      queue => {
        const index = queue.findIndex(action => action.id === input.actionId);
        if (index < 0) return stop({ status: 'missing' });
        const action = queue[index]!;
        const handoff = action.localHandoff;
        if (!handoff || !isValidLocalHandoff(action, handoff)
          || !matchesLocalHandoffBaseIdentity(action, handoff, input)) {
          return stop({ status: 'identity-mismatch' });
        }
        if (handoff.state === 'required') return stop({ status: 'state-mismatch' });
        const canonicalReservationId = createProjectConflictHandoffReservationId(
          action.operationId, handoff.payloadDigest, handoff.conflictFingerprint,
        );
        if (input.reservationId !== canonicalReservationId
          || handoff.reservationId !== canonicalReservationId) {
          return stop({ status: 'identity-mismatch' });
        }
        if (action.syncState === 'pending_sync') return stop({ status: 'committed', action });
        if (action.syncState !== 'held') return stop({ status: 'state-mismatch' });
        const activated: QueuedAction = { ...action, syncState: 'pending_sync' };
        outcome = { status: 'committed', action: activated };
        return queue.map((item, itemIndex) => itemIndex === index ? activated : item);
      },
    );
    if (persistence.status !== 'committed') {
      return intentionallyAborted ? outcome : { status: 'storage-failed' };
    }
    if (input.ownerUserId === this.options.getCurrentOwnerUserId()) {
      this.options.applyPersistedCurrentOwnerQueue(persistence.queue);
    }
    return outcome;
  }
}

function matchesLocalHandoffIdentity(
  action: QueuedAction,
  handoff: NonNullable<QueuedAction['localHandoff']>,
  identity: LocalHandoffIdentity,
): boolean {
  return matchesLocalHandoffBaseIdentity(action, handoff, identity)
    && (handoff.state === 'required' || handoff.reservationId === identity.reservationId);
}

function matchesLocalHandoffBaseIdentity(
  action: QueuedAction,
  handoff: NonNullable<QueuedAction['localHandoff']>,
  identity: Omit<LocalHandoffIdentity, 'reservationId'>,
): boolean {
  return action.operationId === identity.operationId
    && handoff.ownerUserId === identity.ownerUserId
    && handoff.projectId === identity.projectId
    && handoff.actionId === identity.actionId
    && handoff.operationId === identity.operationId
    && handoff.payloadDigest === identity.payloadDigest
    && handoff.conflictFingerprint === identity.conflictFingerprint;
}

function isSupportedLocalHandoffTransition(input: LocalHandoffTransitionInput): boolean {
  return (input.expectedState === 'required' && input.nextState === 'reserved')
    || (input.expectedState === 'reserved' && input.nextState === 'effects-applied')
    || (input.expectedState === 'effects-applied' && input.nextState === 'complete');
}

function localHandoffStateRank(state: ProjectConflictLocalHandoffState): number {
  return ['required', 'reserved', 'effects-applied', 'complete'].indexOf(state);
}

export function inspectLocalHandoffProtection(action: QueuedAction): LocalHandoffProtectionResult {
  if (action.localHandoff === undefined) return { status: 'unprotected' };
  const handoff = action.localHandoff as Partial<NonNullable<QueuedAction['localHandoff']>>;
  if (!isValidLocalHandoff(action, handoff)) {
    return { status: 'protected-handoff', reason: 'malformed', actionIds: [action.id] };
  }
  if (handoff.state === 'complete') return { status: 'complete' };
  return { status: 'protected-handoff', reason: handoff.state, actionIds: [action.id] };
}

export function authorizeDeadLetterHandoff(
  action: QueuedAction,
  authorizedAt: string,
): DeadLetterHandoffAuthorizationResult {
  const protection = inspectLocalHandoffProtection(action);
  if (protection.status === 'protected-handoff') return protection;
  if (protection.status === 'unprotected') return { status: 'authorized', action };
  return {
    status: 'authorized',
    action: {
      ...action,
      localHandoff: {
        ...action.localHandoff!,
        removalAuthorization: {
          kind: 'dead-letter',
          actionId: action.id,
          operationId: action.operationId,
          authorizedAt,
        },
      },
    },
  };
}

export async function authorizeDeadLetterHandoffDurably(input: {
  ownerUserId: string;
  action: QueuedAction;
  authorizedAt: string;
  persistQueueMutationForOwner: (
    ownerUserId: string,
    updater: (queue: QueuedAction[]) => QueuedAction[],
  ) => Promise<QueuedAction[] | null>;
}): Promise<QueuedAction> {
  if (inspectLocalHandoffProtection(input.action).status === 'unprotected') {
    return input.action;
  }

  let authorizedAction: QueuedAction | null = null;
  const updatedQueue = await input.persistQueueMutationForOwner(
    input.ownerUserId,
    queue => queue.map(item => {
      if (item.id !== input.action.id || item.operationId !== input.action.operationId) return item;
      const authorization = authorizeDeadLetterHandoff(item, input.authorizedAt);
      if (authorization.status === 'protected-handoff') {
        throw new ProtectedQueueMutationError(
          authorization.reason,
          authorization.actionIds,
        );
      }
      authorizedAction = authorization.action;
      return authorization.action;
    }),
  );
  if (updatedQueue === null) {
    throw new Error(`owner-scoped dead-letter authorization failed: ${input.ownerUserId}`);
  }
  if (!authorizedAction) {
    throw new Error(`owner-scoped dead-letter target missing: ${input.action.id}`);
  }
  return authorizedAction;
}

export function isDeadLetterHandoffAuthorized(action: QueuedAction): boolean {
  const protection = inspectLocalHandoffProtection(action);
  if (protection.status === 'unprotected') return true;
  if (protection.status !== 'complete') return false;
  const authorization = action.localHandoff?.removalAuthorization;
  return authorization?.kind === 'dead-letter'
    && authorization.actionId === action.id
    && authorization.operationId === action.operationId
    && typeof authorization.authorizedAt === 'string'
    && authorization.authorizedAt.length > 0;
}

function isValidLocalHandoff(
  action: QueuedAction,
  handoff: Partial<NonNullable<QueuedAction['localHandoff']>>,
): handoff is NonNullable<QueuedAction['localHandoff']> {
  return handoff.kind === 'resolved-project-conflict'
    && (handoff.state === 'required'
      || handoff.state === 'reserved'
      || handoff.state === 'effects-applied'
      || handoff.state === 'complete')
    && typeof handoff.ownerUserId === 'string'
    && handoff.ownerUserId.length > 0
    && typeof handoff.projectId === 'string'
    && handoff.projectId.length > 0
    && handoff.actionId === action.id
    && handoff.operationId === action.operationId
    && typeof handoff.payloadDigest === 'string'
    && handoff.payloadDigest.length > 0
    && typeof handoff.conflictFingerprint === 'string'
    && handoff.conflictFingerprint.length > 0;
}
