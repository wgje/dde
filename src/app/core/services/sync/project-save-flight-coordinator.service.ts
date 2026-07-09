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
import {
  RetryQueueService,
  type TaskDeleteBaseUpdatedAtMap,
  type RetryableEntityType,
  type RetryableOperation,
} from './retry-queue.service';
import { SyncStateService } from './sync-state.service';
import { SessionManagerService } from './session-manager.service';
import { buildProjectSaveFlightKey, buildProjectSaveSignature } from './project-save-keys';
import { isProjectSaveNewer } from './project-save-freshness';
import {
  decideFailedProjectSaveFlightSettlement,
  decideQueuedProjectSaveRequestMerge,
  parseProjectSaveFlightKey,
} from './project-save-flight-flow';

/** 项目保存结果 */
export type ProjectSaveResult = {
  success: boolean;
  conflict?: boolean;
  remoteData?: Project;
  newVersion?: number;
  validationWarnings?: string[];
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
  writeIntent?: undefined,
  taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
  operationId?: string,
) => Promise<boolean>;

interface QueuedProjectSaveRequest {
  project: Project;
  userId: string;
  operationId?: string;
  signature: string;
  taskIdsToDelete?: string[];
  taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap;
  promise: Promise<ProjectSaveResult>;
  resolve: (result: ProjectSaveResult) => void;
  reject: (error: unknown) => void;
}

interface ProjectSaveFlight {
  activeSignature: string;
  activeTaskIdsToDelete?: string[];
  activeTaskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap;
  activePromise: Promise<ProjectSaveResult>;
  queuedRequest: QueuedProjectSaveRequest | null;
}

interface ProjectSaveRequestSnapshot {
  signature: string;
  taskIdsToDelete?: string[];
  taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap;
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
  save(
    project: Project,
    userId: string,
    taskIdsToDelete?: string[],
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
  ): Promise<ProjectSaveResult> {
    return this.saveProjectToCloudSingleFlight(project, userId, taskIdsToDelete, taskDeleteBaseUpdatedAtMap, operationId);
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

  private captureEffectiveTaskDeleteBaseUpdatedAtMap(
    projectId: string,
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    fallbackTaskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
  ): TaskDeleteBaseUpdatedAtMap | undefined {
    if (taskDeleteBaseUpdatedAtMap !== undefined) {
      return { ...taskDeleteBaseUpdatedAtMap };
    }

    const trackedTaskDeleteBaseUpdatedAtMap = this.changeTracker.getProjectChanges(projectId).taskDeleteBaseUpdatedAtMap;
    if (trackedTaskDeleteBaseUpdatedAtMap && Object.keys(trackedTaskDeleteBaseUpdatedAtMap).length > 0) {
      return { ...trackedTaskDeleteBaseUpdatedAtMap };
    }

    return fallbackTaskDeleteBaseUpdatedAtMap === undefined
      ? undefined
      : { ...fallbackTaskDeleteBaseUpdatedAtMap };
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
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
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
      operationId,
      signature,
      taskIdsToDelete,
      taskDeleteBaseUpdatedAtMap,
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
    let refreshed = false;
    try {
      refreshed = this.durableRetryHandler
        ? await this.durableRetryHandler(
            'project',
            'upsert',
            queuedRequest.project,
            undefined,
            queuedRequest.userId,
            latestTaskIdsToDelete,
            undefined,
            queuedRequest.taskDeleteBaseUpdatedAtMap,
            queuedRequest.operationId,
          )
        : false;
    } catch (error) {
      this.logger.warn('刷新项目重试队列 payload 失败，将继续执行排队中的项目云端持久化', {
        projectId: queuedRequest.project.id,
        userId: queuedRequest.userId,
        error,
      });
      return false;
    }
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
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
    flight?: ProjectSaveFlight,
    queuedRequest?: QueuedProjectSaveRequest,
  ): Promise<ProjectSaveResult> {
    const targetFlight = flight ?? {
      activeSignature: signature,
      activeTaskIdsToDelete: taskIdsToDelete ?? queuedRequest?.taskIdsToDelete,
      activeTaskDeleteBaseUpdatedAtMap: taskDeleteBaseUpdatedAtMap ?? queuedRequest?.taskDeleteBaseUpdatedAtMap,
      activePromise: Promise.resolve({ success: false }),
      queuedRequest: null,
    };
    const effectiveTaskIdsToDelete = taskIdsToDelete ?? queuedRequest?.taskIdsToDelete;
    const effectiveTaskDeleteBaseUpdatedAtMap = taskDeleteBaseUpdatedAtMap ?? queuedRequest?.taskDeleteBaseUpdatedAtMap;
    const effectiveOperationId = operationId ?? queuedRequest?.operationId;
    const basePromise = this.startProjectSaveRequest(
      project,
      userId,
      effectiveTaskIdsToDelete,
      effectiveTaskDeleteBaseUpdatedAtMap,
      effectiveOperationId,
    );
    const activePromise = this.bindQueuedProjectSaveResult(basePromise, queuedRequest);

    targetFlight.activeSignature = signature;
    targetFlight.activeTaskIdsToDelete = effectiveTaskIdsToDelete;
    targetFlight.activeTaskDeleteBaseUpdatedAtMap = effectiveTaskDeleteBaseUpdatedAtMap;
    targetFlight.activePromise = activePromise;
    this.projectSaveFlights.set(key, targetFlight);

    this.watchProjectSaveFlightSettlement(key, targetFlight, activePromise);
    return activePromise;
  }

  private startProjectSaveRequest(
    project: Project,
    userId: string,
    taskIdsToDelete?: string[],
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
  ): Promise<ProjectSaveResult> {
    if (taskDeleteBaseUpdatedAtMap !== undefined) {
      return operationId === undefined
        ? this.batchSyncService.saveProjectToCloud(project, userId, taskIdsToDelete, taskDeleteBaseUpdatedAtMap)
        : this.batchSyncService.saveProjectToCloud(project, userId, taskIdsToDelete, taskDeleteBaseUpdatedAtMap, operationId);
    }

    return operationId === undefined
      ? this.batchSyncService.saveProjectToCloud(project, userId, taskIdsToDelete)
      : this.batchSyncService.saveProjectToCloud(project, userId, taskIdsToDelete, undefined, operationId);
  }

  private bindQueuedProjectSaveResult(
    basePromise: Promise<ProjectSaveResult>,
    queuedRequest?: QueuedProjectSaveRequest,
  ): Promise<ProjectSaveResult> {
    if (!queuedRequest) return basePromise;

    return basePromise.then(
      (result) => {
        queuedRequest.resolve(result);
        return result;
      },
      (error) => {
        queuedRequest.reject(error);
        throw error;
      }
    );
  }

  private watchProjectSaveFlightSettlement(
    key: string,
    targetFlight: ProjectSaveFlight,
    activePromise: Promise<ProjectSaveResult>,
  ): void {
    void activePromise
      .then(
        (result) => this.settleProjectSaveFlight(key, targetFlight, result),
        (error) => this.abortProjectSaveFlight(key, targetFlight, error),
      )
      .catch((error) => {
        this.logger.warn('推进项目云端持久化单飞队列失败', { error, key });
      });
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
      const queuedRequest = flight.queuedRequest;
      const retryPayloadRefreshed = queuedRequest && !result.conflict && !result.terminal
        ? await this.refreshQueuedProjectRetryPayload(queuedRequest, result.retryEnqueued)
        : false;
      const settlement = decideFailedProjectSaveFlightSettlement({
        conflict: result.conflict === true,
        terminal: result.terminal === true,
        hasQueuedRequest: queuedRequest !== null,
        retryPayloadRefreshed,
      });

      if (settlement.clearRetryMarker) {
        const { projectId, userId } = parseProjectSaveFlightKey(key);
        this.clearProjectRetryMarker(projectId, userId);
      }

      if (settlement.kind === 'delete-flight' || !queuedRequest) {
        this.projectSaveFlights.delete(key);
        return;
      }

      if (settlement.kind === 'settle-queued') {
        this.settleQueuedProjectSaveRequest(key, flight, queuedRequest, result, settlement.logKind);
        return;
      }

      this.logProjectSaveFlightAdvanceAfterFailure(queuedRequest, result);
      await this.advanceProjectSaveFlight(key, flight);
      return;
    }

    await this.advanceProjectSaveFlight(key, flight);
  }

  private settleQueuedProjectSaveRequest(
    key: string,
    flight: ProjectSaveFlight,
    queuedRequest: QueuedProjectSaveRequest,
    result: ProjectSaveResult,
    logKind: 'conflict' | 'terminal' | 'retry-handoff',
  ): void {
    flight.queuedRequest = null;
    this.projectSaveFlights.delete(key);
    queuedRequest.resolve(result);
    this.logger.debug(this.getQueuedProjectSaveSettlementMessage(logKind), {
      projectId: queuedRequest.project.id,
      userId: queuedRequest.userId,
      failureReason: result.failureReason ?? null,
    });
  }

  private getQueuedProjectSaveSettlementMessage(logKind: 'conflict' | 'terminal' | 'retry-handoff'): string {
    if (logKind === 'terminal') {
      return '项目云端持久化命中终止失败，折叠队列停止自动重放';
    }

    if (logKind === 'conflict') {
      return '项目云端持久化冲突，折叠队列等待显式冲突解决';
    }

    return '项目级重试已接管，折叠队列与当前失败结果一起结算';
  }

  private logProjectSaveFlightAdvanceAfterFailure(
    queuedRequest: QueuedProjectSaveRequest,
    result: ProjectSaveResult,
  ): void {
    this.logger.debug('项目级失败未覆盖最新折叠快照，继续执行排队中的项目云端持久化', {
      projectId: queuedRequest.project.id,
      userId: queuedRequest.userId,
      failureReason: result.failureReason ?? null,
    });
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
      queuedRequest.taskDeleteBaseUpdatedAtMap,
      queuedRequest.operationId,
      flight,
      queuedRequest,
    );
  }

  private startNewProjectSaveFlight(
    key: string,
    project: Project,
    userId: string,
    taskIdsToDelete?: string[],
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
  ): Promise<ProjectSaveResult> {
    const effectiveTaskIdsToDelete = this.captureEffectiveTaskIdsToDelete(project.id, taskIdsToDelete);
    const effectiveTaskDeleteBaseUpdatedAtMap = this.captureEffectiveTaskDeleteBaseUpdatedAtMap(
      project.id,
      taskDeleteBaseUpdatedAtMap,
    );
    const signature = buildProjectSaveSignature(
      project,
      effectiveTaskIdsToDelete,
      effectiveTaskDeleteBaseUpdatedAtMap,
    );
    return this.startProjectSaveFlight(
      key,
      project,
      userId,
      signature,
      effectiveTaskIdsToDelete,
      effectiveTaskDeleteBaseUpdatedAtMap,
      operationId,
    );
  }

  private queueProjectSaveRequest(
    existingFlight: ProjectSaveFlight,
    project: Project,
    userId: string,
    signature: string,
    taskIdsToDelete: string[] | undefined,
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
  ): Promise<ProjectSaveResult> {
    const queuedRequest = this.createQueuedProjectSaveRequest(
      project,
      userId,
      signature,
      taskIdsToDelete,
      taskDeleteBaseUpdatedAtMap,
      operationId,
    );
    existingFlight.queuedRequest = queuedRequest;
    this.logger.debug('项目云端持久化排队等待单飞窗口结束', {
      projectId: project.id,
      userId,
    });
    return queuedRequest.promise;
  }

  private buildProjectSaveRequestSnapshot(
    project: Project,
    taskIdsToDelete?: string[],
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    fallbackTaskIdsToDelete?: string[],
    fallbackTaskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
  ): ProjectSaveRequestSnapshot {
    const effectiveTaskIdsToDelete = this.captureEffectiveTaskIdsToDelete(
      project.id,
      taskIdsToDelete,
      fallbackTaskIdsToDelete,
    );
    const effectiveTaskDeleteBaseUpdatedAtMap = this.captureEffectiveTaskDeleteBaseUpdatedAtMap(
      project.id,
      taskDeleteBaseUpdatedAtMap,
      fallbackTaskDeleteBaseUpdatedAtMap,
    );

    return {
      signature: buildProjectSaveSignature(project, effectiveTaskIdsToDelete, effectiveTaskDeleteBaseUpdatedAtMap),
      taskIdsToDelete: effectiveTaskIdsToDelete,
      taskDeleteBaseUpdatedAtMap: effectiveTaskDeleteBaseUpdatedAtMap,
    };
  }

  private saveProjectToCloudSingleFlight(
    project: Project,
    userId: string,
    taskIdsToDelete?: string[],
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
  ): Promise<ProjectSaveResult> {
    const key = buildProjectSaveFlightKey(project.id, userId);
    const existingFlight = this.projectSaveFlights.get(key);

    if (!existingFlight) {
      return this.startNewProjectSaveFlight(key, project, userId, taskIdsToDelete, taskDeleteBaseUpdatedAtMap, operationId);
    }

    const requestSnapshot = this.buildProjectSaveRequestSnapshot(
      project,
      taskIdsToDelete,
      taskDeleteBaseUpdatedAtMap,
      existingFlight.activeTaskIdsToDelete,
      existingFlight.activeTaskDeleteBaseUpdatedAtMap,
    );

    if (existingFlight.activeSignature === requestSnapshot.signature) {
      this.logger.debug('复用进行中的项目云端持久化', {
        projectId: project.id,
        userId,
      });
      return existingFlight.activePromise;
    }

    if (existingFlight.queuedRequest) {
      return this.mergeQueuedProjectSaveRequest(
        existingFlight,
        project,
        userId,
        requestSnapshot.signature,
        requestSnapshot.taskIdsToDelete,
        requestSnapshot.taskDeleteBaseUpdatedAtMap,
        operationId,
      );
    }

    return this.queueProjectSaveRequest(
      existingFlight,
      project,
      userId,
      requestSnapshot.signature,
      requestSnapshot.taskIdsToDelete,
      requestSnapshot.taskDeleteBaseUpdatedAtMap,
      operationId,
    );
  }

  private mergeQueuedProjectSaveRequest(
    existingFlight: ProjectSaveFlight,
    project: Project,
    userId: string,
    signature: string,
    taskIdsToDelete?: string[],
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
  ): Promise<ProjectSaveResult> {
    const queuedRequest = existingFlight.queuedRequest;
    if (!queuedRequest) {
      return existingFlight.activePromise;
    }

    const queuedSnapshot = this.buildProjectSaveRequestSnapshot(
      project,
      taskIdsToDelete,
      taskDeleteBaseUpdatedAtMap,
      queuedRequest.taskIdsToDelete ?? existingFlight.activeTaskIdsToDelete,
      queuedRequest.taskDeleteBaseUpdatedAtMap ?? existingFlight.activeTaskDeleteBaseUpdatedAtMap,
    );
    const refreshedQueuedSignature = buildProjectSaveSignature(
      queuedRequest.project,
      queuedSnapshot.taskIdsToDelete,
      queuedSnapshot.taskDeleteBaseUpdatedAtMap,
    );
    const mergeDecision = decideQueuedProjectSaveRequestMerge({
      incomingSignature: signature,
      queuedSignature: queuedRequest.signature,
      queuedRefreshedSignature: refreshedQueuedSignature,
      incomingIsNewer: isProjectSaveNewer(project, queuedRequest.project),
    });

    return this.applyQueuedProjectSaveRequestMerge(
      queuedRequest,
      project,
      userId,
      queuedSnapshot,
      refreshedQueuedSignature,
      mergeDecision,
      operationId,
    );
  }

  private applyQueuedProjectSaveRequestMerge(
    queuedRequest: QueuedProjectSaveRequest,
    project: Project,
    userId: string,
    queuedSnapshot: ProjectSaveRequestSnapshot,
    refreshedQueuedSignature: string,
    mergeDecision: ReturnType<typeof decideQueuedProjectSaveRequestMerge>,
    operationId?: string,
  ): Promise<ProjectSaveResult> {

    if (mergeDecision.kind === 'reuse-queued') {
      return queuedRequest.promise;
    }

    if (mergeDecision.kind === 'replace-queued') {
      this.replaceQueuedProjectSaveRequest(
        queuedRequest,
        project,
        userId,
        queuedSnapshot.signature,
        queuedSnapshot.taskIdsToDelete,
        queuedSnapshot.taskDeleteBaseUpdatedAtMap,
        operationId,
      );
      return queuedRequest.promise;
    }

    this.keepQueuedProjectSaveRequest(
      queuedRequest,
      project,
      userId,
      queuedSnapshot.taskIdsToDelete,
      queuedSnapshot.taskDeleteBaseUpdatedAtMap,
      refreshedQueuedSignature,
      mergeDecision.refreshQueuedPayload,
    );
    return queuedRequest.promise;
  }

  private replaceQueuedProjectSaveRequest(
    queuedRequest: QueuedProjectSaveRequest,
    project: Project,
    userId: string,
    signature: string,
    taskIdsToDelete?: string[],
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
  ): void {
    queuedRequest.project = project;
    queuedRequest.userId = userId;
    queuedRequest.operationId = operationId;
    queuedRequest.signature = signature;
    queuedRequest.taskIdsToDelete = taskIdsToDelete;
    queuedRequest.taskDeleteBaseUpdatedAtMap = taskDeleteBaseUpdatedAtMap;
    this.logger.debug('合并项目云端持久化请求到更新/同等新鲜度的后到快照', {
      projectId: project.id,
      userId,
    });
  }

  private keepQueuedProjectSaveRequest(
    queuedRequest: QueuedProjectSaveRequest,
    project: Project,
    userId: string,
    taskIdsToDelete: string[] | undefined,
    taskDeleteBaseUpdatedAtMap: TaskDeleteBaseUpdatedAtMap | undefined,
    refreshedSignature: string,
    refreshQueuedPayload: boolean,
  ): void {
    if (refreshQueuedPayload) {
      queuedRequest.signature = refreshedSignature;
      queuedRequest.taskIdsToDelete = taskIdsToDelete;
      queuedRequest.taskDeleteBaseUpdatedAtMap = taskDeleteBaseUpdatedAtMap ?? queuedRequest.taskDeleteBaseUpdatedAtMap;
      this.logger.debug('保留排队中的更新快照，并刷新后到请求携带的删除 payload', {
        projectId: project.id,
        userId,
        taskDeleteCount: taskIdsToDelete?.length ?? 0,
      });
    }
    this.logger.debug('保留排队中的更新快照，忽略更旧的项目云端持久化请求', {
      projectId: project.id,
      userId,
    });
  }
}
