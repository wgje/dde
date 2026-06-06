/**
 * ProjectSaveFlightCoordinatorService
 *
 * 从 SimpleSyncService「下切」出的项目云端持久化「单飞 + 折叠 + 重试协调」状态机。
 *
 * 职责单一：
 * - 同一 (userId, projectId) 的保存请求合并到一条飞行（single-flight）
 * - 飞行进行中到达的新请求按新鲜度折叠为单个排队请求（fold）
 * - 飞行结算后按结果（成功/冲突/终止/可重试）推进队列或刷新 durable 重试快照
 *
 * 为什么抽离：
 * - AGENTS.md §12 单文件 ≤ 800 行硬线；SimpleSyncService 长期越界，文件头要求只做「下切」。
 * - 本状态机是自洽的横切责任：持有自己的 flights Map，依赖均可注入。
 * - 唯一对门面的反向依赖是 durable 重试入队（`addToRetryQueueDurably`），通过
 *   `durableRetryHandler` 回调注入，避免与 SimpleSyncService 形成循环 DI。
 *
 * 验证：SimpleSyncService.spec 通过公开 API `saveProjectToCloud()` 端到端覆盖本状态机，
 * 门面 `saveProjectToCloud()` 改为委托 `coordinator.save()` 后该套用例继续校验零回归。
 */
import { Injectable, inject } from '@angular/core';
import { Task, Project, Connection } from '../../../../models';
import { LoggerService } from '../../../../services/logger.service';
import { ChangeTrackerService } from '../../../../services/change-tracker.service';
import { BatchSyncService } from './batch-sync.service';
import { RetryQueueService, type RetryableEntityType, type RetryableOperation } from './retry-queue.service';
import { SyncStateService } from './sync-state.service';
import { SessionManagerService } from './session-manager.service';
import { buildProjectSaveFlightKey, buildProjectSaveSignature } from './project-save-keys';
import { isProjectSaveNewer } from './project-save-freshness';

/** 项目保存结果 */
export type ProjectSaveResult = {
  success: boolean;
  conflict?: boolean;
  remoteData?: Project;
  newVersion?: number;
  projectPushed?: boolean;
  failedTaskIds?: string[];
  failedConnectionIds?: string[];
  retryEnqueued?: string[];
  failureReason?: string;
  terminal?: boolean;
  partialRetryHandoff?: boolean;
};

/**
 * durable 重试入队回调 —— 由 SimpleSyncService 注入。
 * 保留门面 `addToRetryQueueDurably` 的完整语义（session 守卫、校验、pendingCount 更新等），
 * 协调器只负责在失败折叠时调用它刷新最新快照。
 */
export type DurableRetryHandler = (
  type: RetryableEntityType,
  operation: RetryableOperation,
  data: Task | Project | Connection | { id: string },
  projectId?: string,
  sourceUserId?: string,
  taskIdsToDelete?: string[],
) => Promise<boolean>;

interface QueuedProjectSaveRequest {
  project: Project;
  userId: string;
  signature: string;
  taskIdsToDelete?: string[];
  promise: Promise<ProjectSaveResult>;
  resolve: (result: ProjectSaveResult) => void;
  reject: (error: unknown) => void;
}

interface ProjectSaveFlight {
  activeSignature: string;
  activeTaskIdsToDelete?: string[];
  activePromise: Promise<ProjectSaveResult>;
  queuedRequest: QueuedProjectSaveRequest | null;
}

@Injectable({ providedIn: 'root' })
export class ProjectSaveFlightCoordinatorService {
  private readonly logger = inject(LoggerService).category('ProjectSaveFlight');
  private readonly changeTracker = inject(ChangeTrackerService);
  private readonly batchSyncService = inject(BatchSyncService);
  private readonly retryQueueService = inject(RetryQueueService);
  private readonly syncStateService = inject(SyncStateService);
  private readonly sessionManager = inject(SessionManagerService);

  /** 由 SimpleSyncService 在构造期注入：durable 重试入队（避免循环 DI）。 */
  durableRetryHandler: DurableRetryHandler | null = null;

  private readonly projectSaveFlights = new Map<string, ProjectSaveFlight>();

  /** 公开入口：单飞 + 折叠 + 重试协调地保存项目到云端。 */
  save(project: Project, userId: string, taskIdsToDelete?: string[]): Promise<ProjectSaveResult> {
    return this.saveProjectToCloudSingleFlight(project, userId, taskIdsToDelete);
  }

  private captureEffectiveTaskIdsToDelete(
    projectId: string,
    taskIdsToDelete?: string[],
    fallbackTaskIdsToDelete?: string[],
  ): string[] | undefined {
    if (taskIdsToDelete !== undefined) {
      return [...taskIdsToDelete];
    }

    const trackedTaskIdsToDelete = this.changeTracker.getProjectChanges(projectId).taskIdsToDelete;
    if (trackedTaskIdsToDelete.length > 0) {
      return [...trackedTaskIdsToDelete];
    }

    if (fallbackTaskIdsToDelete !== undefined) {
      return [...fallbackTaskIdsToDelete];
    }

    return undefined;
  }

  private getExistingProjectRetryTaskIdsToDelete(projectId: string, sourceUserId?: string): string[] | undefined {
    const retryQueue = this.retryQueueService as RetryQueueService & {
      getProjectRetryTaskIdsToDeleteForOwner?: (targetProjectId: string, targetSourceUserId?: string) => string[] | undefined;
    };

    return typeof retryQueue.getProjectRetryTaskIdsToDeleteForOwner === 'function'
      ? retryQueue.getProjectRetryTaskIdsToDeleteForOwner(projectId, sourceUserId)
      : undefined;
  }

  private createQueuedProjectSaveRequest(
    project: Project,
    userId: string,
    signature: string,
    taskIdsToDelete?: string[],
  ): QueuedProjectSaveRequest {
    let resolve!: (result: ProjectSaveResult) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<ProjectSaveResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    return {
      project,
      userId,
      signature,
      taskIdsToDelete,
      promise,
      resolve,
      reject,
    };
  }

  private hasProjectRetryMarker(projectId: string, sourceUserId?: string, retryEnqueued?: string[]): boolean {
    const retryQueue = this.retryQueueService as RetryQueueService & {
      hasProjectRetryForOwner?: (targetProjectId: string, targetSourceUserId?: string) => boolean;
      hasEntity?: (entityType: RetryableEntityType, targetEntityId: string) => boolean;
    };

    if (retryEnqueued?.includes(`project:${projectId}`) === true) {
      return true;
    }

    if (typeof retryQueue.hasProjectRetryForOwner === 'function') {
      return retryQueue.hasProjectRetryForOwner(projectId, sourceUserId);
    }

    return typeof retryQueue.hasEntity === 'function'
      ? retryQueue.hasEntity('project', projectId)
      : false;
  }

  private clearProjectRetryMarker(projectId: string, sourceUserId?: string): void {
    const retryQueue = this.retryQueueService as RetryQueueService & {
      removeByProjectIdForOwner?: (projectId: string, sourceUserId?: string) => number;
    };
    const removedCount = typeof retryQueue.removeByProjectIdForOwner === 'function'
      ? retryQueue.removeByProjectIdForOwner(projectId, sourceUserId)
      : 0;

    if (removedCount === 0) {
      return;
    }

    this.syncStateService.update({ pendingCount: this.retryQueueService.length });
    this.logger.debug('项目云端持久化已终止，已清理遗留 project retry marker', {
      projectId,
      sourceUserId: sourceUserId ?? null,
      removedCount,
    });
  }

  private async refreshQueuedProjectRetryPayload(
    queuedRequest: QueuedProjectSaveRequest,
    retryEnqueued?: string[],
  ): Promise<boolean> {
    if (!this.hasProjectRetryMarker(queuedRequest.project.id, queuedRequest.userId, retryEnqueued)) {
      return false;
    }

    const latestTaskIdsToDelete = queuedRequest.taskIdsToDelete
      ?? this.getExistingProjectRetryTaskIdsToDelete(queuedRequest.project.id, queuedRequest.userId)
      ?? (queuedRequest.userId === this.sessionManager.getRecentValidationSnapshot(60_000)?.userId
        ? this.captureEffectiveTaskIdsToDelete(queuedRequest.project.id)
        : undefined);
    const refreshed = this.durableRetryHandler
      ? await this.durableRetryHandler(
          'project',
          'upsert',
          queuedRequest.project,
          undefined,
          queuedRequest.userId,
          latestTaskIdsToDelete,
        )
      : false;
    if (!refreshed) {
      return false;
    }

    this.logger.debug('项目云端持久化失败后已刷新重试队列为最新折叠快照', {
      projectId: queuedRequest.project.id,
      userId: queuedRequest.userId,
      taskDeleteCount: latestTaskIdsToDelete?.length ?? 0,
    });

    return true;
  }

  private startProjectSaveFlight(
    key: string,
    project: Project,
    userId: string,
    signature: string,
    taskIdsToDelete?: string[],
    flight?: ProjectSaveFlight,
    queuedRequest?: QueuedProjectSaveRequest,
  ): Promise<ProjectSaveResult> {
    const targetFlight = flight ?? {
      activeSignature: signature,
      activeTaskIdsToDelete: taskIdsToDelete ?? queuedRequest?.taskIdsToDelete,
      activePromise: Promise.resolve({ success: false }),
      queuedRequest: null,
    };
    const basePromise = this.batchSyncService.saveProjectToCloud(
      project,
      userId,
      taskIdsToDelete ?? queuedRequest?.taskIdsToDelete,
    );
    const activePromise = queuedRequest
      ? basePromise.then(
          (result) => {
            queuedRequest.resolve(result);
            return result;
          },
          (error) => {
            queuedRequest.reject(error);
            throw error;
          }
        )
      : basePromise;

    targetFlight.activeSignature = signature;
    targetFlight.activeTaskIdsToDelete = taskIdsToDelete ?? queuedRequest?.taskIdsToDelete;
    targetFlight.activePromise = activePromise;
    this.projectSaveFlights.set(key, targetFlight);

    void activePromise
      .then(
        (result) => this.settleProjectSaveFlight(key, targetFlight, result),
        (error) => this.abortProjectSaveFlight(key, targetFlight, error),
      )
      .catch((error) => {
        this.logger.warn('推进项目云端持久化单飞队列失败', { error, key });
      });

    return activePromise;
  }

  private async settleProjectSaveFlight(
    key: string,
    flight: ProjectSaveFlight,
    result: ProjectSaveResult,
  ): Promise<void> {
    if (this.projectSaveFlights.get(key) !== flight) {
      return;
    }

    if (!result.success) {
      if (result.conflict || result.terminal) {
        const separatorIndex = key.indexOf(':');
        const userId = separatorIndex >= 0 ? key.slice(0, separatorIndex) : undefined;
        const projectId = separatorIndex >= 0 ? key.slice(separatorIndex + 1) : key;
        this.clearProjectRetryMarker(projectId, userId);
      }

      const queuedRequest = flight.queuedRequest;
      if (!queuedRequest) {
        this.projectSaveFlights.delete(key);
        return;
      }

      if (result.conflict || result.terminal) {
        flight.queuedRequest = null;
        this.projectSaveFlights.delete(key);
        queuedRequest.resolve(result);
        this.logger.debug(result.terminal
          ? '项目云端持久化命中终止失败，折叠队列停止自动重放'
          : '项目云端持久化冲突，折叠队列等待显式冲突解决', {
          projectId: queuedRequest.project.id,
          userId: queuedRequest.userId,
          failureReason: result.failureReason ?? null,
        });
        return;
      }

      if (await this.refreshQueuedProjectRetryPayload(queuedRequest, result.retryEnqueued)) {
        flight.queuedRequest = null;
        this.projectSaveFlights.delete(key);
        queuedRequest.resolve(result);
        this.logger.debug('项目级重试已接管，折叠队列与当前失败结果一起结算', {
          projectId: queuedRequest.project.id,
          userId: queuedRequest.userId,
          failureReason: result.failureReason ?? null,
        });
        return;
      }

      this.logger.debug('项目级失败未覆盖最新折叠快照，继续执行排队中的项目云端持久化', {
        projectId: queuedRequest.project.id,
        userId: queuedRequest.userId,
        failureReason: result.failureReason ?? null,
      });
      await this.advanceProjectSaveFlight(key, flight);
      return;
    }

    await this.advanceProjectSaveFlight(key, flight);
  }

  private async abortProjectSaveFlight(
    key: string,
    flight: ProjectSaveFlight,
    error: unknown,
  ): Promise<void> {
    if (this.projectSaveFlights.get(key) !== flight) {
      return;
    }

    const queuedRequest = flight.queuedRequest;
    flight.queuedRequest = null;
    this.projectSaveFlights.delete(key);

    if (queuedRequest) {
      await this.refreshQueuedProjectRetryPayload(queuedRequest);
      queuedRequest.reject(error);
      this.logger.debug('项目云端持久化异常，取消排队中的折叠快照', {
        projectId: queuedRequest.project.id,
        userId: queuedRequest.userId,
      });
    }
  }

  private async advanceProjectSaveFlight(key: string, flight: ProjectSaveFlight): Promise<void> {
    if (this.projectSaveFlights.get(key) !== flight) {
      return;
    }

    const queuedRequest = flight.queuedRequest;
    if (!queuedRequest) {
      this.projectSaveFlights.delete(key);
      return;
    }

    flight.queuedRequest = null;
    this.logger.debug('执行折叠后的项目云端持久化', {
      projectId: queuedRequest.project.id,
      userId: queuedRequest.userId,
    });
    this.startProjectSaveFlight(
      key,
      queuedRequest.project,
      queuedRequest.userId,
      queuedRequest.signature,
      queuedRequest.taskIdsToDelete,
      flight,
      queuedRequest,
    );
  }

  private saveProjectToCloudSingleFlight(project: Project, userId: string, taskIdsToDelete?: string[]): Promise<ProjectSaveResult> {
    const key = buildProjectSaveFlightKey(project.id, userId);
    const existingFlight = this.projectSaveFlights.get(key);

    if (!existingFlight) {
      const effectiveTaskIdsToDelete = this.captureEffectiveTaskIdsToDelete(project.id, taskIdsToDelete);
      const signature = buildProjectSaveSignature(project, effectiveTaskIdsToDelete);
      return this.startProjectSaveFlight(key, project, userId, signature, effectiveTaskIdsToDelete);
    }

    const effectiveTaskIdsToDelete = this.captureEffectiveTaskIdsToDelete(
      project.id,
      taskIdsToDelete,
      existingFlight.activeTaskIdsToDelete,
    );
    const signature = buildProjectSaveSignature(project, effectiveTaskIdsToDelete);

    if (existingFlight.activeSignature === signature) {
      this.logger.debug('复用进行中的项目云端持久化', {
        projectId: project.id,
        userId,
      });
      return existingFlight.activePromise;
    }

    if (existingFlight.queuedRequest) {
      if (existingFlight.queuedRequest.signature === signature) {
        return existingFlight.queuedRequest.promise;
      }

      const queuedRequestTaskIdsToDelete = this.captureEffectiveTaskIdsToDelete(
        project.id,
        taskIdsToDelete,
        existingFlight.queuedRequest.taskIdsToDelete ?? existingFlight.activeTaskIdsToDelete,
      );
      const queuedRequestSignature = buildProjectSaveSignature(project, queuedRequestTaskIdsToDelete);

      if (isProjectSaveNewer(project, existingFlight.queuedRequest.project)) {
        existingFlight.queuedRequest.project = project;
        existingFlight.queuedRequest.userId = userId;
        existingFlight.queuedRequest.signature = queuedRequestSignature;
        existingFlight.queuedRequest.taskIdsToDelete = queuedRequestTaskIdsToDelete;
        this.logger.debug('合并项目云端持久化请求到更新/同等新鲜度的后到快照', {
          projectId: project.id,
          userId,
        });
      } else {
        this.logger.debug('保留排队中的更新快照，忽略更旧的项目云端持久化请求', {
          projectId: project.id,
          userId,
        });
      }
      return existingFlight.queuedRequest.promise;
    }

    const queuedRequest = this.createQueuedProjectSaveRequest(
      project,
      userId,
      signature,
      effectiveTaskIdsToDelete,
    );
    existingFlight.queuedRequest = queuedRequest;
    this.logger.debug('项目云端持久化排队等待单飞窗口结束', {
      projectId: project.id,
      userId,
    });
    return queuedRequest.promise;
  }
}
