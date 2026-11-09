/**
 * ActionQueueProcessorsService - Action Queue 处理器协调器
 *
 * 职责：
 * - 注册队列处理生命周期回调
 * - 委托项目、连接与 task/focus/preference 处理器注册具体业务 processor
 */
import { Injectable, inject } from '@angular/core';
import {
  RealtimePollingService,
  RetryQueueEnqueueService,
} from '../core-bridge';
import { Project } from '../models';
import { ActionQueueConnectionProcessorsService } from './action-queue-connection-processors.service';
import { ActionQueueProjectProcessorsService } from './action-queue-project-processors.service';
import { ActionQueueAttachmentProcessorsService } from './action-queue-attachment-processors.service';
import { ActionQueueTaskFocusProcessorsService } from './action-queue-task-focus-processors.service';
import { ActionQueueService } from './action-queue.service';
import type { TaskDeleteBaseUpdatedAtMap } from './action-queue.types';

@Injectable({
  providedIn: 'root'
})
export class ActionQueueProcessorsService {
  private readonly actionQueue = inject(ActionQueueService);
  private readonly taskFocusProcessors = inject(ActionQueueTaskFocusProcessorsService);
  private readonly connectionProcessors = inject(ActionQueueConnectionProcessorsService);
  private readonly projectProcessors = inject(ActionQueueProjectProcessorsService);
  private readonly attachmentProcessors = inject(ActionQueueAttachmentProcessorsService);
  private readonly realtimePolling = inject(RealtimePollingService);
  private readonly retryEnqueue = inject(RetryQueueEnqueueService);
  private processorsInitialized = false;

  constructor() {
    // 恢复/联网事件可能早于 SyncCoordinator.initialize()，处理器必须先注册。
    this.setupProcessors();
  }

  /** 初始化所有处理器 */
  setupProcessors(): void {
    if (this.processorsInitialized) return;

    this.setupQueueSyncCoordination();
    this.projectProcessors.setupProcessors();
    this.connectionProcessors.setupProcessors();
    this.taskFocusProcessors.setupProcessors();
    this.attachmentProcessors.setupProcessors();
    this.processorsInitialized = true;
  }

  setProjectConflictHandler(
    handler: (
      localProject: Project,
      remoteProject: Project,
      ownerUserId?: string | null,
      taskIdsToDelete?: string[],
      taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    ) => void
  ): void {
    this.projectProcessors.setProjectConflictHandler(handler);
  }

  private setupQueueSyncCoordination(): void {
    this.actionQueue.setQueueProcessCallbacks(
      () => this.realtimePolling.pauseRealtimeUpdates(),
      () => this.realtimePolling.resumeRealtimeUpdates(),
      ({ processed, failed, movedToDeadLetter, remaining, remoteSuccessCount, resolvedNoOpCount }) => {
        // RetryQueue 已先成功见底时，ActionQueue 可能只是在收口 local-only / tombstone no-op。
        const resolvedCount = remoteSuccessCount + resolvedNoOpCount;
        const cleanSettle = failed === 0 && movedToDeadLetter === 0 && remaining === 0;
        const hasPendingRetryRecovery = this.retryEnqueue.hasPendingRetryRecovery();
        const actionQueueRecovered = remoteSuccessCount > 0 && processed === resolvedCount;

        if (cleanSettle && (hasPendingRetryRecovery || actionQueueRecovered)) {
          this.retryEnqueue.markSyncRecoveredIfIdle();
        }
      }
    );
  }
}
