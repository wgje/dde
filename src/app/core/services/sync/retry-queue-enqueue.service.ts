/**
 * RetryQueueEnqueueService
 *
 * 从 SimpleSyncService「下切」出的「重试队列入队（带守卫）」薄聚合服务。
 *
 * 职责单一：
 * - addToRetryQueue / addToRetryQueueDurably：会话过期守卫 + 数据有效性校验
 *   （id / projectId）+ RetryQueueService.addDurably + pendingCount 同步 / 队列满错误
 * - clearRetryQueue：清空重试队列 + 复位 pendingCount + 用户提示
 * - hasRetryQueueEntity：查询 RetryQueue 是否已含某实体（防御式可选方法）
 * - markSyncRecoveredIfIdle / hasPendingRetryRecovery：成功回放见底标志（drain flag）读写
 *
 * 为什么抽离：
 * - AGENTS.md §12 单文件 ≤ 800 行硬线；SimpleSyncService 长期越界，文件头要求只做「下切」。
 * - 本簇零 facade-only 依赖（LoggerService / RetryQueueService / SyncStateService 全可注入），
 *   故无回调结：协调器的 durableRetryHandler 与 BatchSync 回调经门面同名 delegate 中转即可。
 *
 * 验证：SimpleSyncService.spec 通过公开 API `addToRetryQueue(...)` 用例覆盖；门面保留同名
 * delegate（addToRetryQueue / addToRetryQueueDurably 公开、hasRetryQueueEntity 私有）后零回归。
 */
import { Injectable, inject } from '@angular/core';
import { Task, Project, Connection } from '../../../../models';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import {
  RetryQueueService,
  type RetryQueueLastFailure,
  type TaskDeleteBaseUpdatedAtMap,
  type RetryableEntityType,
  type RetryableOperation,
} from './retry-queue.service';
import type { TaskWriteIntent } from '../../../../services/sync-rpc-client.service';
import { SyncStateService } from './sync-state.service';
import { RECOVERABLE_SYNC_ERROR_MESSAGES } from '../../../../config/sync.config';
import { nowISO } from '../../../../utils/date';
import type { RetryQueueItem } from './retry-queue.types';
import { getOfflineSyncCaptureHooks } from './offline-sync-capture-registry';

@Injectable({ providedIn: 'root' })
export class RetryQueueEnqueueService {
  private readonly logger = inject(LoggerService).category('RetryQueueEnqueue');
  private readonly retryQueueService = inject(RetryQueueService);
  private readonly syncStateService = inject(SyncStateService);
  private readonly toast = inject(ToastService);

  private get syncState() {
    return this.syncStateService.syncState;
  }

  async addToRetryQueue(
    type: RetryableEntityType,
    operation: RetryableOperation,
    data: Task | Project | Connection | { id: string },
    projectId?: string,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
    writeIntent?: TaskWriteIntent,
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
    lastFailure?: RetryQueueLastFailure,
  ): Promise<boolean> {
    return lastFailure === undefined
      ? this.addToRetryQueueDurably(
          type,
          operation,
          data,
          projectId,
          sourceUserId,
          taskIdsToDelete,
          writeIntent,
          taskDeleteBaseUpdatedAtMap,
          operationId,
        )
      : this.addToRetryQueueDurably(
          type,
          operation,
          data,
          projectId,
          sourceUserId,
          taskIdsToDelete,
          writeIntent,
          taskDeleteBaseUpdatedAtMap,
          operationId,
          lastFailure,
        );
  }

  async addToRetryQueueDurably(
    type: RetryableEntityType,
    operation: RetryableOperation,
    data: Task | Project | Connection | { id: string },
    projectId?: string,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
    writeIntent?: TaskWriteIntent,
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
    lastFailure?: RetryQueueLastFailure,
  ): Promise<boolean> {
    if (this.syncState().sessionExpired && type !== 'project') return false;
    if (!this.validateRetryQueueInput(type, operation, data, projectId)) return false;

    const addArgs = [
      type,
      operation,
      data,
      projectId,
      sourceUserId,
      taskIdsToDelete,
      writeIntent,
      taskDeleteBaseUpdatedAtMap,
      operationId,
    ] as const;
    const enqueued = lastFailure === undefined
      ? await this.retryQueueService.addDurably(...addArgs)
      : await this.retryQueueService.addDurably(...addArgs, lastFailure);
    if (enqueued) {
      this.handleRetryQueueEnqueued({
        operationId,
        type,
        operation,
        data,
        projectId,
        sourceUserId,
        taskIdsToDelete,
        writeIntent,
        taskDeleteBaseUpdatedAtMap,
        lastFailure,
      });
    } else {
      this.syncStateService.setSyncError(RECOVERABLE_SYNC_ERROR_MESSAGES.RETRY_QUEUE_FULL);
    }

    return enqueued;
  }

  private validateRetryQueueInput(
    type: RetryableEntityType,
    operation: RetryableOperation,
    data: Task | Project | Connection | { id: string },
    projectId?: string,
  ): boolean {
    if (!data?.id) {
      this.logger.warn('addToRetryQueueDurably: 跳过无效数据（缺少 id）', { type, operation });
      return false;
    }
    if ((type === 'task' || type === 'connection') && !projectId) {
      this.logger.warn('addToRetryQueueDurably: 跳过无效数据（缺少 projectId）', { type, operation, id: data.id });
      return false;
    }
    return true;
  }

  private handleRetryQueueEnqueued(input: {
    operationId?: string;
    type: RetryableEntityType;
    operation: RetryableOperation;
    data: Task | Project | Connection | { id: string };
    projectId?: string;
    sourceUserId?: string;
    taskIdsToDelete?: string[];
    writeIntent?: TaskWriteIntent;
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap;
    lastFailure?: RetryQueueLastFailure;
  }): void {
    this.syncStateService.update({ pendingCount: this.retryQueueService.length });
    if (!input.operationId) return;
    this.captureOfflineCommandIfEnabled({
      id: input.operationId,
      type: input.type,
      operation: input.operation,
      data: input.data,
      projectId: input.projectId,
      retryCount: 0,
      createdAt: Date.now(),
      operationId: input.operationId,
      sourceUserId: input.sourceUserId,
      taskIdsToDelete: input.taskIdsToDelete,
      writeIntent: input.writeIntent,
      taskDeleteBaseUpdatedAtMap: input.taskDeleteBaseUpdatedAtMap,
      lastFailure: input.lastFailure,
    });
  }

  private captureOfflineCommandIfEnabled(item: RetryQueueItem): void {
    const hooks = getOfflineSyncCaptureHooks();
    if (!hooks?.enabled) return;
    void hooks.captureRetryQueueItem(item).catch(error => {
      this.logger.warn('离线 command capture 失败，保留现有 RetryQueue 结果', { error, operationId: item.operationId });
    });
  }

  clearRetryQueue(): void {
    const count = this.retryQueueService.length;
    this.retryQueueService.clear();
    this.syncStateService.update({ pendingCount: 0 });
    this.logger.info(`已清理 ${count} 个重试项`);
    this.toast.info(`已清理 ${count} 个待同步项`);
  }

  hasRetryQueueEntity(type: RetryableEntityType, entityId: string): boolean {
    const retryQueue = this.retryQueueService as RetryQueueService & {
      hasEntity?: (entityType: RetryableEntityType, targetEntityId: string) => boolean;
    };

    return typeof retryQueue.hasEntity === 'function'
      ? retryQueue.hasEntity(type, entityId)
      : false;
  }

  markSyncRecoveredIfIdle(timestamp = nowISO()): boolean {
    const recovered = this.syncStateService.markSyncRecoveredIfIdle(timestamp);
    if (recovered) {
      this.retryQueueService.clearSuccessfulDrainFlag();
    }
    return recovered;
  }

  hasPendingRetryRecovery(): boolean {
    return this.retryQueueService.hasSuccessfulDrainFlag();
  }
}
