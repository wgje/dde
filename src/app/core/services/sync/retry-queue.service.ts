/**
 * RetryQueueService - 重试队列管理
 *
 * 公开 Angular 服务入口。具体职责按层下切到同目录的 queue item、capacity、legacy review、
 * circuit breaker、runner 和 storage 层，保持单实例状态与原公开 API 不变。
 */
import { Injectable } from '@angular/core';
import type { Connection, Task } from '../../../../models';
import { localBackupUiRestoreWriterQuiescence } from '../../../../services/local-backup-ui-restore-writer-quiescence.service';
import type { LeaseHandle } from '../../../../services/sync-writer-lease.service';
import type { RetryQueueValidatedRestorePolicy } from './retry-queue-backup-restore.helpers';
import type {
  QueuedAction,
  RetryQueueSupersessionEntityType,
  RetryQueueSupersessionItemIdentity,
  RetryQueueSupersessionReservation,
} from '../../../../services/action-queue.types';
import {
  getRetryQueueItemsForSelection,
  selectRetryItemIdsByProjectIdForOwner,
} from './retry-queue-item-selectors.helpers';
import { RetryQueueStorageLayer } from './retry-queue-storage.service';
import type {
  PersistedRetryQueueItem,
  RetryQueueItem,
  RetryQueueStorageLoadToken,
} from './retry-queue.types';
import {
  RetryQueueActionQueueSupersessionController,
  type RetryQueueActionQueueSupersessionBridge,
  type RetryQueueActionQueueSupersessionContext,
} from './retry-queue-action-queue-supersession.controller';
import { buildConnectionReplayPayloadSignature } from './connection-sync-operations.helpers';
import { buildActionQueuePayloadSignature } from '../../../../services/action-queue-identity.helpers';

interface RetryQueueSupersessionContext {
  storageLoad: RetryQueueStorageLoadToken;
  bridge: RetryQueueActionQueueSupersessionBridge | null;
  actionQueue: RetryQueueActionQueueSupersessionContext | null;
}

export type RetryQueueSupersessionSelection =
  | { status: 'unknown' }
  | { status: 'ready'; retryItems: RetryQueueSupersessionItemIdentity[] };

export type RetryQueueConnectionReplayCommitInput = {
  actionId: string;
  actionOperationId: string;
  connection: Connection;
  projectId: string;
  sourceUserId: string;
  payloadSignature: string;
  leaseSignal: AbortSignal;
  isFenceCurrent: () => boolean;
};

export type RetryQueueConnectionReplayCommitResult = {
  status: 'current' | 'committed' | 'deferred';
};

export type RetryQueueTaskReplayCommitInput = Omit<
  RetryQueueConnectionReplayCommitInput,
  'connection'
> & {
  task: Task;
  writeIntent?: RetryQueueItem['writeIntent'];
};

type RetryQueueReplayCommitInput = Omit<
  RetryQueueConnectionReplayCommitInput,
  'connection'
> & {
  entityType: 'connection' | 'task';
  data: Connection | Task;
  writeIntent?: RetryQueueItem['writeIntent'];
};

export type {
  LegacyRetryReviewItem,
  RetryOperationHandler,
  RetryQueueItem,
  RetryQueueLastFailure,
  RetryQueueProjectPendingWriteState,
  RetryQueueSliceOptions,
  RetryQueueSliceResult,
  RetryQueueUnknownOutcomeReconcileResult,
  TaskDeleteBaseUpdatedAtMap,
  RetryableEntityType,
  RetryableOperation,
} from './retry-queue.types';

@Injectable({
  providedIn: 'root'
})
export class RetryQueueService extends RetryQueueStorageLayer {
  private actionQueueSupersessionBridge: RetryQueueActionQueueSupersessionBridge | null = null;
  private readonly locallyClearedSupersessionTokens = new Set<string>();
  private readonly actionQueueSupersession = new RetryQueueActionQueueSupersessionController({
    getBridge: () => this.actionQueueSupersessionBridge,
    clearOrphanReservations: (item, tokens, signal) =>
      this.clearOrphanActionQueueSupersessions(item, tokens, signal),
  });

  constructor() {
    super();

    // 初始化时加载队列
    void this.initializeStorageLoad();
    
    // 【P2-19 修复】恢复熔断器状态
    this.loadCircuitState();
    this.refreshLegacyReviewCount();
    this.repairQuarantinedBlackBoxEntriesFromStorage();
    
    this.destroyRef.onDestroy(() => {
      this.lifecycleClosed = true;
      this.stopLoop();
      void this.flushStorageOnDestroy();
    });
  }

  private async flushStorageOnDestroy(): Promise<void> {
    try {
      await this.persistNow();
    } catch (error) {
      this.logger.warn('RetryQueue 销毁持久化失败，继续关闭存储连接', error);
    }

    try {
      await this.closeStorageConnections();
    } catch (error) {
      this.logger.warn('RetryQueue 销毁关闭存储连接失败', error);
    }
  }

  private async initializeStorageLoad(): Promise<void> {
    return localBackupUiRestoreWriterQuiescence.runAsync(this.getCurrentOwnerUserId(), 'retry-queue', async () => {
    const loadToken = this.captureStorageLoadToken();

    try {
      await this.initDb();
      if (!this.isStorageLoadTokenCurrent(loadToken)) {
        this.logStaleStorageLoad(loadToken, 'constructor:init-db');
        return;
      }

      await this.loadFromStorage();
    } catch (error) {
      this.logger.warn('RetryQueue 初始化加载失败，已跳过本次启动加载', error);
    }
    });
  }
  
  async closeStorageConnections(): Promise<void> {
    if (this.saveDebounceTimer !== null) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
      this.saveDebounceWriter?.release();
      this.saveDebounceWriter = null;
    }

    const pendingDbInit = this.dbInitPromise;
    this.dbInitPromise = null;

    if (pendingDbInit) {
      try {
        const pendingDb = await pendingDbInit;
        pendingDb?.close();
      } catch {
        // 忽略打开失败：此时不存在可关闭连接
      }
    }

    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  protected override async initDb(): Promise<IDBDatabase | null> {
    return await super.initDb();
  }

  protected override async loadFromStorage(): Promise<void> {
    await localBackupUiRestoreWriterQuiescence.runContinuationAsync(
      this.getCurrentOwnerUserId(), 'retry-queue', () => super.loadFromStorage(),
    );
  }

  protected override saveToStorage(): void {
    super.saveToStorage();
  }

  protected override async saveToStorageImmediate(): Promise<boolean> {
    return await super.saveToStorageImmediate();
  }

  configureActionQueueSupersessionBridge(
    bridge: RetryQueueActionQueueSupersessionBridge,
  ): void {
    this.actionQueueSupersessionBridge = bridge;
  }

  async inspectActionQueueSupersessionTargets(action: Pick<
    QueuedAction,
    'entityType' | 'entityId' | 'operationId'
  >, ownerUserId: string, signal: AbortSignal): Promise<RetryQueueSupersessionSelection> {
    if (!this.isSupersessionEntityType(action.entityType)
      || !this.isOwnerStorageLoadConfirmed(ownerUserId)) {
      return { status: 'unknown' };
    }
    const authoritative = await this.readAuthoritativeSupersessionItems(ownerUserId, signal);
    if (!authoritative) return { status: 'unknown' };
    const retryItems = authoritative
      .filter((item): item is PersistedRetryQueueItem & { operationId: string } =>
        typeof item.operationId === 'string'
        && item.type === action.entityType
        && item.data.id === action.entityId
        && item.sourceUserId === ownerUserId
        && item.operationId !== action.operationId)
      .map(item => ({ id: item.id, operationId: item.operationId }))
      .sort((left, right) => left.id.localeCompare(right.id));
    return { status: 'ready', retryItems };
  }

  private async readAuthoritativeSupersessionItems(
    ownerUserId: string,
    signal: AbortSignal,
  ): Promise<PersistedRetryQueueItem[] | null> {
    const token = this.captureSupersessionContext(ownerUserId);
    if (!this.isSupersessionContextCurrent(token, ownerUserId, signal)) return null;
    const db = await this.initDb().catch(() => null);
    if (!db || !this.isSupersessionContextCurrent(token, ownerUserId, signal)) return null;
    const items = await this.readPersistedItems(db).catch(() => null);
    return items && this.isSupersessionContextCurrent(token, ownerUserId, signal)
      ? items
      : null;
  }

  async reserveActionQueueSupersession(
    reservation: RetryQueueSupersessionReservation,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted || !this.isReservationCanonical(reservation)) return false;
    const authoritative = await this.readAuthoritativeSupersessionItems(
      reservation.ownerUserId,
      signal,
    );
    if (!authoritative) return false;
    const identities = new Map(reservation.retryItems.map(identity => [identity.id, identity.operationId]));
    const selected = authoritative.filter(item => identities.get(item.id) === item.operationId);
    if (selected.length !== identities.size || selected.some(item =>
      item.sourceUserId !== reservation.ownerUserId
      || item.type !== reservation.entityType
      || item.data.id !== reservation.entityId
      || item.operationId === reservation.actionOperationId)) {
      return false;
    }
    this.mapQueueViews(item => identities.get(item.id) === item.operationId
      ? { ...item, actionQueueSupersessions: this.mergeReservations(item.actionQueueSupersessions, [reservation]) }
      : item);
    return await this.persistSupersessionState(
      reservation.ownerUserId,
      signal,
      items => reservation.retryItems.every(identity => {
        const item = items.find(current => current.id === identity.id && current.operationId === identity.operationId);
        return item?.actionQueueSupersessions?.some(current => current.token === reservation.token) === true;
      }),
    );
  }

  async settleActionQueueSupersessions(
    action: QueuedAction,
    signal: AbortSignal,
  ): Promise<boolean> {
    const reservations = action.retryQueueSupersessions ?? [];
    if (reservations.length === 0) return true;
    if (signal.aborted || reservations.some(current =>
      !this.isReservationForAction(current, action))) return false;
    const ownerUserId = reservations[0].ownerUserId;
    if (reservations.some(current => current.ownerUserId !== ownerUserId)) return false;
    const authoritative = await this.readAuthoritativeSupersessionItems(ownerUserId, signal);
    if (!authoritative) return false;
    const reservationsByToken = new Map(reservations.map(current => [current.token, current]));
    const currentItems = authoritative;
    const exactItemIds = new Set<string>();
    const carriedTokensByItemId = new Map<string, Set<string>>();
    const clearedReservationsByItemId = new Map<string, RetryQueueSupersessionReservation[]>();
    for (const item of currentItems) {
      const attached = item.actionQueueSupersessions?.filter(current =>
        reservationsByToken.has(current.token)) ?? [];
      if (attached.length === 0) continue;
      if (item.sourceUserId !== ownerUserId
        || item.type !== action.entityType
        || item.data.id !== action.entityId
        || attached.some(current => !this.sameReservation(
          current,
          reservationsByToken.get(current.token),
        ))) {
        return false;
      }
      const allExact = attached.every(reservation => reservation.retryItems.some(identity =>
        identity.id === item.id && identity.operationId === item.operationId));
      if (allExact) {
        exactItemIds.add(item.id);
        continue;
      }
      const carriedTokens = new Set(attached.map(reservation => reservation.token));
      carriedTokensByItemId.set(item.id, carriedTokens);
      clearedReservationsByItemId.set(item.id, attached);
    }
    if (reservations.some(reservation => reservation.retryItems.some(identity => {
      const exact = currentItems.find(item =>
        item.id === identity.id && item.operationId === identity.operationId);
      return exact !== undefined && !exact.actionQueueSupersessions?.some(current =>
        this.sameReservation(current, reservation));
    }))) {
      return false;
    }
    for (const tokens of carriedTokensByItemId.values()) {
      for (const token of tokens) this.locallyClearedSupersessionTokens.add(token);
    }
    if (carriedTokensByItemId.size > 0) {
      this.mapQueueViews(item => {
        const tokens = carriedTokensByItemId.get(item.id);
        return tokens ? this.withoutReservations(item, tokens) : item;
      });
    }
    const persistSettlement = () => this.persistSupersessionState(
      ownerUserId,
      signal,
      items => this.isSupersessionSettlementPersisted(
        items,
        reservations,
      ),
    );
    const committed = exactItemIds.size > 0
      ? await this.removeRetryItemsDurably(exactItemIds, persistSettlement)
      : await persistSettlement();
    for (const tokens of carriedTokensByItemId.values()) {
      for (const token of tokens) this.locallyClearedSupersessionTokens.delete(token);
    }
    if (committed) return true;
    if (clearedReservationsByItemId.size > 0) {
      this.mapQueueViews(item => {
        const cleared = clearedReservationsByItemId.get(item.id);
        return cleared ? {
          ...item,
          actionQueueSupersessions: this.mergeReservations(item.actionQueueSupersessions, cleared),
        } : item;
      });
      this.saveToStorage();
    }
    return false;
  }

  private isSupersessionSettlementPersisted(
    items: readonly PersistedRetryQueueItem[],
    reservations: RetryQueueSupersessionReservation[],
  ): boolean {
    const tokens = new Set(reservations.map(current => current.token));
    return items.every(item =>
      !item.actionQueueSupersessions?.some(current => tokens.has(current.token))
      && !reservations.some(reservation => reservation.retryItems.some(identity =>
        identity.id === item.id && identity.operationId === item.operationId)));
  }

  protected override selectRetryQueueEntityWinner(
    currentWinner: RetryQueueItem,
    incoming: RetryQueueItem,
    options: { preferCurrentOnTie?: boolean } = {},
  ): RetryQueueItem {
    const winner = super.selectRetryQueueEntityWinner(currentWinner, incoming, options);
    const actionQueueSupersessions = this.mergeReservations(
      currentWinner.actionQueueSupersessions,
      incoming.actionQueueSupersessions,
    ).filter(reservation => !this.locallyClearedSupersessionTokens.has(reservation.token));
    if (actionQueueSupersessions.length > 0) {
      return { ...winner, actionQueueSupersessions };
    }
    if (currentWinner.actionQueueSupersessions || incoming.actionQueueSupersessions) {
      const { actionQueueSupersessions: _removed, ...withoutReservations } = winner;
      return withoutReservations;
    }
    return winner;
  }

  protected async handleActionQueueSupersessionBeforeReplay(
    item: RetryQueueItem,
    lease: LeaseHandle | null,
  ): Promise<'proceed' | 'proceed-after-clear' | 'defer'> {
    return await this.actionQueueSupersession.beforeReplay(item, lease);
  }

  private async clearOrphanActionQueueSupersessions(
    item: RetryQueueItem,
    reservationTokens: string[],
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) return false;
    const authoritative = await this.readAuthoritativeSupersessionItems(item.sourceUserId ?? '', signal);
    const latest = authoritative?.find(current =>
      current.id === item.id && current.operationId === item.operationId);
    const removedTokens = new Set(reservationTokens);
    const removedReservations = latest?.actionQueueSupersessions?.filter(current =>
      removedTokens.has(current.token)) ?? [];
    if (!latest || removedReservations.length !== removedTokens.size) return false;
    for (const token of removedTokens) this.locallyClearedSupersessionTokens.add(token);
    this.mapQueueViews(current => current.id === item.id && current.operationId === item.operationId
      ? this.withoutReservations(current, removedTokens)
      : current);
    const committed = await this.persistSupersessionState(
      item.sourceUserId ?? '',
      signal,
      items => {
        const persisted = items.find(current =>
          current.id === item.id && current.operationId === item.operationId);
        return persisted !== undefined && reservationTokens.every(token =>
          !persisted.actionQueueSupersessions?.some(current => current.token === token));
      },
    );
    for (const token of removedTokens) this.locallyClearedSupersessionTokens.delete(token);
    if (committed) return true;
    this.mapQueueViews(current => current.id === item.id && current.operationId === item.operationId
      ? {
          ...current,
          actionQueueSupersessions: this.mergeReservations(
            current.actionQueueSupersessions,
            removedReservations,
          ),
        }
      : current);
    this.saveToStorage();
    return false;
  }

  private async persistSupersessionState(
    ownerUserId: string,
    signal: AbortSignal,
    verify: (items: readonly PersistedRetryQueueItem[]) => boolean,
  ): Promise<boolean> {
    const token = this.captureSupersessionContext(ownerUserId);
    if (!this.isSupersessionContextCurrent(token, ownerUserId, signal)) return false;
    try {
      if (!await this.persistNow() || !this.isSupersessionContextCurrent(token, ownerUserId, signal)) {
        return false;
      }
      const db = await this.initDb();
      if (!db || !this.isSupersessionContextCurrent(token, ownerUserId, signal)) return false;
      const idbItems = await this.readPersistedItems(db);
      if (!idbItems || !this.isSupersessionContextCurrent(token, ownerUserId, signal) || !verify(idbItems)) {
        return false;
      }
      if (typeof localStorage === 'undefined') return true;
      return this.saveToLocalStorage()
        && this.isSupersessionContextCurrent(token, ownerUserId, signal)
        && verify(this.loadFromLocalStorage());
    } catch {
      return false;
    }
  }

  private isSupersessionContextCurrent(
    token: RetryQueueSupersessionContext | null,
    ownerUserId: string,
    signal: AbortSignal,
  ): boolean {
    if (!token || signal.aborted
      || token.storageLoad.ownerUserId !== ownerUserId
      || !this.isStorageLoadTokenCurrent(token.storageLoad)
      || !this.isOwnerStorageLoadConfirmed(ownerUserId)
      || token.bridge !== this.actionQueueSupersessionBridge) return false;
    try {
      return token.bridge === null
        || (token.actionQueue !== null && token.bridge.isContextCurrent(token.actionQueue));
    } catch {
      return false;
    }
  }

  private captureSupersessionContext(ownerUserId: string): RetryQueueSupersessionContext | null {
    const bridge = this.actionQueueSupersessionBridge;
    try {
      return {
        storageLoad: this.captureStorageLoadToken(),
        bridge,
        actionQueue: bridge?.captureContext(ownerUserId) ?? null,
      };
    } catch {
      // Missing bridge identity evidence fails closed.
    }
    return null;
  }

  private mapQueueViews(mapper: (item: RetryQueueItem) => RetryQueueItem): void {
    this.queue = this.queue.map(mapper);
    this.hiddenQueueItems = this.hiddenQueueItems.map(mapper);
    this.touchQueueState();
  }

  private withoutReservations(item: RetryQueueItem, removedTokens: Set<string>): RetryQueueItem {
    const remaining = item.actionQueueSupersessions?.filter(current => !removedTokens.has(current.token)) ?? [];
    if (remaining.length > 0) return { ...item, actionQueueSupersessions: remaining };
    const { actionQueueSupersessions: _removed, ...without } = item;
    return without;
  }

  private mergeReservations(
    left: RetryQueueSupersessionReservation[] | undefined,
    right: RetryQueueSupersessionReservation[] | undefined,
  ): RetryQueueSupersessionReservation[] {
    const merged = new Map<string, RetryQueueSupersessionReservation>();
    for (const reservation of [...(left ?? []), ...(right ?? [])]) {
      merged.set(reservation.token, reservation);
    }
    return Array.from(merged.values()).sort((a, b) => a.token.localeCompare(b.token));
  }

  private isReservationCanonical(reservation: RetryQueueSupersessionReservation): boolean {
    return reservation.token.length > 0
      && reservation.ownerUserId.length > 0
      && reservation.entityId.length > 0
      && reservation.actionId.length > 0
      && reservation.actionOperationId.length > 0
      && reservation.retryItems.length > 0
      && new Set(reservation.retryItems.map(identity => identity.id)).size === reservation.retryItems.length;
  }

  private isReservationForAction(
    reservation: RetryQueueSupersessionReservation,
    action: QueuedAction,
  ): boolean {
    return this.isReservationCanonical(reservation)
      && reservation.actionId === action.id
      && reservation.actionOperationId === action.operationId
      && reservation.entityType === action.entityType
      && reservation.entityId === action.entityId;
  }

  private sameReservation(
    left: RetryQueueSupersessionReservation,
    right: RetryQueueSupersessionReservation | undefined,
  ): boolean {
    return right !== undefined
      && left.token === right.token
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

  private isSupersessionEntityType(value: string): value is RetryQueueSupersessionEntityType {
    return value === 'project' || value === 'task' || value === 'connection';
  }

  async commitConnectionReplay(
    input: RetryQueueConnectionReplayCommitInput,
  ): Promise<RetryQueueConnectionReplayCommitResult> {
    return this.commitReplay({ ...input, entityType: 'connection', data: input.connection });
  }

  async commitTaskReplay(
    input: RetryQueueTaskReplayCommitInput,
  ): Promise<RetryQueueConnectionReplayCommitResult> {
    return this.commitReplay({ ...input, entityType: 'task', data: input.task });
  }

  private async commitReplay(
    input: RetryQueueReplayCommitInput,
  ): Promise<RetryQueueConnectionReplayCommitResult> {
    return localBackupUiRestoreWriterQuiescence.runAsync(
      input.sourceUserId,
      'retry-queue',
      async () => {
        const readContext = this.captureSupersessionContext(input.sourceUserId);
        if (!this.isReplayCommitCurrent(input, readContext)) return { status: 'deferred' };
        const db = await this.initDb().catch(() => null);
        if (!db || !this.isReplayCommitCurrent(input, readContext)) return { status: 'deferred' };
        const persistedBefore = await this.readPersistedItems(db).catch(() => null);
        if (!persistedBefore || !this.isReplayCommitCurrent(input, readContext)) {
          return { status: 'deferred' };
        }
        const beforeStatus = this.classifyReplayItems(persistedBefore, input);
        if (beforeStatus !== 'absent') return { status: beforeStatus };
        if (!this.addInternal(
          input.entityType, 'upsert', input.data, input.projectId, input.sourceUserId,
          undefined, input.writeIntent, undefined, input.actionOperationId, undefined, 'manual',
        ) || !input.isFenceCurrent() || input.leaseSignal.aborted) {
          return { status: 'deferred' };
        }
        const writeContext = this.captureSupersessionContext(input.sourceUserId);
        if (!this.isReplayCommitCurrent(input, writeContext)) return { status: 'deferred' };
        if (!await this.persistNow() || !this.isReplayCommitCurrent(input, writeContext)) {
          return { status: 'deferred' };
        }
        const readbackDb = await this.initDb().catch(() => null);
        if (!readbackDb || !this.isReplayCommitCurrent(input, writeContext)) {
          return { status: 'deferred' };
        }
        const persistedAfter = await this.readPersistedItems(readbackDb).catch(() => null);
        return persistedAfter
          && this.isReplayCommitCurrent(input, writeContext)
          && this.classifyReplayItems(persistedAfter, input) === 'current'
          ? { status: 'committed' }
          : { status: 'deferred' };
      },
    );
  }

  private classifyReplayItems(
    items: readonly PersistedRetryQueueItem[],
    input: RetryQueueReplayCommitInput,
  ): 'absent' | 'current' | 'deferred' {
    const candidates = items.filter(item => item.type === input.entityType
      && item.data.id === input.data.id
      && item.sourceUserId === input.sourceUserId);
    if (candidates.length === 0) return 'absent';
    if (candidates.length !== 1) return 'deferred';
    const item = candidates[0];
    return item.operation === 'upsert'
      && item.projectId === input.projectId
      && item.operationId === input.actionOperationId
      && (input.entityType === 'connection' || item.writeIntent === input.writeIntent)
      && this.buildReplayPayloadSignature(input.entityType, item.data as Connection | Task,
        input.projectId, input.sourceUserId, item.writeIntent)
        === input.payloadSignature
      ? 'current'
      : 'deferred';
  }

  private buildReplayPayloadSignature(
    entityType: 'connection' | 'task',
    data: Connection | Task,
    projectId: string,
    sourceUserId: string,
    writeIntent?: RetryQueueItem['writeIntent'],
  ): string {
    if (entityType === 'connection') return buildConnectionReplayPayloadSignature(data, projectId, sourceUserId);
    const { displayId: _displayId, ...persistedTask } = data as Task;
    return buildActionQueuePayloadSignature({ task: persistedTask, projectId, sourceUserId, writeIntent });
  }

  private isReplayCommitCurrent(
    input: RetryQueueReplayCommitInput,
    context: RetryQueueSupersessionContext | null,
  ): boolean {
    return input.actionId.length > 0
      && input.actionOperationId.length > 0
      && input.projectId.length > 0
      && input.sourceUserId.length > 0
      && input.data.id.length > 0
      && input.payloadSignature === this.buildReplayPayloadSignature(
        input.entityType, input.data, input.projectId, input.sourceUserId, input.writeIntent,
      )
      && context?.bridge !== null
      && context?.actionQueue !== null
      && input.isFenceCurrent()
      && this.isSupersessionContextCurrent(context, input.sourceUserId, input.leaseSignal);
  }

  async removeByProjectIdDurablyForOwner(
    projectId: string,
    ownerUserId: string,
  ): Promise<boolean> {
    return localBackupUiRestoreWriterQuiescence.runAsync(
      ownerUserId,
      'retry-queue',
      async () => {
        const readToken = this.captureStorageLoadToken();
        if (!this.isProjectCleanupContextCurrent(readToken, ownerUserId)) {
          return false;
        }
        const db = await this.initDb();
        if (!db || !this.isProjectCleanupContextCurrent(readToken, ownerUserId)) {
          return false;
        }
        const persistedItems = await this.readPersistedItems(db);
        if (!persistedItems || !this.isProjectCleanupContextCurrent(readToken, ownerUserId)) {
          return false;
        }
        const itemIds = selectRetryItemIdsByProjectIdForOwner(
          getRetryQueueItemsForSelection(this.queue, this.hiddenQueueItems),
          projectId,
          ownerUserId,
        );
        for (const itemId of this.selectPersistedProjectCleanupItemIds(
          persistedItems,
          projectId,
          ownerUserId,
        )) {
          itemIds.add(itemId);
        }
        if (itemIds.size === 0) {
          return true;
        }
        const committed = await this.removeRetryItemsDurably(
          itemIds,
          () => this.persistProjectCleanup(projectId, ownerUserId),
        );
        if (!committed) {
          this.saveToStorage();
        }
        return committed;
      },
    );
  }

  private async persistProjectCleanup(projectId: string, ownerUserId: string): Promise<boolean> {
    const writeToken = this.captureStorageLoadToken();
    if (!this.isProjectCleanupContextCurrent(writeToken, ownerUserId)) {
      return false;
    }
    if (!await this.persistNow()) {
      return false;
    }
    if (!this.isProjectCleanupContextCurrent(writeToken, ownerUserId)) {
      return false;
    }
    const db = await this.initDb();
    if (!db || !this.isProjectCleanupContextCurrent(writeToken, ownerUserId)) {
      return false;
    }
    if (!this.isProjectCleanupContextCurrent(writeToken, ownerUserId)) {
      return false;
    }
    const persistedItems = await this.readPersistedItems(db);
    return persistedItems !== null
      && this.isProjectCleanupContextCurrent(writeToken, ownerUserId)
      && this.selectPersistedProjectCleanupItemIds(
        persistedItems,
        projectId,
        ownerUserId,
      ).size === 0;
  }

  private readPersistedItems(db: IDBDatabase): Promise<PersistedRetryQueueItem[] | null> {
    return new Promise((resolve) => {
      let capturedItems: PersistedRetryQueueItem[] | null = null;
      let settled = false;
      const finish = (items: PersistedRetryQueueItem[] | null): void => {
        if (settled) return;
        settled = true;
        resolve(items);
      };
      try {
        const transaction = db.transaction(this.DB_CONFIG.storeName, 'readonly');
        const request = transaction.objectStore(this.DB_CONFIG.storeName).getAll();
        request.onsuccess = () => {
          capturedItems = Array.isArray(request.result) ? request.result : null;
        };
        request.onerror = () => finish(null);
        transaction.oncomplete = () => finish(capturedItems);
        transaction.onerror = () => finish(null);
        transaction.onabort = () => finish(null);
      } catch {
        finish(null);
      }
    });
  }

  private selectPersistedProjectCleanupItemIds(
    items: readonly PersistedRetryQueueItem[],
    projectId: string,
    ownerUserId: string,
  ): Set<string> {
    return new Set(items
      .filter(item => item.sourceUserId === ownerUserId
        && (item.projectId === projectId || (item.type === 'project' && item.data.id === projectId)))
      .map(item => item.id));
  }

  private isProjectCleanupContextCurrent(
    token: RetryQueueStorageLoadToken,
    ownerUserId: string,
  ): boolean {
    return token.ownerUserId === ownerUserId
      && this.isStorageLoadTokenCurrent(token)
      && this.isOwnerStorageLoadConfirmed(ownerUserId);
  }

  override async restoreFromBackupItems(
    items: unknown[],
    ownerUserId: string,
    policy?: RetryQueueValidatedRestorePolicy,
  ): Promise<number> {
    return localBackupUiRestoreWriterQuiescence.runAsync(
      ownerUserId, 'retry-queue', () => super.restoreFromBackupItems(items, ownerUserId, policy),
    );
  }
}
