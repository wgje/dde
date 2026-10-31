import type { LeaseHandle } from '../../../../services/sync-writer-lease.service';
import type {
  QueuedAction,
  RetryQueueSupersessionReservation,
} from '../../../../services/action-queue.types';
import type { RetryQueueItem } from './retry-queue.types';
import type {
  ActionQueueSupersessionBridge,
  ActionQueueSupersessionReadContext,
} from '../../../../services/action-queue-retry-supersession.controller';

export type RetryQueueActionQueueSupersessionContext = ActionQueueSupersessionReadContext;
export type RetryQueueActionQueueSupersessionBridge = ActionQueueSupersessionBridge;

export interface RetryQueueActionQueueSupersessionControllerOptions {
  getBridge: () => RetryQueueActionQueueSupersessionBridge | null;
  clearOrphanReservations: (
    item: RetryQueueItem,
    reservationTokens: string[],
    leaseSignal: AbortSignal,
  ) => Promise<boolean>;
}

export type RetryQueueSupersessionReplayDecision =
  | 'proceed'
  | 'proceed-after-clear'
  | 'defer';

export class RetryQueueActionQueueSupersessionController {
  constructor(
    private readonly options: RetryQueueActionQueueSupersessionControllerOptions,
  ) {}

  async beforeReplay(
    item: RetryQueueItem,
    lease: LeaseHandle | null,
  ): Promise<RetryQueueSupersessionReplayDecision> {
    const reservations = item.actionQueueSupersessions ?? [];
    if (reservations.length === 0) return await this.beforeUntaggedReplay(item, lease);
    if (!this.hasDurableLiveLease(lease)) return 'defer';

    const bridge = this.options.getBridge();
    if (!bridge || !this.hasCanonicalReservations(item, reservations)) return 'defer';
    const ownerUserId = reservations[0].ownerUserId;
    const context = bridge.captureContext(ownerUserId);
    if (!bridge.isOwnerStorageLoaded(ownerUserId) || !bridge.isContextCurrent(context)) {
      return 'defer';
    }

    const snapshot = await bridge.restoreQueueSnapshot(ownerUserId);
    if (
      lease.signal.aborted
      || !bridge.isContextCurrent(context)
      || !bridge.isOwnerStorageLoaded(ownerUserId)
      || snapshot === null
    ) {
      return 'defer';
    }

    const classifications = reservations.map(current =>
      this.classifyReservation(snapshot.actions, current));
    if (classifications.some(classification => classification !== 'orphan')) {
      return 'defer';
    }

    const tokens = reservations.map(current => current.token);
    const cleared = await this.options.clearOrphanReservations(item, tokens, lease.signal);
    return cleared
      && !lease.signal.aborted
      && bridge.isContextCurrent(context)
      ? 'proceed-after-clear'
      : 'defer';
  }

  private async beforeUntaggedReplay(
    item: RetryQueueItem,
    lease: LeaseHandle | null,
  ): Promise<'proceed' | 'defer'> {
    const bridge = this.options.getBridge();
    if (!bridge) return 'proceed';
    if (!item.sourceUserId || !this.hasDurableLiveLease(lease)) return 'defer';
    const context = bridge.captureContext(item.sourceUserId);
    if (!bridge.isOwnerStorageLoaded(item.sourceUserId) || !bridge.isContextCurrent(context)) {
      return 'defer';
    }
    const snapshot = await bridge.restoreQueueSnapshot(item.sourceUserId);
    if (lease.signal.aborted
      || !bridge.isContextCurrent(context)
      || !bridge.isOwnerStorageLoaded(item.sourceUserId)
      || snapshot === null) {
      return 'defer';
    }
    return snapshot.actions.some(action =>
      action.entityType === item.type
      && action.entityId === item.data.id
      && action.retryQueueSupersessions?.some(reservation =>
        reservation.ownerUserId === item.sourceUserId
        && reservation.entityType === item.type
        && reservation.entityId === item.data.id
        && reservation.actionId === action.id
        && reservation.actionOperationId === action.operationId))
      ? 'defer'
      : 'proceed';
  }

  private hasDurableLiveLease(lease: LeaseHandle | null): lease is LeaseHandle & {
    signal: AbortSignal;
  } {
    return lease !== null
      && lease.mode !== 'memory-only'
      && lease.signal !== undefined
      && !lease.signal.aborted;
  }

  private hasCanonicalReservations(
    item: RetryQueueItem,
    reservations: RetryQueueSupersessionReservation[],
  ): boolean {
    return reservations.every(reservation =>
      reservation.ownerUserId === item.sourceUserId
      && reservation.entityType === item.type
      && reservation.entityId === item.data.id
      && reservation.actionOperationId !== item.operationId
      && this.isNonEmptyIdentity(reservation));
  }

  private classifyReservation(
    actions: QueuedAction[],
    reservation: RetryQueueSupersessionReservation,
  ): 'active' | 'orphan' | 'ambiguous' {
    const matchingId = actions.filter(action => action.id === reservation.actionId);
    if (matchingId.length === 0) return 'orphan';
    if (matchingId.length !== 1) return 'ambiguous';

    const action = matchingId[0];
    if (
      action.operationId !== reservation.actionOperationId
      || action.entityType !== reservation.entityType
      || action.entityId !== reservation.entityId
    ) {
      return 'ambiguous';
    }
    return action.retryQueueSupersessions?.some(current =>
      this.sameReservation(current, reservation)) === true
      ? 'active'
      : 'ambiguous';
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

  private isNonEmptyIdentity(reservation: RetryQueueSupersessionReservation): boolean {
    return reservation.token.length > 0
      && reservation.ownerUserId.length > 0
      && reservation.entityId.length > 0
      && reservation.actionId.length > 0
      && reservation.actionOperationId.length > 0
      && reservation.retryItems.length > 0
      && reservation.retryItems.every(identity =>
        identity.id.length > 0 && identity.operationId.length > 0)
      && new Set(reservation.retryItems.map(identity => identity.id)).size
        === reservation.retryItems.length;
  }
}
