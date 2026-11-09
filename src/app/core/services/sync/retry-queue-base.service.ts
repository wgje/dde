import { DestroyRef, inject, signal } from '@angular/core';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { AuthService } from '../../../../services/auth.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { BlackBoxSyncService } from '../../../../services/black-box-sync.service';
import { WriteGuardService } from '../../../../services/write-guard.service';
import { SyncWriterLeaseService } from '../../../../services/sync-writer-lease.service';
import { SYNC_CONFIG } from '../../../../config';
import { AUTH_CONFIG } from '../../../../config/auth.config';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { createDerivedSyncOperationId, createSyncOperationId, isSyncOperationId } from '../../../../utils/sync-operation-id';
import {
  normalizeBackupRetryQueueItem,
  resolveRetryQueueBackupRestoreValidationNow,
  type RetryQueueValidatedRestorePolicy,
  validateRetryQueueBackupRestoreRequest,
} from './retry-queue-backup-restore.helpers';
import { buildRefreshFingerprint as buildRefreshFingerprintPure } from './retry-queue-fingerprint';
import {
  dedupeRetryQueueItemsByEntity,
  selectRetryQueueEntityWinner as selectRetryQueueEntityWinnerPure,
} from './retry-queue-item-selection';
import type {
  PersistedRetryQueueItem,
  RetryOperationHandler,
  RetryQueueItem,
  RetryQueueSliceOptions,
  RetryQueueSliceResult,
  RetryQueueStorageLoadToken,
  RetryableEntityType,
  RetryableOperation,
} from './retry-queue.types';

interface RetryQueueOwnerStorageLoadRecord {
  generation: number;
  state: 'loading' | 'loaded' | 'unknown';
}

const LEGACY_RETRY_QUEUE_OPERATION_ID_PURPOSE = 'legacy-retry-queue-operation-id';
const RETRY_QUEUE_COMPLETION_MARKER_STORAGE_KEY = 'nanoflow.retry-queue.completed-operations';
const RETRY_QUEUE_COMPLETION_MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_QUEUE_COMPLETION_MARKER_MAX_RECORDS = 500;

interface RetryQueueCompletionMarkerRecord {
  key: string;
  ownerUserId: string;
  operationId: string;
  type: RetryableEntityType;
  operation: RetryableOperation;
  entityId: string;
  completedAt: number;
}

const RETRY_QUEUE_COMPLETION_MARKER_ENTITY_TYPES = new Set<RetryableEntityType>([
  'task',
  'project',
  'connection',
  'blackbox',
]);
const RETRY_QUEUE_COMPLETION_MARKER_OPERATIONS = new Set<RetryableOperation>([
  'upsert',
  'delete',
]);

function isRetryQueueCompletionMarkerRecord(
  value: unknown,
): value is RetryQueueCompletionMarkerRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<keyof RetryQueueCompletionMarkerRecord, unknown>;
  return typeof record.key === 'string'
    && typeof record.ownerUserId === 'string'
    && typeof record.operationId === 'string'
    && RETRY_QUEUE_COMPLETION_MARKER_ENTITY_TYPES.has(record.type as RetryableEntityType)
    && RETRY_QUEUE_COMPLETION_MARKER_OPERATIONS.has(record.operation as RetryableOperation)
    && typeof record.entityId === 'string'
    && typeof record.completedAt === 'number'
    && Number.isFinite(record.completedAt);
}

export abstract class RetryQueueBase {

  protected readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  protected readonly loggerService = inject(LoggerService);
  protected readonly logger = this.loggerService.category('RetryQueue');
  protected readonly toast = inject(ToastService);
  protected readonly authService = inject(AuthService);
  protected readonly projectState = inject(ProjectStateService);
  protected readonly blackBoxSync = inject(BlackBoxSyncService);
  protected readonly destroyRef = inject(DestroyRef);
  /**
   * 写入闸门：迁移期 export-only / read-only 部署 gate 云端 flush。
   * 标记 optional：测试 harness 通常不提供，保持向后兼容。
   * 缺失时默认为可写（与迁移前行为一致）。
   */
  protected readonly writeGuard = inject(WriteGuardService, { optional: true });
  protected readonly syncWriterLease = inject(SyncWriterLeaseService, { optional: true });

  /** 重试队列 */
  protected queue: RetryQueueItem[] = [];
  /** 当前 owner 不可见但仍需保留的其它账号条目 */
  protected hiddenQueueItems: RetryQueueItem[] = [];
  private readonly pendingWriteStateListeners = new Set<() => void>();
  /** 本实例已经确认从内存视图移除的 item，用于 fallback 合并时避免复活旧 localStorage 快照 */
  protected locallyRemovedRetryItemIds = new Set<string>();

  /** IndexedDB 数据库实例 */
  protected db: IDBDatabase | null = null;
  protected dbInitPromise: Promise<IDBDatabase | null> | null = null;
  protected idbUnsupported = false;

  /** IndexedDB 配置 */
  protected readonly DB_CONFIG = {
    name: 'nanoflow-retry-queue',
    version: 1,
    storeName: 'offline_mutation_queue'
  };

  /** 最大重试次数 */
  readonly MAX_RETRIES = 5;

  /** localStorage 降级场景的队列上限 */
  protected readonly MAX_SIZE_LOCAL = SYNC_CONFIG.MAX_RETRY_QUEUE_SIZE;
  /** IndexedDB 正常场景的队列上限（容量更高） */
  protected readonly MAX_SIZE_INDEXEDDB = SYNC_CONFIG.MAX_RETRY_QUEUE_SIZE_INDEXEDDB;
  /** 当前生效的队列上限 */
  protected maxQueueSize: number = this.MAX_SIZE_LOCAL;
  /** 软上限溢出倍数（防止内存无限增长） */
  protected readonly MAX_QUEUE_OVERFLOW_FACTOR = 5;

  /** 重试项最大年龄（毫秒，24 小时） */
  protected readonly MAX_ITEM_AGE = SYNC_CONFIG.MAX_RETRY_ITEM_AGE;

  /** 队列容量预警阈值 */
  protected readonly WARNING_THRESHOLD = 0.8;

  /** 容量警告冷却时间（毫秒） */
  protected readonly WARNING_COOLDOWN = 300_000; // 5 分钟

  /** 上次显示容量警告的时间戳 */
  protected lastWarningTime = 0;

  /** 上次警告时的队列使用百分比 */
  protected lastWarningPercent = 0;
  /** 入队拒绝提示冷却（防止告警风暴） */
  protected readonly ENQUEUE_REJECT_COOLDOWN = 60_000;
  protected lastEnqueueRejectTime = 0;
  /** 存储压力恢复探测冷却，避免频繁触发写探测 */
  protected readonly STORAGE_RECOVERY_COOLDOWN = 30_000;
  protected lastStorageRecoveryAttempt = 0;

  /** 操作处理器 */
  protected operationHandler: RetryOperationHandler | null = null;
  /** 队列处理锁 */
  protected isProcessingQueue = false;
  /** 当前可见队列视图代次；切账号清空时递增以作废旧处理锁 */
  protected queueViewGeneration = 0;
  /** 最近一次 onProcessingStateChange(false) 是否由成功回放见底触发 */
  protected lastDrainCompletedBySuccess = false;
  /**
   * 最近一次 drain 是否包含终态拒绝（版本冲突、tombstone 等）。
   *
   * 【Layer 5 根因修复 2026-05-16】此前 `drainCompletedBySuccessfulReplay` 依赖 `!hadTerminalRemoval`，
   * 导致"5 成功 + 1 终态"混合场景永远不能 drain，UI 红条永久残留。
   * 拆分语义：成功 drain 只看队列见底 + 真实 replay，终态独立标记走 syncError 真错误通道。
   */
  protected lastDrainHadTerminalConflict = false;
  /** 队列内存态代次；本地新增/删除/切账号后用于作废晚到的存储加载结果 */
  protected queueStateGeneration = 0;
  private readonly ownerStorageLoadRecords = new Map<string, RetryQueueOwnerStorageLoadRecord>();
  protected lifecycleClosed = false;
  protected lastProcessTime = 0;
  /** 队列处理超时保护（120s）—— 副作用是释放 isProcessingQueue 死锁 */
  protected readonly PROCESS_TIMEOUT = 120_000;
  /** 重试循环定时器 */
  protected retryLoopTimer: ReturnType<typeof setInterval> | null = null;
  /** 熔断器状态 */
  protected circuitState: 'closed' | 'open' | 'half-open' = 'closed';
  protected consecutiveFailures = 0;
  protected circuitOpenedAt = 0;

  /** saveToStorage 防抖定时器，避免高频 IDB 写入风暴 */
  protected saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  protected readonly SAVE_DEBOUNCE_MS = 500;

  /** 持久化 key */
  protected readonly STORAGE_KEY = 'nanoflow.retry-queue';

  /** 版本号 */
  protected readonly VERSION = 1;
  protected readonly LEGACY_REVIEW_STORAGE_KEY_PREFIX = 'nanoflow.retry-queue.legacy-review.';
  /** 队列压力状态 */
  readonly queuePressure = signal(false);
  readonly queuePressureReason = signal<string | null>(null);
  readonly legacyReviewCount = signal(0);
  protected pressureEventCount = 0;
  protected legacyReviewWarningShown = false;

  protected getCurrentOwnerUserId(): string {
    return this.authService.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  protected isCloudBackedUserId(userId: string | null | undefined): userId is string {
    return typeof userId === 'string' && userId.length > 0 && userId !== AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  protected getPersistedOwnerHint(): string | null {
    const hintedUserId = this.authService.peekPersistedOwnerHint();
    if (typeof hintedUserId === 'string' && hintedUserId.length > 0) {
      return hintedUserId;
    }

    const sessionIdentity = this.authService.peekPersistedSessionIdentity();
    return typeof sessionIdentity?.userId === 'string' && sessionIdentity.userId.length > 0
      ? sessionIdentity.userId
      : null;
  }

  protected shouldSilentlyDropUnownedLegacyRetryItem(): boolean {
    const currentUserId = this.authService.currentUserId();
    if (this.isCloudBackedUserId(currentUserId)) {
      return false;
    }

    return !this.isCloudBackedUserId(this.getPersistedOwnerHint());
  }

  protected resolveItemOwnerUserId(item: RetryQueueItem): string {
    return item.sourceUserId ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  protected partitionItemsForCurrentOwner(items: RetryQueueItem[]): {
    visible: RetryQueueItem[];
    hidden: RetryQueueItem[];
  } {
    const currentOwnerUserId = this.getCurrentOwnerUserId();
    const visible: RetryQueueItem[] = [];
    const hidden: RetryQueueItem[] = [];

    for (const item of items) {
      if (this.resolveItemOwnerUserId(item) === currentOwnerUserId) {
        visible.push(item);
        continue;
      }

      hidden.push(item);
    }

    return { visible, hidden };
  }

  protected applyLoadedItems(items: RetryQueueItem[]): number {
    const { items: dedupedItems, removedCount } = dedupeRetryQueueItemsByEntity(
      items,
      item => this.getRetryQueueRestoreEntityKey(item),
      (currentWinner, incoming) => this.selectRetryQueueEntityWinner(currentWinner, incoming),
    );
    const { visible, hidden } = this.partitionItemsForCurrentOwner(dedupedItems);
    this.queue = visible;
    this.hiddenQueueItems = hidden;
    this.touchQueueState();
    if (removedCount > 0) {
      this.logger.warn('RetryQueue 加载：已合并同实体重复项，避免重复重放', { removedCount });
    }
    return removedCount;
  }

  protected selectRetryQueueEntityWinner(
    currentWinner: RetryQueueItem,
    incoming: RetryQueueItem,
    options: { preferCurrentOnTie?: boolean } = {},
  ): RetryQueueItem {
    return selectRetryQueueEntityWinnerPure(currentWinner, incoming, options);
  }

  protected touchQueueState(): void {
    this.queueStateGeneration += 1;
    this.notifyPendingWriteStateListeners();
  }

  subscribeToPendingWriteStateChanges(listener: () => void): () => void {
    this.pendingWriteStateListeners.add(listener);
    return () => this.pendingWriteStateListeners.delete(listener);
  }

  protected markOwnerStorageLoadStarted(token: RetryQueueStorageLoadToken): void {
    this.ownerStorageLoadRecords.set(token.ownerUserId, {
      generation: token.queueStateGeneration,
      state: 'loading',
    });
  }

  protected markOwnerStorageLoadSucceeded(token: RetryQueueStorageLoadToken): void {
    this.updateOwnerStorageLoadRecord(token, 'loaded');
  }

  protected markOwnerStorageLoadFailed(token: RetryQueueStorageLoadToken): void {
    this.updateOwnerStorageLoadRecord(token, 'unknown');
  }

  protected markCurrentOwnerStorageLoadUnknown(): void {
    if (this.ownerStorageLoadRecords.delete(this.getCurrentOwnerUserId())) {
      this.notifyPendingWriteStateListeners();
    }
  }

  protected isOwnerStorageLoadConfirmed(ownerUserId: string): boolean {
    return this.ownerStorageLoadRecords.get(ownerUserId)?.state === 'loaded';
  }

  private updateOwnerStorageLoadRecord(
    token: RetryQueueStorageLoadToken,
    state: RetryQueueOwnerStorageLoadRecord['state'],
  ): void {
    const current = this.ownerStorageLoadRecords.get(token.ownerUserId);
    if (current?.generation !== token.queueStateGeneration) return;
    this.ownerStorageLoadRecords.set(token.ownerUserId, {
      generation: token.queueStateGeneration,
      state,
    });
    this.notifyPendingWriteStateListeners();
  }

  private notifyPendingWriteStateListeners(): void {
    for (const listener of this.pendingWriteStateListeners) {
      try {
        listener();
      } catch (error) {
        this.logger.warn('RetryQueue pending-write 状态监听器失败，已隔离', error);
      }
    }
  }

  protected captureStorageLoadToken(): {
    ownerUserId: string;
    queueStateGeneration: number;
    lifecycleClosed: boolean;
  } {
    return {
      ownerUserId: this.getCurrentOwnerUserId(),
      queueStateGeneration: this.queueStateGeneration,
      lifecycleClosed: this.lifecycleClosed,
    };
  }

  protected isStorageLoadTokenCurrent(token: {
    ownerUserId: string;
    queueStateGeneration: number;
    lifecycleClosed: boolean;
  }): boolean {
    return token.ownerUserId === this.getCurrentOwnerUserId()
      && token.queueStateGeneration === this.queueStateGeneration
      && token.lifecycleClosed === this.lifecycleClosed
      && !this.lifecycleClosed;
  }

  protected logStaleStorageLoad(token: {
    ownerUserId: string;
    queueStateGeneration: number;
    lifecycleClosed: boolean;
  }, stage: string): void {
    this.logger.debug('忽略过期的重试队列加载结果', {
      stage,
      expectedOwnerUserId: token.ownerUserId,
      currentOwnerUserId: this.getCurrentOwnerUserId(),
      expectedQueueStateGeneration: token.queueStateGeneration,
      currentQueueStateGeneration: this.queueStateGeneration,
      expectedLifecycleClosed: token.lifecycleClosed,
      currentLifecycleClosed: this.lifecycleClosed,
    });
  }

  protected sanitizeLoadedItems(items: PersistedRetryQueueItem[]): {
    safeItems: RetryQueueItem[];
    removedCount: number;
    repairedOperationIdCount: number;
  } {
    const safeItems: RetryQueueItem[] = [];
    let removedCount = 0;
    let repairedOperationIdCount = 0;

    for (const item of items) {
      const hasValidOperationId = isSyncOperationId(item.operationId);
      const safeItem = this.ensureLoadedItemOperationId(item);
      if (!hasValidOperationId) {
        repairedOperationIdCount++;
      }
      if (!item.sourceUserId) {
        if (this.shouldSilentlyDropUnownedLegacyRetryItem()) {
          this.logger.info('本地/匿名模式下清理缺少来源元数据的 legacy 重试残留，跳过待确认提示', {
            itemId: item.id,
            type: item.type,
            operation: item.operation,
          });
        } else {
          this.quarantineLegacyRetryItem(safeItem, 'legacy 重试项缺少来源元数据，加载时已隔离');
        }
        removedCount++;
        continue;
      }

      if (this.hasCompletedRetryQueueOperation(safeItem)) {
        removedCount++;
        continue;
      }

      safeItems.push(safeItem);
    }

    return { safeItems, removedCount, repairedOperationIdCount };
  }

  protected ensureLoadedItemOperationId(item: PersistedRetryQueueItem): RetryQueueItem {
    const operationId = this.normalizeRetryQueueOperationId(item.operationId);
    if (operationId === item.operationId) {
      return item as RetryQueueItem;
    }

    return {
      ...item,
      operationId,
    };
  }

  protected normalizeRetryQueueOperationId(operationId: string | undefined): string {
    if (typeof operationId !== 'string' || operationId.length === 0) {
      return createSyncOperationId();
    }

    if (isSyncOperationId(operationId)) {
      return operationId;
    }

    return createDerivedSyncOperationId(operationId, LEGACY_RETRY_QUEUE_OPERATION_ID_PURPOSE);
  }

  protected getPersistedItems(): RetryQueueItem[] {
    const merged = new Map<string, RetryQueueItem>();
    for (const item of [...this.hiddenQueueItems, ...this.queue]) {
      merged.set(item.id, item);
    }
    return Array.from(merged.values());
  }

  protected hasCompletedRetryQueueOperation(item: RetryQueueItem): boolean {
    const markerKey = this.buildRetryQueueCompletionMarkerKey(item);
    return this.loadRetryQueueCompletionMarkers()
      .some(marker => marker.key === markerKey);
  }

  protected persistCompletedRetryQueueOperation(item: RetryQueueItem): boolean {
    const marker: RetryQueueCompletionMarkerRecord = {
      key: this.buildRetryQueueCompletionMarkerKey(item),
      ownerUserId: this.resolveItemOwnerUserId(item),
      operationId: item.operationId,
      type: item.type,
      operation: item.operation,
      entityId: item.data.id,
      completedAt: Date.now(),
    };
    const existingMarkers = this.loadRetryQueueCompletionMarkers()
      .filter(record => record.key !== marker.key);
    return this.saveRetryQueueCompletionMarkers([...existingMarkers, marker]);
  }

  private buildRetryQueueCompletionMarkerKey(item: RetryQueueItem): string {
    return [
      this.resolveItemOwnerUserId(item),
      item.type,
      item.operation,
      item.data.id,
      item.operationId,
    ].join('::');
  }

  private loadRetryQueueCompletionMarkers(): RetryQueueCompletionMarkerRecord[] {
    if (typeof localStorage === 'undefined') {
      return [];
    }

    try {
      const raw = localStorage.getItem(RETRY_QUEUE_COMPLETION_MARKER_STORAGE_KEY);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return this.pruneRetryQueueCompletionMarkers(
        parsed.filter(isRetryQueueCompletionMarkerRecord),
      );
    } catch (error) {
      this.logger.warn('RetryQueue completion marker 读取失败，忽略本地完成标记', error);
      return [];
    }
  }

  private saveRetryQueueCompletionMarkers(markers: RetryQueueCompletionMarkerRecord[]): boolean {
    if (typeof localStorage === 'undefined') {
      return false;
    }

    try {
      localStorage.setItem(
        RETRY_QUEUE_COMPLETION_MARKER_STORAGE_KEY,
        JSON.stringify(this.pruneRetryQueueCompletionMarkers(markers)),
      );
      return true;
    } catch (error) {
      this.logger.warn('RetryQueue completion marker 持久化失败', error);
      return false;
    }
  }

  private pruneRetryQueueCompletionMarkers(
    markers: RetryQueueCompletionMarkerRecord[],
  ): RetryQueueCompletionMarkerRecord[] {
    const minCompletedAt = Date.now() - RETRY_QUEUE_COMPLETION_MARKER_TTL_MS;
    return markers
      .filter(marker => marker.completedAt >= minCompletedAt)
      .sort((left, right) => left.completedAt - right.completedAt)
      .slice(-RETRY_QUEUE_COMPLETION_MARKER_MAX_RECORDS);
  }

  /**
   * 同步当前可见队列长度到外部 SyncState。
   *
   * 需要放在 base 层，因为备份恢复、存储加载和 handler 绑定都会触发队列视图变化。
   */
  protected syncPendingCountToState(): void {
    if (!this.operationHandler) {
      return;
    }

    this.lastDrainCompletedBySuccess = false;
    try {
      this.operationHandler.onProcessingStateChange(false, this.queue.length);
      this.logger.debug('RetryQueue: 同步队列长度到 SyncState', { queueLength: this.queue.length });
    } catch (error) {
      this.logger.warn('RetryQueue: 同步队列长度失败', error);
    }
  }

  async restoreFromBackupItems(
    items: unknown[],
    ownerUserId: string,
    policy?: RetryQueueValidatedRestorePolicy,
  ): Promise<number> {
    const restoredItems = this.extractRestorableBackupRetryQueueItems(items, ownerUserId, policy);
    if (restoredItems.length === 0) {
      return 0;
    }

    const previousQueue = this.queue;
    const previousHiddenQueueItems = this.hiddenQueueItems;
    const previousDrainCompletedBySuccess = this.lastDrainCompletedBySuccess;
    const mergeResult = this.mergeRestoredRetryQueueItems(this.getPersistedItems(), restoredItems);
    if (mergeResult.restoredCount === 0) {
      return 0;
    }

    this.applyLoadedItems(mergeResult.items);
    this.lastDrainCompletedBySuccess = false;
    this.syncPendingCountToState();

    if (await this.saveToStorageImmediate()) {
      return mergeResult.restoredCount;
    }

    this.queue = previousQueue;
    this.hiddenQueueItems = previousHiddenQueueItems;
    this.lastDrainCompletedBySuccess = previousDrainCompletedBySuccess;
    this.touchQueueState();
    this.syncPendingCountToState();
    this.logger.warn('RetryQueue 备份恢复持久化失败，已回滚内存队列', {
      ownerUserId,
      attemptedRestoreCount: mergeResult.restoredCount,
    });
    return 0;
  }

  private extractRestorableBackupRetryQueueItems(
    items: unknown[],
    ownerUserId: string,
    policy?: RetryQueueValidatedRestorePolicy,
  ): RetryQueueItem[] {
    if (!validateRetryQueueBackupRestoreRequest(items, ownerUserId, policy !== undefined)) {
      return [];
    }

    const validatedNow = resolveRetryQueueBackupRestoreValidationNow(policy);
    const now = validatedNow ?? Date.now();
    const restorable: RetryQueueItem[] = [];
    for (const item of items) {
      const normalized = normalizeBackupRetryQueueItem(
        item,
        ownerUserId,
        now,
        { maxItemAge: this.MAX_ITEM_AGE, maxRetries: this.MAX_RETRIES },
        policy !== undefined,
      );
      if (normalized.status === 'restorable') {
        restorable.push(this.ensureLoadedItemOperationId(normalized.item));
      } else if (normalized.status === 'terminal') {
        // Legacy restore keeps terminal evidence; validated restore rejects before this branch.
        void this.persistTerminalRetryEvidence(
          this.ensureLoadedItemOperationId(normalized.item),
          normalized.reason,
        );
      }
    }
    return restorable;
  }

  private mergeRestoredRetryQueueItems(
    currentItems: RetryQueueItem[],
    restoredItems: RetryQueueItem[],
  ): { items: RetryQueueItem[]; restoredCount: number } {
    const mergedItems = [...currentItems];
    const currentIdentities = new Set(currentItems.map(item => this.getRetryQueueRestoreIdentity(item)));
    const currentEntityKeys = new Set(currentItems.map(item => this.getRetryQueueRestoreEntityKey(item)));
    const restoredEntityIndexes = new Map<string, number>();

    for (const restoredItem of restoredItems) {
      const identity = this.getRetryQueueRestoreIdentity(restoredItem);
      if (currentIdentities.has(identity)) {
        continue;
      }

      const entityKey = this.getRetryQueueRestoreEntityKey(restoredItem);
      if (currentEntityKeys.has(entityKey)) {
        continue;
      }

      const existingRestoredIndex = restoredEntityIndexes.get(entityKey);
      if (existingRestoredIndex !== undefined) {
        const existingRestoredItem = mergedItems[existingRestoredIndex];
        if (existingRestoredItem && restoredItem.createdAt >= existingRestoredItem.createdAt) {
          mergedItems[existingRestoredIndex] = restoredItem;
        }
        continue;
      }

      restoredEntityIndexes.set(entityKey, mergedItems.length);
      currentIdentities.add(identity);
      mergedItems.push(restoredItem);
    }

    return {
      items: mergedItems,
      restoredCount: restoredEntityIndexes.size,
    };
  }

  private getRetryQueueRestoreIdentity(item: RetryQueueItem): string {
    return item.operationId.length > 0 ? `operation:${item.operationId}` : `queue:${item.id}`;
  }

  private getRetryQueueRestoreEntityKey(item: RetryQueueItem): string {
    return [
      this.resolveItemOwnerUserId(item),
      item.type,
      item.data.id,
    ].join(':');
  }

  protected findPersistedItemByQueueId(queueItemId: string): RetryQueueItem | undefined {
    return this.getPersistedItems().find(item => item.id === queueItemId);
  }

  protected buildRefreshFingerprint(item: RetryQueueItem): string {
    return buildRefreshFingerprintPure(item);
  }

  protected wasItemRefreshedDuringProcessing(item: RetryQueueItem): boolean {
    const current = this.findPersistedItemByQueueId(item.id);
    if (!current) {
      return false;
    }

    // 【2026-04-21 漏洞 C 修复】避免对象引用比较造成的假阳性，同时补上同毫秒刷新场景：
    // addInternal 会重写 createdAt，但极快的覆盖更新可能与旧项落在同一毫秒。
    // 因此改用仅含标量字段的刷新指纹，并额外纳入 updatedAt/deletedAt/taskIdsToDelete，
    // 既避免 loadFromStorage 浅复制误判，又能识别真实的新快照覆盖旧 in-flight 项。
    return this.buildRefreshFingerprint(current) !== this.buildRefreshFingerprint(item);
  }

  protected getRefreshedItemDuringProcessing(item: RetryQueueItem): RetryQueueItem | null {
    const current = this.findPersistedItemByQueueId(item.id);
    if (!current || this.buildRefreshFingerprint(current) === this.buildRefreshFingerprint(item)) {
      return null;
    }

    return current;
  }

  protected removeItemsFromAllViews(itemIds: Set<string>): void {
    if (itemIds.size === 0) {
      return;
    }

    for (const itemId of itemIds) {
      this.locallyRemovedRetryItemIds.add(itemId);
    }
    this.queue = this.queue.filter(item => !itemIds.has(item.id));
    this.hiddenQueueItems = this.hiddenQueueItems.filter(item => !itemIds.has(item.id));
    this.touchQueueState();
  }

  protected clearLocallyRemovedRetryItemIds(itemIds: Set<string>): void {
    for (const itemId of itemIds) {
      this.locallyRemovedRetryItemIds.delete(itemId);
    }
  }

  protected abstract saveToStorage(): void;
  protected abstract saveToStorageImmediate(): Promise<boolean>;
  protected abstract saveToStorageSync(): void;
  protected abstract saveToLocalStorage(): boolean;
  protected abstract initDb(): Promise<IDBDatabase | null>;
  protected abstract loadFromStorage(): Promise<void>;
  abstract persistNow(): Promise<boolean>;
  abstract closeStorageConnections(): Promise<void>;
  abstract processQueue(maxItems?: number, manualTrigger?: boolean): Promise<void>;
  abstract processQueueSlice(options?: RetryQueueSliceOptions): Promise<RetryQueueSliceResult>;
  abstract checkCapacityWarning(): void;
  abstract getTypeBreakdown(): Record<string, number>;
  abstract refreshLegacyReviewCount(): void;
  protected abstract reportEnqueueRejected(
    type: RetryableEntityType,
    operation: RetryableOperation,
    dataId: string,
    reason: string,
  ): void;
  protected abstract tryRecoverQueueFullPressure(force?: boolean): void;
  protected abstract enterPressureMode(reason: string): void;
  protected abstract clearPressureMode(): void;
  protected abstract triggerEmergencyProcessQueue(trigger: 'queue_full' | 'pressure_reject' | 'high_watermark'): void;
  protected abstract quarantineLegacyRetryItem(item: RetryQueueItem, reason: string): boolean;
  protected abstract markBlackBoxTerminalConflict(item: RetryQueueItem, reason: string): Promise<boolean>;
  protected abstract persistTerminalRetryEvidence(item: RetryQueueItem, reason: string): Promise<boolean>;
  abstract checkCircuitBreaker(): boolean;
  abstract recordCircuitSuccess(): void;
  abstract recordCircuitFailure(errorType: string): void;
  abstract startLoop(intervalMs: number): void;
  abstract stopLoop(): void;

}
