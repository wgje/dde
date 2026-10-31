import { createSyncOperationId } from '../utils/sync-operation-id';
import {
  preserveQueueBackupWithoutWrite,
  type QueueBackupRestoreSnapshot,
  type QueueBackupStrictUpdateResult,
} from './queue-backup.service';
import type { ActionQueueSyncWriterLeaseHandle } from './action-queue-sync-writer-lease.service';
import type { OwnerStorageRestoreOutcome } from './action-queue-restore-barrier.controller';
import { buildActionQueuePayloadSignature } from './action-queue-durable-removal.controller';
import type {
  QueuedAction,
  RetryQueueSupersessionReservation,
} from './action-queue.types';
import { localBackupUiRestoreWriterQuiescence } from './local-backup-ui-restore-writer-quiescence.service';
import type {
  ActionQueueOwnerReloadDependencies,
  ActionQueueOwnerReloadFactoryDependencies,
  ActionQueueOwnerReloadToken,
} from './action-queue-owner-reload.controller';

export interface ActionQueueSupersessionReadContext {
  ownerUserId: string;
  queueGeneration: number;
  sessionGeneration: number;
  authFence: string;
}

export interface ActionQueueSupersessionBridge {
  captureContext(ownerUserId: string): ActionQueueSupersessionReadContext;
  isContextCurrent(context: ActionQueueSupersessionReadContext): boolean;
  isOwnerStorageLoaded(ownerUserId: string): boolean;
  restoreQueueSnapshot(ownerUserId: string): Promise<QueueBackupRestoreSnapshot | null>;
}

export interface ActionQueueRetrySupersessionSelection {
  status: 'unknown' | 'ready';
  retryItems?: Array<{ id: string; operationId: string }>;
}

export interface ActionQueueRetrySupersessionControllerOptions {
  isRetrySupersessionSupported?: () => boolean;
  getCurrentOwnerUserId: () => string;
  getQueueGeneration: () => number;
  getSessionGeneration: () => number;
  captureAuthFence: () => string;
  isQueueContextCurrent: (ownerUserId: string, generation: number) => boolean;
  isSessionContextCurrent: (generation: number, ownerUserId: string) => boolean;
  isOwnerStorageLoaded: (ownerUserId: string) => boolean;
  acquireWriterLease: (ownerUserId: string) => Promise<ActionQueueSyncWriterLeaseHandle | null>;
  borrowActiveWriterLease?: (
    ownerUserId: string,
  ) => ActionQueueSyncWriterLeaseHandle | 'unavailable' | null;
  restoreQueueSnapshot: (ownerUserId: string) => Promise<QueueBackupRestoreSnapshot | null>;
  persistQueueMutationStrictlyForOwner: (
    ownerUserId: string,
    updater: (queue: QueuedAction[]) => QueuedAction[],
  ) => Promise<QueueBackupStrictUpdateResult>;
  inspectRetryTargets: (
    action: QueuedAction,
    ownerUserId: string,
    signal: AbortSignal,
  ) => ActionQueueRetrySupersessionSelection | Promise<ActionQueueRetrySupersessionSelection>;
  reserveRetrySupersession: (
    reservation: RetryQueueSupersessionReservation,
    signal: AbortSignal,
  ) => Promise<boolean>;
  settleRetrySupersessions: (action: QueuedAction, signal: AbortSignal) => Promise<boolean>;
  applyPersistedCurrentOwnerQueue: (queue: QueuedAction[]) => void;
  warn: (message: string, context?: unknown) => void;
}

export interface ActionQueueRetrySupersessionMutation {
  ownerUserId: string;
  mutateQueue: (queue: QueuedAction[]) => QueuedAction[];
  getCandidateActionIds: () => string[];
  persistWithoutSupersession: () => Promise<QueuedAction[] | null>;
}

interface ActionQueueRetrySupersessionContext {
  ownerUserId: string;
  generation: number;
  sessionGeneration: number;
  authFence: string;
}

export interface ActionQueueOwnerStorageLoadRecord {
  ownerUserId: string;
  generation: number;
  state: 'loading' | 'loaded' | 'unknown';
}

type ActionQueueOwnerStorageLoadToken = Pick<
  ActionQueueOwnerStorageLoadRecord,
  'ownerUserId' | 'generation'
>;

export interface ActionQueueOwnerStorageLoadControllerOptions {
  getCurrentOwnerUserId: () => string;
  warn: (message: string, context?: Record<string, unknown>) => void;
}

export class ActionQueueOwnerStorageLoadController {
  private generation = 0;
  private record: ActionQueueOwnerStorageLoadRecord | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: ActionQueueOwnerStorageLoadControllerOptions) {}

  begin(): ActionQueueOwnerStorageLoadRecord {
    const token: ActionQueueOwnerStorageLoadRecord = {
      ownerUserId: this.options.getCurrentOwnerUserId(),
      generation: ++this.generation,
      state: 'loading',
    };
    this.record = token;
    this.notify();
    return token;
  }

  isCurrent(token: ActionQueueOwnerStorageLoadToken): boolean {
    return this.record?.ownerUserId === token.ownerUserId
      && this.record.generation === token.generation
      && this.record.state === 'loading'
      && this.options.getCurrentOwnerUserId() === token.ownerUserId;
  }

  complete(
    token: ActionQueueOwnerStorageLoadToken,
    outcome: OwnerStorageRestoreOutcome,
  ): void {
    if (!this.isCurrent(token)) return;
    this.record = { ...token, state: outcome === 'ready' ? 'loaded' : 'unknown' };
    this.notify();
  }

  markCurrentOwnerUnknown(): void {
    this.record = {
      ownerUserId: this.options.getCurrentOwnerUserId(),
      generation: ++this.generation,
      state: 'unknown',
    };
    this.notify();
  }

  isLoaded(ownerUserId: string): boolean {
    return ownerUserId === this.options.getCurrentOwnerUserId()
      && this.record?.ownerUserId === ownerUserId
      && this.record.state === 'loaded';
  }

  isExactLoaded(ownerUserId: string, generation: number): boolean {
    return this.isLoaded(ownerUserId) && this.record?.generation === generation;
  }

  captureLoadedFence(ownerUserId: string): (() => boolean) | null {
    if (!this.isLoaded(ownerUserId) || !this.record) return null;
    const generation = this.record.generation;
    return () => this.isExactLoaded(ownerUserId, generation);
  }

  invalidateExactLoaded(ownerUserId: string, generation: number): void {
    if (!this.isExactLoaded(ownerUserId, generation)) return;
    this.record = { ownerUserId, generation, state: 'unknown' };
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  currentState(): ActionQueueOwnerStorageLoadRecord['state'] {
    return this.record?.ownerUserId === this.options.getCurrentOwnerUserId()
      ? this.record.state
      : 'unknown';
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.options.warn('ActionQueue owner storage 监听器失败，已隔离', { error });
      }
    }
  }
}

export type ActionQueueExactOwnerMutationResult =
  | { status: 'REJECTED_NO_COMMIT' }
  | { status: 'COMMITTED_PUBLISHED'; queue: QueuedAction[] }
  | { status: 'COMMITTED_HELD'; queue: QueuedAction[] };

interface ActionQueueExactOwnerMutationControllerOptions {
  getCurrentOwnerUserId: () => string;
  captureCurrentOwnerStorageFence: () => (() => boolean) | null;
  persistQueueMutationForOwner: (
    ownerUserId: string,
    updater: (queue: QueuedAction[]) => QueuedAction[],
  ) => Promise<QueuedAction[] | null>;
  publishCurrentOwnerQueue: (queue: QueuedAction[]) => void;
}

export class ActionQueueExactOwnerMutationController {
  constructor(private readonly options: ActionQueueExactOwnerMutationControllerOptions) {}

  async persistLegacy(
    ownerUserId: string,
    updater: (queue: QueuedAction[]) => QueuedAction[],
  ): Promise<QueuedAction[] | null> {
    const startedAsCurrentOwner = ownerUserId === this.options.getCurrentOwnerUserId();
    const fence = startedAsCurrentOwner
      ? this.options.captureCurrentOwnerStorageFence()
      : () => true;
    if (!fence) return null;
    const queue = await this.options.persistQueueMutationForOwner(ownerUserId, updater);
    const remainsCurrentOwner = ownerUserId === this.options.getCurrentOwnerUserId();
    if (queue === null || (remainsCurrentOwner && !fence())) return null;
    if (startedAsCurrentOwner && remainsCurrentOwner) {
      this.options.publishCurrentOwnerQueue(queue);
    }
    return queue;
  }

  async persistExact(
    ownerUserId: string,
    updater: (queue: QueuedAction[]) => QueuedAction[],
  ): Promise<ActionQueueExactOwnerMutationResult> {
    const result = await this.persistExactMutation(ownerUserId, updater);
    if (result) return result;
    throw new Error('Exact owner queue mutation did not reach a durable commit');
  }

  private async persistExactMutation(
    ownerUserId: string,
    updater: (queue: QueuedAction[]) => QueuedAction[],
  ): Promise<ActionQueueExactOwnerMutationResult | null> {
    const startedAsCurrentOwner = ownerUserId === this.options.getCurrentOwnerUserId();
    const fence = startedAsCurrentOwner
      ? this.options.captureCurrentOwnerStorageFence()
      : () => true;
    if (!fence) return this.rejected();

    const rejectedBeforeUpdater = new Error('Owner queue mutation fence became stale');
    let queue: QueuedAction[] | null;
    try {
      queue = await this.options.persistQueueMutationForOwner(ownerUserId, current => {
        if (!fence()) throw rejectedBeforeUpdater;
        return updater(current);
      });
    } catch (error) {
      if (error === rejectedBeforeUpdater) return this.rejected();
      throw error;
    }
    if (queue === null) return null;

    const remainsCurrentOwner = ownerUserId === this.options.getCurrentOwnerUserId();
    const fenceIsCurrent = fence();
    if (startedAsCurrentOwner && remainsCurrentOwner && fenceIsCurrent) {
      this.options.publishCurrentOwnerQueue(queue);
      return { status: 'COMMITTED_PUBLISHED', queue };
    }
    return { status: 'COMMITTED_HELD', queue };
  }

  private rejected(): ActionQueueExactOwnerMutationResult {
    return { status: 'REJECTED_NO_COMMIT' };
  }
}

export function buildActionQueueOwnerReloadDependencies<TQueue, TDeadLetter, TRetryBridge>(
  dependencies: ActionQueueOwnerReloadFactoryDependencies<TQueue, TDeadLetter, TRetryBridge>,
): ActionQueueOwnerReloadDependencies<TQueue, TDeadLetter> {
  const load = dependencies.ownerStorageLoad;
  const activate = (token: ActionQueueOwnerReloadToken) => {
    const assertCurrent = () => {
      if (!load.isExactLoaded(token.ownerUserId, token.generation)) {
        throw new Error('ActionQueue owner activation became stale');
      }
    };
    assertCurrent();
    try {
      dependencies.retryQueue.configureActionQueueSupersessionBridge(
        dependencies.createRetryBridge(),
      );
      assertCurrent();
      dependencies.storage.setupNetworkListeners();
      assertCurrent();
      dependencies.storage.requestQueueProcessing('owner-storage-activated');
    } catch (error) {
      dependencies.storage.removeNetworkListeners();
      throw error;
    }
  };
  return {
    beginLoad: () => load.begin(),
    isLoadCurrent: token => load.isCurrent(token),
    preflight: async token => {
      const result = await dependencies.preActionQueueFence.run({
        ownerUserId: token.ownerUserId,
        isCurrent: () => load.isCurrent(token),
      });
      return result.status === 'CLEAR'
        ? { status: 'CLEAR' }
        : { status: 'HOLD', reason: result.reason };
    },
    completeLoad: (token, outcome) => load.complete(token, outcome),
    isLoadedCurrent: token => load.isExactLoaded(token.ownerUserId, token.generation),
    invalidateLoaded: token => load.invalidateExactLoaded(token.ownerUserId, token.generation),
    captureState: () => dependencies.storage.captureCurrentOwnerStorageState(),
    stage: token => localBackupUiRestoreWriterQuiescence.runAsync(
      token.ownerUserId,
      'action-queue',
      () => dependencies.storage.stageCurrentOwnerStorage(
        token.generation,
        token.ownerUserId,
        () => load.isCurrent(token) ? token.generation : -1,
      ),
    ),
    publishState: state => dependencies.storage.publishCurrentOwnerStorageState(state),
    statesMatch: state => dependencies.storage.currentOwnerStorageStateMatches(state),
    activate,
    warn: dependencies.warn,
  };
}

export class ActionQueueRetrySupersessionController {
  constructor(private readonly options: ActionQueueRetrySupersessionControllerOptions) {}

  createRetryQueueBridge(): ActionQueueSupersessionBridge {
    return {
      captureContext: ownerUserId => {
        const context = this.captureContext(ownerUserId);
        return {
          ownerUserId,
          queueGeneration: context.generation,
          sessionGeneration: context.sessionGeneration,
          authFence: context.authFence,
        };
      },
      isContextCurrent: context => this.isContextCurrent({
        ownerUserId: context.ownerUserId,
        generation: context.queueGeneration,
        sessionGeneration: context.sessionGeneration,
        authFence: context.authFence,
      }),
      isOwnerStorageLoaded: ownerUserId => this.options.isOwnerStorageLoaded(ownerUserId),
      restoreQueueSnapshot: ownerUserId => this.options.restoreQueueSnapshot(ownerUserId),
    };
  }

  async persistMutation(
    input: ActionQueueRetrySupersessionMutation,
  ): Promise<QueuedAction[] | null> {
    const context = this.captureContext(input.ownerUserId);
    let lease: ActionQueueSyncWriterLeaseHandle | null = null;
    let releaseLease = false;
    try {
      const borrowed = this.options.borrowActiveWriterLease?.(input.ownerUserId) ?? null;
      if (borrowed === 'unavailable') return null;
      lease = borrowed;
      if (!lease) {
        lease = await this.options.acquireWriterLease(input.ownerUserId);
        releaseLease = true;
      }
      if (!this.hasDurableLiveLease(lease) || !this.isContextCurrent(context)) return null;
      return await this.persistMutationWithLease(input, context, lease.signal);
    } catch (error) {
      this.options.warn('ActionQueue cross-queue supersession 持久化失败', error);
    } finally {
      if (releaseLease) await this.releaseLease(lease);
    }
    return null;
  }

  createPersistenceFence(
    ownerUserId: string,
    generation: number,
    signal: AbortSignal | undefined,
  ): () => boolean {
    const context = this.captureContext(ownerUserId);
    return () => context.generation === generation
      && signal !== undefined
      && this.isLeaseContextCurrent(context, signal);
  }

  private async persistMutationWithLease(
    input: ActionQueueRetrySupersessionMutation,
    context: ActionQueueRetrySupersessionContext,
    signal: AbortSignal,
  ): Promise<QueuedAction[] | null> {
    const snapshot = await this.options.restoreQueueSnapshot(input.ownerUserId);
    if (!snapshot || !this.isLeaseContextCurrent(context, signal)) return null;
    const draftQueue = input.mutateQueue(snapshot.actions);
    const targets = this.resolveCandidateActions(draftQueue, input.getCandidateActionIds());
    const selections = this.options.isRetrySupersessionSupported?.() === false
      ? []
      : await this.inspectSelections(targets, input.ownerUserId, signal);
    if (!this.isLeaseContextCurrent(context, signal)) return null;
    if (selections === 'unknown') return null;
    if (selections.length === 0) {
      return await this.commitMutationWithoutReservations(input, context, signal, targets);
    }
    const reservations = this.buildReservations(selections, input.ownerUserId);
    if (!await this.reserveAll(reservations, context, signal)) return null;
    const result = await this.options.persistQueueMutationStrictlyForOwner(
      input.ownerUserId,
      queue => this.attachReservationsToLatestMutation(
        input,
        queue,
        reservations,
        selections.map(selection => selection.action),
      ),
    );
    if (result.status !== 'committed' || !this.isLeaseContextCurrent(context, signal)) return null;
    const readback = await this.options.restoreQueueSnapshot(input.ownerUserId);
    return readback
      && readback.recordFound
      && this.isLeaseContextCurrent(context, signal)
      && this.hasExactActions(readback.actions, targets)
      && this.hasExactReservations(readback.actions, reservations)
      ? readback.actions
      : null;
  }

  private async commitMutationWithoutReservations(
    input: ActionQueueRetrySupersessionMutation,
    context: ActionQueueRetrySupersessionContext,
    signal: AbortSignal,
    targets: QueuedAction[],
  ): Promise<QueuedAction[] | null> {
    if (!this.isLeaseContextCurrent(context, signal)) return null;
    const result = await this.options.persistQueueMutationStrictlyForOwner(
      input.ownerUserId,
      input.mutateQueue,
    );
    if (result.status !== 'committed' || !this.isLeaseContextCurrent(context, signal)) return null;
    const readback = await this.options.restoreQueueSnapshot(input.ownerUserId);
    return readback
      && readback.recordFound
      && this.isLeaseContextCurrent(context, signal)
      && (targets.length === 0 || this.hasExactActions(readback.actions, targets))
      ? readback.actions
      : null;
  }

  private buildReservations(
    selections: Array<{ action: QueuedAction; retryItems: Array<{ id: string; operationId: string }> }>,
    ownerUserId: string,
  ): RetryQueueSupersessionReservation[] {
    return selections.map(({ action, retryItems }) => ({
      token: createSyncOperationId(),
      ownerUserId,
      entityType: action.entityType as 'project' | 'task' | 'connection',
      entityId: action.entityId,
      actionId: action.id,
      actionOperationId: action.operationId,
      retryItems,
    }));
  }

  private async reserveAll(
    reservations: RetryQueueSupersessionReservation[],
    context: ActionQueueRetrySupersessionContext,
    signal: AbortSignal,
  ): Promise<boolean> {
    for (const reservation of reservations) {
      if (!this.isLeaseContextCurrent(context, signal)
        || !await this.options.reserveRetrySupersession(reservation, signal)) return false;
    }
    return this.isLeaseContextCurrent(context, signal);
  }

  private isLeaseContextCurrent(
    context: ActionQueueRetrySupersessionContext,
    signal: AbortSignal,
  ): boolean {
    return !signal.aborted && this.isContextCurrent(context);
  }

  async settleBeforeProcessing(
    action: QueuedAction,
    ownerUserId: string,
    generation: number,
    signal: AbortSignal | undefined,
  ): Promise<QueuedAction | null> {
    const reservations = action.retryQueueSupersessions ?? [];
    if (reservations.length === 0) return action;
    const context = this.captureContext(ownerUserId);
    if (!signal || context.generation !== generation
      || !this.isLeaseContextCurrent(context, signal)) {
      return null;
    }
    if (reservations.some(reservation => !this.isReservationForAction(reservation, action, ownerUserId))) {
      return null;
    }
    if (!await this.options.settleRetrySupersessions(action, signal)
      || !this.isLeaseContextCurrent(context, signal)) return null;
    const tokens = new Set(reservations.map(reservation => reservation.token));
    const result = await this.options.persistQueueMutationStrictlyForOwner(ownerUserId, queue => {
      const matches = queue.filter(current => current.id === action.id);
      if (matches.length !== 1 || !this.sameActionIdentity(matches[0], action)) {
        throw new Error('cross-queue supersession action identity drift');
      }
      const latest = matches[0];
      const remaining = latest.retryQueueSupersessions?.filter(current => !tokens.has(current.token)) ?? [];
      if (remaining.length === (latest.retryQueueSupersessions?.length ?? 0)) {
        return preserveQueueBackupWithoutWrite(queue);
      }
      return queue.map(current => current.id === action.id
        ? this.withReservations(current, remaining)
        : current);
    });
    if ((result.status !== 'committed' && result.status !== 'no-write')
      || !this.isLeaseContextCurrent(context, signal)) return null;
    const readback = await this.options.restoreQueueSnapshot(ownerUserId);
    if (!readback?.recordFound || !this.isLeaseContextCurrent(context, signal)) {
      return null;
    }
    const current = readback.actions.find(candidate => this.sameActionIdentity(candidate, action));
    if (!current || current.retryQueueSupersessions?.some(reservation => tokens.has(reservation.token))) {
      return null;
    }
    this.options.applyPersistedCurrentOwnerQueue(readback.actions);
    return current;
  }

  private captureContext(ownerUserId: string): ActionQueueRetrySupersessionContext {
    return {
      ownerUserId,
      generation: this.options.getQueueGeneration(),
      sessionGeneration: this.options.getSessionGeneration(),
      authFence: this.options.captureAuthFence(),
    };
  }

  private isContextCurrent(context: ActionQueueRetrySupersessionContext): boolean {
    return this.options.isQueueContextCurrent(context.ownerUserId, context.generation)
      && this.options.isSessionContextCurrent(context.sessionGeneration, context.ownerUserId)
      && this.options.captureAuthFence() === context.authFence
      && this.options.isOwnerStorageLoaded(context.ownerUserId);
  }

  private async inspectSelections(
    targets: QueuedAction[],
    ownerUserId: string,
    signal: AbortSignal,
  ): Promise<Array<{ action: QueuedAction; retryItems: Array<{ id: string; operationId: string }> }> | 'unknown'> {
    const selections: Array<{
      action: QueuedAction;
      retryItems: Array<{ id: string; operationId: string }>;
    }> = [];
    for (const action of targets) {
      if (!this.isRetryEntity(action)) continue;
      const selection = await this.options.inspectRetryTargets(action, ownerUserId, signal);
      if (selection.status === 'unknown') return 'unknown';
      if (selection.retryItems?.length) selections.push({ action, retryItems: selection.retryItems });
    }
    return selections;
  }

  private resolveCandidateActions(queue: QueuedAction[], actionIds: string[]): QueuedAction[] {
    const resolved = new Map<string, QueuedAction>();
    for (const actionId of actionIds) {
      const matches = queue.filter(action => action.id === actionId);
      if (matches.length === 1) resolved.set(actionId, matches[0]);
    }
    return Array.from(resolved.values());
  }

  private attachReservationsToLatestMutation(
    input: ActionQueueRetrySupersessionMutation,
    queue: QueuedAction[],
    reservations: RetryQueueSupersessionReservation[],
    expectedActions: QueuedAction[],
  ): QueuedAction[] {
    const next = input.mutateQueue(queue);
    const targets = this.resolveCandidateActions(next, input.getCandidateActionIds());
    if (reservations.some(reservation => !targets.some(action =>
      action.id === reservation.actionId
      && action.operationId === reservation.actionOperationId
      && action.entityType === reservation.entityType
      && action.entityId === reservation.entityId
      && expectedActions.some(expected => this.sameActionIdentity(action, expected))))) {
      throw new Error('cross-queue supersession enqueue identity drift');
    }
    return next.map(action => {
      const attached = reservations.filter(reservation => reservation.actionId === action.id);
      return attached.length > 0
        ? this.withReservations(action, this.mergeReservations(action.retryQueueSupersessions, attached))
        : action;
    });
  }

  private hasExactReservations(
    queue: QueuedAction[],
    reservations: RetryQueueSupersessionReservation[],
  ): boolean {
    return reservations.every(reservation => queue.some(action =>
      action.id === reservation.actionId
      && action.operationId === reservation.actionOperationId
      && action.retryQueueSupersessions?.some(current =>
        this.sameReservation(current, reservation))));
  }

  private hasExactActions(queue: QueuedAction[], expected: QueuedAction[]): boolean {
    return expected.every(action => {
      const matches = queue.filter(current => current.id === action.id);
      return matches.length === 1 && this.sameActionIdentity(matches[0], action);
    });
  }

  private sameActionIdentity(left: QueuedAction, right: QueuedAction): boolean {
    return left.id === right.id
      && left.operationId === right.operationId
      && left.type === right.type
      && left.entityType === right.entityType
      && left.entityId === right.entityId
      && buildActionQueuePayloadSignature(left.payload)
        === buildActionQueuePayloadSignature(right.payload);
  }

  private sameReservation(
    left: RetryQueueSupersessionReservation,
    right: RetryQueueSupersessionReservation,
  ): boolean {
    return left.token === right.token
      && left.ownerUserId === right.ownerUserId
      && left.entityType === right.entityType
      && left.entityId === right.entityId
      && left.actionId === right.actionId
      && left.actionOperationId === right.actionOperationId
      && left.retryItems.length === right.retryItems.length
      && left.retryItems.every((identity, index) =>
        identity.id === right.retryItems[index]?.id
        && identity.operationId === right.retryItems[index]?.operationId);
  }

  private mergeReservations(
    existing: RetryQueueSupersessionReservation[] | undefined,
    added: RetryQueueSupersessionReservation[],
  ): RetryQueueSupersessionReservation[] {
    const merged = new Map((existing ?? []).map(reservation => [reservation.token, reservation]));
    for (const reservation of added) merged.set(reservation.token, reservation);
    return Array.from(merged.values()).sort((left, right) => left.token.localeCompare(right.token));
  }

  private withReservations(
    action: QueuedAction,
    reservations: RetryQueueSupersessionReservation[],
  ): QueuedAction {
    if (reservations.length > 0) return { ...action, retryQueueSupersessions: reservations };
    const { retryQueueSupersessions: _removed, ...without } = action;
    return without;
  }

  private isReservationForAction(
    reservation: RetryQueueSupersessionReservation,
    action: QueuedAction,
    ownerUserId: string,
  ): boolean {
    return reservation.ownerUserId === ownerUserId
      && reservation.actionId === action.id
      && reservation.actionOperationId === action.operationId
      && reservation.entityType === action.entityType
      && reservation.entityId === action.entityId
      && reservation.retryItems.length > 0;
  }

  private isRetryEntity(action: QueuedAction): boolean {
    return action.entityType === 'project'
      || action.entityType === 'task'
      || action.entityType === 'connection';
  }

  private hasDurableLiveLease(lease: ActionQueueSyncWriterLeaseHandle | null): lease is
    ActionQueueSyncWriterLeaseHandle & { signal: AbortSignal } {
    return lease !== null
      && lease.mode !== 'memory-only'
      && lease.signal !== undefined
      && !lease.signal.aborted;
  }

  private async releaseLease(lease: ActionQueueSyncWriterLeaseHandle | null): Promise<void> {
    if (!lease) return;
    try {
      await lease.release();
    } catch (error) {
      this.options.warn('cross-queue supersession writer lease 释放失败', error);
    }
  }
}
