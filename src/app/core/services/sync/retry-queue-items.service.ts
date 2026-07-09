import type { Task, Project, Connection, BlackBoxEntry } from '../../../../models';
import type { TaskWriteIntent } from '../../../../services/sync-rpc-client.service';
import { isValidUUID } from '../../../../utils/validation';
import {
  areStringArraysEqual as areStringArraysEqualPure,
  buildBlackBoxRetryDataFingerprint as buildBlackBoxRetryDataFingerprintPure,
} from './retry-queue-fingerprint';
import {
  getRetryQueueItemsForSelection,
  hasProjectRetryForOwner as hasProjectRetryForOwnerPure,
  selectConnectionRetryRemovalForDeletedTasks,
  selectProjectRetryItemIdsForOwner,
  selectProjectRetryTaskIdsToDeleteForOwner,
  selectRetryEntityRemoval,
  selectRetryItemIdsByEntityId,
  selectRetryItemIdsByProjectId,
  selectRetryItemIdsByProjectIdForOwner,
} from './retry-queue-item-selectors.helpers';
import { RetryQueueBase } from './retry-queue-base.service';
import type {
  RefreshedRetryQueueItemDraft,
  RetryQueueAddRequest,
  RetryQueueAddTarget,
  RetryQueueData,
  RetryQueueItem,
  RetryQueueLastFailure,
  TaskDeleteBaseUpdatedAtMap,
  RetryableEntityType,
  RetryableOperation,
} from './retry-queue.types';

export abstract class RetryQueueItemsLayer extends RetryQueueBase {
  // ==================== 公共 API ====================

  /**
   * 获取队列长度
   */
  get length(): number {
    return this.queue.length;
  }

  get pressureEvents(): number {
    return this.pressureEventCount;
  }

  /**
   * 获取队列副本
   */
  getItems(): RetryQueueItem[] {
    return [...this.queue];
  }

  findItemForOwner(
    type: RetryableEntityType,
    entityId: string,
    ownerUserId: string,
  ): RetryQueueItem | undefined {
    return this.getPersistedItems().find(
      item => item.type === type
        && item.data.id === entityId
        && this.resolveItemOwnerUserId(item) === ownerUserId
    );
  }

  /**
   * 检查队列中是否存在指定实体的待重试操作
   */
  hasEntity(type: RetryableEntityType, entityId: string): boolean {
    return this.queue.some(item => item.type === type && item.data.id === entityId);
  }

  /**
   * 移除队列中指定实体的待重试操作
   *
   * 用于跨队列去重：当 ActionQueue 收到同一实体的新操作时，
   * RetryQueue 中较旧的重试条目已过时，应移除以避免覆盖新数据
   *
   * @returns 是否成功移除
   */
  removeByEntity(type: RetryableEntityType, entityId: string): boolean {
    const currentOwnerUserId = this.getCurrentOwnerUserId();
    const index = this.queue.findIndex(item =>
      item.type === type
      && item.data.id === entityId
      && this.resolveItemOwnerUserId(item) === currentOwnerUserId
    );
    if (index === -1) return false;

    this.queue.splice(index, 1);
    this.touchQueueState();
    this.saveToStorage();
    this.logger.debug('跨队列去重：移除 RetryQueue 中的旧条目', {
      type,
      entityId,
      sourceUserId: currentOwnerUserId,
    });
    return true;
  }

  /**
   * 清空队列
   */
  clear(): void {
    this.queue = [];
    this.hiddenQueueItems = [];
    this.touchQueueState();
    this.clearPressureMode();
    this.saveToStorage();
    this.logger.info('重试队列已清空');
  }

  /**
   * 仅清空当前 owner 的内存视图，不覆盖持久化中的其它账号条目。
   * 用于切账号时立即断开旧账号的可见重试项，再按新 owner 重新加载。
   */
  clearCurrentView(): void {
    this.hiddenQueueItems = this.getPersistedItems();
    this.queue = [];
    this.touchQueueState();
    this.queueViewGeneration += 1;
    this.isProcessingQueue = false;
    this.lastProcessTime = 0;
    this.refreshLegacyReviewCount();
    this.clearPressureMode();
    if (this.operationHandler) {
      this.lastDrainCompletedBySuccess = false;
      try {
        this.operationHandler.onProcessingStateChange(false, 0);
      } catch (error) {
        this.logger.warn('clearCurrentView: 同步处理状态失败', error);
      }
    }
  }

  reloadFromStorageForCurrentOwner(): void {
    if (this.lifecycleClosed) {
      this.logger.debug('RetryQueue 已销毁，跳过重新加载持久化队列');
      return;
    }

    this.clearCurrentView();
    this.refreshLegacyReviewCount();
    try {
      void this.loadFromStorage().catch(error => {
        this.safeItemsWarn('RetryQueue owner 队列重新加载失败，已保留清空后的当前视图', error);
      });
    } catch (error) {
      this.safeItemsWarn('RetryQueue owner 队列重新加载失败，已保留清空后的当前视图', error);
    }
  }

  /**
   * 添加项到队列
   *
   * 特性：
   * - 去重：同一实体只保留最新操作
   * - 容量限制：达到上限时进入压力模式，但继续接收新写入（软上限）
   */
  add(
    type: RetryableEntityType,
    operation: RetryableOperation,
    data: Task | Project | Connection | BlackBoxEntry | { id: string },
    projectId?: string,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
    writeIntent?: TaskWriteIntent,
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
    lastFailure?: RetryQueueLastFailure,
  ): boolean {
    return this.addInternal(type, operation, data, projectId, sourceUserId, taskIdsToDelete, writeIntent, taskDeleteBaseUpdatedAtMap, operationId, lastFailure, 'debounced');
  }

  async addDurably(
    type: RetryableEntityType,
    operation: RetryableOperation,
    data: Task | Project | Connection | BlackBoxEntry | { id: string },
    projectId?: string,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
    writeIntent?: TaskWriteIntent,
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
    lastFailure?: RetryQueueLastFailure,
  ): Promise<boolean> {
    const previousVisibleQueue = [...this.queue];
    const previousHiddenQueue = [...this.hiddenQueueItems];
    const accepted = this.addInternal(type, operation, data, projectId, sourceUserId, taskIdsToDelete, writeIntent, taskDeleteBaseUpdatedAtMap, operationId, lastFailure, 'manual');
    if (!accepted) {
      return false;
    }

    const persisted = await this.persistNow();
    if (persisted) {
      return true;
    }

    this.queue = previousVisibleQueue;
    this.hiddenQueueItems = previousHiddenQueue;
    this.touchQueueState();
    this.saveToStorage();
    this.checkCapacityWarning();
    this.logger.warn('RetryQueue.addDurably: 持久化确认失败，已回滚内存队列', {
      type,
      operation,
      dataId: data.id,
      sourceUserId,
    });
    return false;
  }

  protected addInternal(
    type: RetryableEntityType, operation: RetryableOperation, data: RetryQueueData,
    projectId?: string, sourceUserId?: string,
    taskIdsToDelete?: string[],
    writeIntent?: TaskWriteIntent,
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string, lastFailure?: RetryQueueLastFailure,
    persistMode: 'debounced' | 'manual' = 'debounced',
  ): boolean {
    const request: RetryQueueAddRequest = {
      type,
      operation,
      data,
      projectId,
      sourceUserId,
      taskIdsToDelete,
      taskDeleteBaseUpdatedAtMap,
      writeIntent,
      operationId,
      lastFailure,
      persistMode,
    };
    if (!this.validateEnqueueData(request)) return false;

    this.tryRecoverQueueFullPressure();
    const target = this.resolveAddTargetQueue(request.sourceUserId);
    const existingIndex = this.findExistingQueueItemIndex(target, request);

    if (existingIndex !== -1) {
      return this.refreshExistingQueueItem(
        target.targetQueue,
        existingIndex,
        request.type,
        request.operation,
        request.data,
        request.projectId,
        target.targetOwnerUserId,
        request.taskIdsToDelete,
        request.writeIntent,
        request.taskDeleteBaseUpdatedAtMap,
        request.operationId,
        request.lastFailure,
        request.persistMode,
      );
    }

    if (!this.prepareForNewQueueItem(request)) return false;
    this.appendNewQueueItem(request, target);
    return true;
  }

  protected validateEnqueueData(request: RetryQueueAddRequest): boolean {
    if (!request.data?.id) {
      this.safeItemsWarn('RetryQueue.add：拒绝缺少 ID 的入队请求', { type: request.type });
      return false;
    }
    if (!isValidUUID(request.data.id)) {
      this.safeItemsWarn('RetryQueue.add：拒绝非法 UUID 格式的 ID', { type: request.type, id: request.data.id });
      return false;
    }
    return true;
  }

  protected resolveAddTargetQueue(sourceUserId: string | undefined): RetryQueueAddTarget {
    const currentOwnerUserId = this.getCurrentOwnerUserId();
    const targetOwnerUserId = sourceUserId ?? currentOwnerUserId;
    return {
      targetOwnerUserId,
      targetQueue: targetOwnerUserId !== currentOwnerUserId ? this.hiddenQueueItems : this.queue,
    };
  }

  protected findExistingQueueItemIndex(target: RetryQueueAddTarget, request: RetryQueueAddRequest): number {
    return target.targetQueue.findIndex(
      item =>
        item.type === request.type &&
        item.data.id === request.data.id &&
        this.resolveItemOwnerUserId(item) === target.targetOwnerUserId
    );
  }

  protected prepareForNewQueueItem(request: RetryQueueAddRequest): boolean {
    const absoluteLimit = this.maxQueueSize * this.MAX_QUEUE_OVERFLOW_FACTOR;
    if (this.queue.length + this.hiddenQueueItems.length >= absoluteLimit) {
      this.reportEnqueueRejected(request.type, request.operation, request.data.id, 'absolute_limit');
      this.checkCapacityWarning();
      return false;
    }

    this.warnIfQueueIsAlreadyUnderPressure();
    this.enterPressureModeWhenSoftLimitReached();
    return true;
  }

  protected warnIfQueueIsAlreadyUnderPressure(): void {
    if (!this.queuePressure()) return;
    const reason = this.queuePressureReason() ?? 'pressure_mode';
    this.safeItemsWarn('重试队列处于压力模式，仍继续接收新写入', {
      reason,
      queueSize: this.queue.length,
      maxSize: this.maxQueueSize
    });
    if (reason === 'queue_full') {
      this.triggerEmergencyProcessQueue('pressure_reject');
    }
  }

  protected enterPressureModeWhenSoftLimitReached(): void {
    if (this.queue.length < this.maxQueueSize) return;
    this.enterPressureMode('queue_full');
    this.safeItemsWarn('重试队列达到软上限，进入压力模式但继续入队', {
      queueSize: this.queue.length,
      maxSize: this.maxQueueSize
    });
    this.triggerEmergencyProcessQueue('queue_full');
  }

  private safeItemsWarn(message: string, data?: unknown): void {
    try {
      if (data === undefined) {
        this.logger.warn(message);
        return;
      }
      this.logger.warn(message, data);
    } catch {
      // RetryQueue add flow must not depend on observability sinks.
    }
  }

  protected appendNewQueueItem(request: RetryQueueAddRequest, target: RetryQueueAddTarget): void {
    const operationId = this.resolveOperationId(request);

    target.targetQueue.push({
      id: crypto.randomUUID(),
      type: request.type,
      operation: request.operation,
      data: request.data,
      projectId: request.projectId,
      retryCount: 0,
      createdAt: Date.now(),
      sourceUserId: target.targetOwnerUserId,
      operationId,
      taskIdsToDelete: request.taskIdsToDelete,
      taskDeleteBaseUpdatedAtMap: request.taskDeleteBaseUpdatedAtMap,
      writeIntent: request.writeIntent,
      lastFailure: request.lastFailure,
    });
    this.lastDrainCompletedBySuccess = false;
    this.touchQueueState();
    if (request.persistMode === 'debounced') {
      this.saveToStorage();
    }

    this.logger.debug('添加到重试队列', {
      type: request.type,
      operation: request.operation,
      dataId: request.data.id,
      hidden: target.targetQueue === this.hiddenQueueItems,
      targetOwnerUserId: target.targetOwnerUserId,
    });
    this.checkCapacityWarning();
    if (target.targetQueue === this.queue && this.queue.length >= Math.floor(this.maxQueueSize * 0.9)) {
      this.triggerEmergencyProcessQueue('high_watermark');
    }
  }

  protected resolveOperationId(request: RetryQueueAddRequest): string {
    return this.normalizeRetryQueueOperationId(request.operationId);
  }

  protected refreshExistingQueueItem(
    targetQueue: RetryQueueItem[], existingIndex: number, type: RetryableEntityType,
    operation: RetryableOperation, data: RetryQueueData, projectId: string | undefined,
    targetOwnerUserId: string, taskIdsToDelete: string[] | undefined,
    writeIntent: TaskWriteIntent | undefined,
    taskDeleteBaseUpdatedAtMap: TaskDeleteBaseUpdatedAtMap | undefined,
    operationId: string | undefined,
    lastFailure: RetryQueueLastFailure | undefined,
    persistMode: 'debounced' | 'manual',
  ): boolean {
    const existing = targetQueue[existingIndex];
    const draft = this.buildRefreshedQueueItemDraft(
      existing,
      type,
      operation,
      data,
      projectId,
      targetOwnerUserId,
      taskIdsToDelete,
      writeIntent,
      taskDeleteBaseUpdatedAtMap,
      operationId,
      lastFailure,
    );

    const isBlackBoxNoop = this.isBlackBoxRetryRefreshNoop(
      existing, operation, draft.safeData, draft.item.projectId, draft.sourceUserId, draft.taskIdsToDelete,
    );
    if (isBlackBoxNoop) {
      this.logger.debug('黑匣子重试项重复入队但 payload 未变化，跳过队列刷新', {
        entryId: data.id,
        sourceUserId: draft.sourceUserId,
      });
      return true;
    }

    if (this.isStaleRetryQueueRefresh(existing, operation, draft.safeData)) {
      this.logger.debug('忽略较旧的重试队列快照刷新，保留队列中的较新本地操作', {
        type,
        operation,
        dataId: data.id,
        sourceUserId: draft.sourceUserId,
      });
      return true;
    }

    this.applyRefreshedQueueItem(targetQueue, existingIndex, draft.item, existing, persistMode);
    return true;
  }

  private applyRefreshedQueueItem(
    targetQueue: RetryQueueItem[],
    existingIndex: number,
    item: RetryQueueItem,
    existing: RetryQueueItem,
    persistMode: 'debounced' | 'manual',
  ): void {
    targetQueue[existingIndex] = item;
    this.lastDrainCompletedBySuccess = false;
    this.touchQueueState();
    this.logger.debug('更新队列中的现有项', {
      type: item.type,
      operation: item.operation,
      dataId: item.data.id,
      retryCount: existing.retryCount,
      hidden: targetQueue === this.hiddenQueueItems,
    });
    if (persistMode === 'debounced') {
      this.saveToStorage();
    }
    this.checkCapacityWarning();
  }

  protected buildRefreshedQueueItemDraft(
    existing: RetryQueueItem, type: RetryableEntityType, operation: RetryableOperation,
    data: RetryQueueData, projectId: string | undefined, targetOwnerUserId: string,
    taskIdsToDelete: string[] | undefined,
    writeIntent: TaskWriteIntent | undefined,
    taskDeleteBaseUpdatedAtMap: TaskDeleteBaseUpdatedAtMap | undefined,
    operationId: string | undefined, lastFailure: RetryQueueLastFailure | undefined,
  ): RefreshedRetryQueueItemDraft {
    const safeData = this.preserveBlackBoxContentWhenBlankSnapshot(type, data, existing.data);
    const sourceUserId = existing.sourceUserId ?? targetOwnerUserId;
    const nextTaskIdsToDelete = taskIdsToDelete ?? existing.taskIdsToDelete;
    const nextTaskDeleteBaseUpdatedAtMap = taskDeleteBaseUpdatedAtMap ?? existing.taskDeleteBaseUpdatedAtMap;
    const nextLastFailure = this.resolveRefreshedLastFailure(existing, lastFailure);
    const nextOperationId = this.resolveOperationId({
      type,
      operation,
      data: safeData,
      projectId,
      sourceUserId: targetOwnerUserId,
      taskIdsToDelete,
      taskDeleteBaseUpdatedAtMap,
      writeIntent,
      operationId: operationId ?? existing.operationId,
      lastFailure,
      persistMode: 'debounced',
    });
    return {
      item: {
        ...existing,
        operation,
        data: safeData,
        projectId: projectId ?? existing.projectId,
        createdAt: Date.now(),
        sourceUserId,
        operationId: nextOperationId,
        taskIdsToDelete: nextTaskIdsToDelete,
        taskDeleteBaseUpdatedAtMap: nextTaskDeleteBaseUpdatedAtMap,
        writeIntent: writeIntent ?? existing.writeIntent,
        lastFailure: nextLastFailure,
      },
      safeData,
      sourceUserId,
      taskIdsToDelete: nextTaskIdsToDelete,
      taskDeleteBaseUpdatedAtMap: nextTaskDeleteBaseUpdatedAtMap,
      operationId: nextOperationId,
    };
  }

  private resolveRefreshedLastFailure(
    existing: RetryQueueItem,
    lastFailure: RetryQueueLastFailure | undefined,
  ): RetryQueueLastFailure | undefined {
    if (lastFailure !== undefined) {
      return lastFailure;
    }
    return existing.lastFailure?.remoteOutcome === 'unknown' ? existing.lastFailure : undefined;
  }

  private isStaleRetryQueueRefresh(
    existing: RetryQueueItem,
    operation: RetryableOperation,
    incoming: RetryQueueData,
  ): boolean {
    if (operation !== 'upsert') {
      return false;
    }

    const existingVersion = this.resolveRetryQueueDataVersion(existing.data);
    const incomingVersion = this.resolveRetryQueueDataVersion(incoming);
    return existingVersion !== null
      && incomingVersion !== null
      && incomingVersion < existingVersion;
  }

  private resolveRetryQueueDataVersion(data: RetryQueueData): number | null {
    const versions = [
      this.parseRetryQueueDataTimestamp(data, 'updatedAt'),
      this.parseRetryQueueDataTimestamp(data, 'deletedAt'),
      this.parseRetryQueueDataTimestamp(data, 'baseUpdatedAt'),
    ].filter((timestamp): timestamp is number => timestamp !== null);

    return versions.length === 0 ? null : Math.max(...versions);
  }

  private parseRetryQueueDataTimestamp(data: RetryQueueData, field: 'updatedAt' | 'deletedAt' | 'baseUpdatedAt'): number | null {
    if (!data || typeof data !== 'object' || !(field in data)) {
      return null;
    }

    const value = (data as unknown as Record<string, unknown>)[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      return null;
    }

    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  protected isBlackBoxRetryRefreshNoop(
    existing: RetryQueueItem,
    operation: RetryableOperation,
    incoming: RetryQueueData,
    projectId: string | undefined,
    sourceUserId: string,
    taskIdsToDelete: string[] | undefined,
  ): boolean {
    if (existing.type !== 'blackbox' || operation !== existing.operation) {
      return false;
    }

    if (existing.projectId !== projectId || this.resolveItemOwnerUserId(existing) !== sourceUserId) {
      return false;
    }

    if (!this.areStringArraysEqual(existing.taskIdsToDelete, taskIdsToDelete)) {
      return false;
    }

    return this.buildBlackBoxRetryDataFingerprint(existing.data as BlackBoxEntry)
      === this.buildBlackBoxRetryDataFingerprint(incoming as BlackBoxEntry);
  }

  protected areStringArraysEqual(left: string[] | undefined, right: string[] | undefined): boolean {
    return areStringArraysEqualPure(left, right);
  }

  protected buildBlackBoxRetryDataFingerprint(entry: BlackBoxEntry): string {
    return buildBlackBoxRetryDataFingerprintPure(entry);
  }

  protected preserveBlackBoxContentWhenBlankSnapshot(
    type: RetryableEntityType,
    incoming: RetryQueueData,
    existing: RetryQueueData,
  ): RetryQueueData {
    if (type !== 'blackbox') {
      return incoming;
    }

    const incomingEntry = incoming as BlackBoxEntry;
    const existingEntry = existing as BlackBoxEntry;
    const incomingBlank = typeof incomingEntry.content !== 'string' || incomingEntry.content.trim().length === 0;
    const existingHasContent = typeof existingEntry.content === 'string' && existingEntry.content.trim().length > 0;

    if (!incomingBlank || !existingHasContent) {
      return incoming;
    }

    this.logger.warn('RetryQueue: 黑匣子空正文快照未覆盖队列中已有正文', {
      entryId: incomingEntry.id,
    });

    return {
      ...incomingEntry,
      content: existingEntry.content,
    };
  }

  protected isTaskUpsertMissingUpdatedAt(item: RetryQueueItem): boolean {
    if (item.type !== 'task' || item.operation !== 'upsert') {
      return false;
    }

    const updatedAt = (item.data as Partial<Task>).updatedAt;
    return typeof updatedAt !== 'string' || updatedAt.trim().length === 0;
  }

  /**
   * 移除所有匹配的项
   */
  removeByEntityId(entityId: string): void {
    const itemIds = selectRetryItemIdsByEntityId(
      getRetryQueueItemsForSelection(this.queue, this.hiddenQueueItems),
      entityId,
    );

    if (itemIds.size > 0) {
      this.removeItemsFromAllViews(itemIds);
      this.saveToStorage();
    }
  }

  /** 移除指定项目相关的所有待重试项，用于冲突解决后的旧 mutation 收口 */
  removeByProjectId(projectId: string): number {
    const itemIds = selectRetryItemIdsByProjectId(
      getRetryQueueItemsForSelection(this.queue, this.hiddenQueueItems),
      projectId,
    );

    const removedCount = itemIds.size;
    if (removedCount > 0) {
      this.removeItemsFromAllViews(itemIds);
      this.saveToStorage();
    }
    return removedCount;
  }

  removeByProjectIdForOwner(projectId: string, sourceUserId?: string): number {
    const itemIds = selectRetryItemIdsByProjectIdForOwner(
      getRetryQueueItemsForSelection(this.queue, this.hiddenQueueItems),
      projectId,
      sourceUserId,
    );

    const removedCount = itemIds.size;
    if (removedCount > 0) {
      this.removeItemsFromAllViews(itemIds);
      this.saveToStorage();
    }
    return removedCount;
  }

  removeByEntities(type: RetryableEntityType, entityIds: string[]): string[] {
    const selection = selectRetryEntityRemoval(
      getRetryQueueItemsForSelection(this.queue, this.hiddenQueueItems),
      type,
      entityIds,
    );

    if (selection.itemIds.size > 0) {
      this.removeItemsFromAllViews(selection.itemIds);
      this.saveToStorage();
    }

    return selection.removedEntityIds;
  }

  removeProjectRetriesForOwner(projectId: string, sourceUserId?: string): number {
    const itemIds = selectProjectRetryItemIdsForOwner(
      getRetryQueueItemsForSelection(this.queue, this.hiddenQueueItems),
      projectId,
      sourceUserId,
    );

    const removedCount = itemIds.size;
    if (removedCount > 0) {
      this.removeItemsFromAllViews(itemIds);
      this.saveToStorage();
    }

    return removedCount;
  }

  hasProjectRetryForOwner(projectId: string, sourceUserId?: string): boolean {
    return hasProjectRetryForOwnerPure(
      getRetryQueueItemsForSelection(this.queue, this.hiddenQueueItems),
      projectId,
      sourceUserId,
    );
  }

  getProjectRetryTaskIdsToDeleteForOwner(projectId: string, sourceUserId?: string): string[] | undefined {
    return selectProjectRetryTaskIdsToDeleteForOwner(
      getRetryQueueItemsForSelection(this.queue, this.hiddenQueueItems),
      projectId,
      sourceUserId,
    );
  }

  removeConnectionsReferencingTasks(projectId: string, taskIds: string[]): string[] {
    const selection = selectConnectionRetryRemovalForDeletedTasks(
      getRetryQueueItemsForSelection(this.queue, this.hiddenQueueItems),
      projectId,
      taskIds,
    );

    if (selection.itemIds.size > 0) {
      this.removeItemsFromAllViews(selection.itemIds);
      this.saveToStorage();
    }

    return selection.removedConnectionIds;
  }

  /**
   * 清理过期和超过重试限制的项
   */
  cleanExpired(): number {
    const now = Date.now();
    const originalLength = this.queue.length;
    const originalHiddenLength = this.hiddenQueueItems.length;

    const shouldKeep = (item: RetryQueueItem): boolean => {
      const isExpired = now - item.createdAt > this.MAX_ITEM_AGE;
      const isMaxRetried = item.retryCount >= this.MAX_RETRIES;

      if (isExpired) {
        this.logger.debug('清理过期项', {
          type: item.type,
          id: item.data.id,
          ageHours: Math.floor((now - item.createdAt) / 1000 / 60 / 60)
        });
        return false;
      }

      if (isMaxRetried) {
        this.logger.debug('清理超过重试限制的项', {
          type: item.type,
          id: item.data.id,
          retryCount: item.retryCount
        });
        return false;
      }

      return true;
    };

    this.queue = this.queue.filter(shouldKeep);
    // 同步清理隐藏队列（其它账号的过期条目），防止长期内存/存储泄漏
    this.hiddenQueueItems = this.hiddenQueueItems.filter(shouldKeep);

    const cleaned = (originalLength - this.queue.length) + (originalHiddenLength - this.hiddenQueueItems.length);
    if (cleaned > 0) {
      this.touchQueueState();
      this.saveToStorage();
      this.logger.info('清理队列', { cleaned, remaining: this.queue.length, hiddenRemaining: this.hiddenQueueItems.length });
    }

    return cleaned;
  }
}
