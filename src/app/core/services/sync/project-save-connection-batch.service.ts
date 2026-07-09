import { Injectable, inject } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Connection } from '../../../../models';
import { ConflictStorageService } from '../../../../services/conflict-storage.service';
import { resolveRemoteVersionConflictEvidence } from '../../../../services/action-queue-operation-conflict.helpers';
import { LoggerService } from '../../../../services/logger.service';
import {
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';
import { isPermanentFailureError } from '../../../../utils/permanent-failure-error';
import { supabaseErrorToError } from '../../../../utils/supabase-error';
import { createProjectConnectionUpsertOperationId } from '../../../../services/project-operation-child-operation-id';
import { RetryQueueService } from './retry-queue.service';
import type {
  ConnectionReadiness,
  PreparedProjectSaveBatch,
  ProjectSaveBatchContext,
  RemoteExistingTaskIdsResult,
} from './batch-sync.types';
import { decideConnectionPushResult, decideRemoteExistingTaskIdsQueryFailure } from './project-save-plan';
import { ProjectSaveEntityStateService } from './project-save-entity-state.service';

@Injectable({ providedIn: 'root' })
export class ProjectSaveConnectionBatchService {
  private readonly logger = inject(LoggerService).category('BatchSync');
  private readonly retryQueue = inject(RetryQueueService);
  private readonly entityState = inject(ProjectSaveEntityStateService);
  private readonly conflictStorage = inject(ConflictStorageService);

  async pushDeletedConnections(
    context: ProjectSaveBatchContext,
    connectionTombstoneIds: Set<string>,
  ): Promise<void> {
    const deletedConnections = this.getDeletedConnections(context, connectionTombstoneIds);
    for (let i = 0; i < deletedConnections.length; i++) {
      if (await this.deferRemainingConnectionsOnSuspension(context, deletedConnections, i, 'deletedConnections')) {
        break;
      }
      if (i > 0) await this.delay(200);

      await this.pushDeletedConnection(context, deletedConnections, i);
    }
  }

  async pushActiveConnections(
    context: ProjectSaveBatchContext,
    prepared: PreparedProjectSaveBatch,
    successfulTaskIds: Set<string>,
  ): Promise<void> {
    const activeConnections = this.getActiveConnections(context, prepared);
    const readiness = await this.buildConnectionReadiness(context, activeConnections, successfulTaskIds);

    if (readiness.deferredBySuspension) {
      await this.deferActiveConnectionsBySuspension(context, activeConnections, readiness.purgedTaskIds);
      return;
    }

    const connectionsToSync = await this.deferBlockedConnections(context, activeConnections, readiness);
    for (let i = 0; i < connectionsToSync.length; i++) {
      if (await this.deferRemainingConnectionsOnSuspension(context, connectionsToSync, i, 'connectionsToSync')) {
        break;
      }
      if (i > 0) await this.delay(200);

      await this.pushActiveConnection(context, connectionsToSync, i);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private getDeletedConnections(context: ProjectSaveBatchContext, connectionTombstoneIds: Set<string>): Connection[] {
    return context.projectSnapshot.connections.filter(conn => {
      if (!conn.deletedAt || connectionTombstoneIds.has(conn.id)) {
        return false;
      }

      return !this.entityState.isConnectionSuppressedUntilFreshEdit(
        context.projectSnapshot.id,
        conn.id,
        context.preparation.changedConnectionIds,
      );
    });
  }

  private async deferRemainingConnectionsOnSuspension(
    context: ProjectSaveBatchContext,
    connections: Connection[],
    startIndex: number,
    reason: string,
  ): Promise<boolean> {
    if (!isBrowserNetworkSuspendedWindow()) {
      return false;
    }

    const remaining = connections.slice(startIndex);
    if (remaining.length === 0) {
      return true;
    }

    this.logger.info('浏览器网络挂起，连接批同步中断并整批入重试队列', {
      projectId: context.projectSnapshot.id,
      context: reason,
      remaining: remaining.length,
      resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
    });
    for (const conn of remaining) {
      context.state.failedConnectionIds.push(conn.id);
      if (await this.addConnectionRetryWithOptionalOperationId(context, conn)) {
        context.state.retryEnqueued.push(`connection:${conn.id}`);
      }
    }
    return true;
  }

  private async pushDeletedConnection(
    context: ProjectSaveBatchContext,
    deletedConnections: Connection[],
    index: number,
  ): Promise<void> {
    try {
      const connection = deletedConnections[index];
      this.retryQueue.removeByEntity('connection', connection.id);
      const connectionResult = await this.pushConnectionWithOptionalOperationId(context, connection);
      if (!connectionResult.success) {
        context.state.failedConnectionIds.push(connection.id);
        if (connectionResult.retryEnqueued) {
          context.state.retryEnqueued.push(`connection:${connection.id}`);
        }
        return;
      }

      this.entityState.clearConnectionChangeAfterSuccessfulPush(
        context.projectSnapshot.id,
        connection.id,
        context.batchChangeRevision,
      );
    } catch (error) {
      await this.handleDeletedConnectionPushError(context, deletedConnections, index, error);
    }
  }

  private async handleDeletedConnectionPushError(
    context: ProjectSaveBatchContext,
    deletedConnections: Connection[],
    index: number,
    error: unknown,
  ): Promise<void> {
    if (isPermanentFailureError(error)) {
      const connection = deletedConnections[index];
      const conflictSaved = await this.persistConnectionTerminalConflict(context, connection, error);
      const canClearDirtyMarker = conflictSaved !== false;
      const clearedDirtyMarker = canClearDirtyMarker
        && this.entityState.shouldClearDirtyMarkerAfterPermanentFailure(error);
      context.state.failedConnectionIds.push(connection.id);
      if (clearedDirtyMarker) {
        this.entityState.suppressConnectionUntilFingerprintChanges(
          context.projectSnapshot.id,
          connection.id,
          this.entityState.createConnectionConflictFingerprint(connection),
        );
        this.entityState.clearConnectionChangeAfterSuccessfulPush(
          context.projectSnapshot.id,
          connection.id,
          context.batchChangeRevision,
        );
      }
      this.logger.warn('跳过永久失败的已删除连接', {
        connectionId: connection.id,
        clearedDirtyMarker,
        conflictSaved,
      });
      return;
    }

    if (isBrowserNetworkSuspendedError(error)) {
      await this.deferRemainingConnectionsOnSuspension(context, deletedConnections, index, 'deletedConnections.error');
      return;
    }

    throw error;
  }

  private getActiveConnections(
    context: ProjectSaveBatchContext,
    prepared: PreparedProjectSaveBatch,
  ): Connection[] {
    return context.projectSnapshot.connections.filter(connection => {
      if (!prepared.connectionUpsertIds.has(connection.id)) return false;
      if (connection.deletedAt) return false;
      if (prepared.connectionTombstoneIds.has(connection.id)) return false;
      return !this.entityState.isConnectionSuppressedUntilFreshEdit(
        context.projectSnapshot.id,
        connection.id,
        context.preparation.changedConnectionIds,
      );
    });
  }

  private async buildConnectionReadiness(
    context: ProjectSaveBatchContext,
    activeConnections: Connection[],
    successfulTaskIds: Set<string>,
  ): Promise<ConnectionReadiness> {
    const referencedTaskIds = Array.from(new Set(activeConnections.flatMap(conn => [conn.source, conn.target])));
    const remoteTaskLookup = await this.fetchRemoteExistingTaskIds(
      context.client,
      context.projectSnapshot.id,
      referencedTaskIds,
    );
    const allSyncedTaskIds = new Set<string>(successfulTaskIds);
    remoteTaskLookup.existingIds.forEach(taskId => allSyncedTaskIds.add(taskId));
    const purgedTaskIds = context.state.taskPurgeSucceeded
      ? new Set(context.changes.taskIdsToDelete)
      : new Set<string>();

    return {
      allSyncedTaskIds,
      purgedTaskIds,
      deferredBySuspension: remoteTaskLookup.deferredBySuspension,
    };
  }

  private async fetchRemoteExistingTaskIds(
    client: SupabaseClient,
    projectId: string,
    taskIds: string[]
  ): Promise<RemoteExistingTaskIdsResult> {
    const existingIds = new Set<string>();
    if (taskIds.length === 0) {
      return { existingIds, deferredBySuspension: false };
    }

    if (isBrowserNetworkSuspendedWindow()) {
      this.logger.info('浏览器网络挂起，延后远端任务存在性查询', {
        projectId,
        taskCount: taskIds.length,
        resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
      });
      return { existingIds, deferredBySuspension: true };
    }

    const chunkSize = 100;
    for (let offset = 0; offset < taskIds.length; offset += chunkSize) {
      const chunk = taskIds.slice(offset, offset + chunkSize);
      const { data, error } = await this.queryRemoteExistingTaskIdChunk(client, projectId, chunk);

      if (error) {
        return this.handleRemoteExistingTaskIdsQueryFailure(error, projectId, chunk.length, existingIds);
      }

      for (const row of (data || [])) {
        if (row.id) existingIds.add(String(row.id));
      }
    }

    return { existingIds, deferredBySuspension: false };
  }

  private async queryRemoteExistingTaskIdChunk(
    client: SupabaseClient,
    projectId: string,
    chunk: string[],
  ): Promise<{ data: Array<{ id: string }> | null; error: unknown | null }> {
    try {
      // 中文注释：必须排除软删除任务，避免为已删除任务同步连接
      const { data, error } = await client
        .from('tasks')
        .select('id')
        .eq('project_id', projectId)
        .in('id', chunk)
        .is('deleted_at', null);

      return { data, error };
    } catch (error) {
      return { data: null, error };
    }
  }

  private handleRemoteExistingTaskIdsQueryFailure(
    error: unknown,
    projectId: string,
    chunkSize: number,
    existingIds: Set<string>,
  ): RemoteExistingTaskIdsResult {
    const failureDecision = decideRemoteExistingTaskIdsQueryFailure({
      browserSuspendedError: isBrowserNetworkSuspendedError(error),
      browserSuspendedWindow: isBrowserNetworkSuspendedWindow(),
    });

    if (failureDecision.kind === 'defer-by-suspension') {
      this.logger.info('浏览器网络挂起，延后连接依赖校验', {
        projectId,
        chunkSize,
        resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
      });
      return { existingIds, deferredBySuspension: true };
    }

    const enhanced = supabaseErrorToError(error);
    this.logger.warn('查询远端任务存在性失败，连接依赖校验降级为本地成功集', {
      projectId,
      chunkSize,
      error: enhanced.message,
      errorType: enhanced.errorType,
    });
    return { existingIds, deferredBySuspension: false };
  }

  private async deferActiveConnectionsBySuspension(
    context: ProjectSaveBatchContext,
    activeConnections: Connection[],
    purgedTaskIds: Set<string>,
  ): Promise<void> {
    this.logger.info('浏览器网络挂起，延后连接批同步到重试队列', {
      projectId: context.projectSnapshot.id,
      connectionCount: activeConnections.length,
      resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
    });

    for (const connection of activeConnections) {
      if (this.clearConnectionCoveredByTaskPurge(context, connection, purgedTaskIds)) {
        continue;
      }

      context.state.failedConnectionIds.push(connection.id);
      if (await this.addConnectionRetryWithOptionalOperationId(context, connection)) {
        context.state.retryEnqueued.push(`connection:${connection.id}`);
      }
    }
  }

  private async deferBlockedConnections(
    context: ProjectSaveBatchContext,
    activeConnections: Connection[],
    readiness: ConnectionReadiness,
  ): Promise<Connection[]> {
    const connectionsToSync: Connection[] = [];
    for (const connection of activeConnections) {
      if (readiness.allSyncedTaskIds.has(connection.source) && readiness.allSyncedTaskIds.has(connection.target)) {
        connectionsToSync.push(connection);
        continue;
      }

      if (this.clearConnectionCoveredByTaskPurge(context, connection, readiness.purgedTaskIds)) {
        continue;
      }

      this.logger.warn('跳过连接（引用任务未同步）', {
        connectionId: connection.id,
        projectId: context.projectSnapshot.id,
        source: connection.source,
        target: connection.target,
        sourceReady: readiness.allSyncedTaskIds.has(connection.source),
        targetReady: readiness.allSyncedTaskIds.has(connection.target)
      });
      context.state.failedConnectionIds.push(connection.id);
      if (await this.addConnectionRetryWithOptionalOperationId(context, connection)) {
        context.state.retryEnqueued.push(`connection:${connection.id}`);
      }
    }
    return connectionsToSync;
  }

  private clearConnectionCoveredByTaskPurge(
    context: ProjectSaveBatchContext,
    connection: Connection,
    purgedTaskIds: Set<string>,
  ): boolean {
    const coveredByTaskPurge = purgedTaskIds.has(connection.source) || purgedTaskIds.has(connection.target);
    if (!coveredByTaskPurge) {
      return false;
    }

    this.logger.info('连接已随 task purge 在云端删除，跳过无意义重试', {
      connectionId: connection.id,
      projectId: context.projectSnapshot.id,
      source: connection.source,
      target: connection.target,
    });
    this.entityState.clearConnectionChangeAfterSuccessfulPush(
      context.projectSnapshot.id,
      connection.id,
      context.batchChangeRevision,
    );
    return true;
  }

  private async pushActiveConnection(
    context: ProjectSaveBatchContext,
    connectionsToSync: Connection[],
    index: number,
  ): Promise<void> {
    try {
      const connection = connectionsToSync[index];
      this.retryQueue.removeByEntity('connection', connection.id);
      const connectionResult = await this.pushConnectionWithOptionalOperationId(context, connection);
      this.handleConnectionPushResult(
        connection,
        context.projectSnapshot.id,
        context.batchChangeRevision,
        connectionResult,
        context.state.failedConnectionIds,
        context.state.retryEnqueued,
      );
    } catch (error) {
      await this.handleActiveConnectionPushError(context, connectionsToSync, index, error);
    }
  }

  private handleConnectionPushResult(
    connection: Connection,
    projectId: string,
    batchChangeRevision: number,
    result: { success: boolean; retryEnqueued?: boolean },
    failedConnectionIds: string[],
    retryEnqueued: string[],
  ): void {
    const decision = decideConnectionPushResult(result);

    if (decision.kind === 'clear-success') {
      this.entityState.clearConnectionChangeAfterSuccessfulPush(projectId, connection.id, batchChangeRevision);
      return;
    }

    failedConnectionIds.push(connection.id);
    if (decision.retryEnqueued) {
      retryEnqueued.push(`connection:${connection.id}`);
    }
  }

  private pushConnectionWithOptionalOperationId(
    context: ProjectSaveBatchContext,
    connection: Connection,
  ): Promise<{ success: boolean; retryEnqueued?: boolean }> {
    if (context.operationId === undefined) {
      return context.callbacks.pushConnection(
        connection,
        context.projectSnapshot.id,
        true,
        true,
        false,
        context.userId,
      );
    }

    const connectionOperationId = createProjectConnectionUpsertOperationId(
      context.operationId,
      context.projectSnapshot.id,
      connection,
    );
    return context.callbacks.pushConnection(
      connection,
      context.projectSnapshot.id,
      true,
      true,
      false,
      context.userId,
      connectionOperationId,
    );
  }

  private async addConnectionRetryWithOptionalOperationId(
    context: ProjectSaveBatchContext,
    connection: Connection,
  ): Promise<boolean> {
    if (context.operationId === undefined) {
      return await context.callbacks.addToRetryQueueDurably(
        'connection',
        'upsert',
        connection,
        context.projectSnapshot.id,
        context.userId,
      );
    }

    const connectionOperationId = createProjectConnectionUpsertOperationId(
      context.operationId,
      context.projectSnapshot.id,
      connection,
    );
    return await context.callbacks.addToRetryQueueDurably(
      'connection',
      'upsert',
      connection,
      context.projectSnapshot.id,
      context.userId,
      undefined,
      undefined,
      undefined,
      connectionOperationId,
    );
  }

  private async handleActiveConnectionPushError(
    context: ProjectSaveBatchContext,
    connectionsToSync: Connection[],
    index: number,
    error: unknown,
  ): Promise<void> {
    if (isPermanentFailureError(error)) {
      await this.handlePermanentConnectionPushFailure(
        error,
        connectionsToSync[index],
        context,
        context.batchChangeRevision,
        context.state.failedConnectionIds,
      );
      return;
    }

    if (isBrowserNetworkSuspendedError(error)) {
      await this.deferRemainingConnectionsOnSuspension(context, connectionsToSync, index, 'connectionsToSync.error');
      return;
    }

    throw error;
  }

  private async handlePermanentConnectionPushFailure(
    error: unknown,
    connection: Connection,
    context: ProjectSaveBatchContext,
    batchChangeRevision: number,
    failedConnectionIds: string[],
  ): Promise<void> {
    const conflictSaved = await this.persistConnectionTerminalConflict(context, connection, error);
    const canClearDirtyMarker = conflictSaved !== false;
    const clearedDirtyMarker = canClearDirtyMarker
      && this.entityState.shouldClearDirtyMarkerAfterPermanentFailure(error);
    failedConnectionIds.push(connection.id);

    if (clearedDirtyMarker) {
      this.entityState.suppressConnectionUntilFingerprintChanges(
        context.projectSnapshot.id,
        connection.id,
        this.entityState.createConnectionConflictFingerprint(connection),
      );
      this.entityState.clearConnectionChangeAfterSuccessfulPush(context.projectSnapshot.id, connection.id, batchChangeRevision);
    }

    this.logger.warn('跳过永久失败的连接', {
      connectionId: connection.id,
      clearedDirtyMarker,
      conflictSaved,
    });
  }

  private async persistConnectionTerminalConflict(
    context: ProjectSaveBatchContext,
    connection: Connection,
    error: unknown,
  ): Promise<boolean | undefined> {
    const evidence = resolveRemoteVersionConflictEvidence(error, [
      'CONNECTION_REMOTE_NEWER',
      'CONNECTION_REMOTE_TOMBSTONE_NEWER',
    ]);
    if (!evidence) {
      return undefined;
    }

    const conflictedAt = new Date().toISOString();
    const saved = await this.conflictStorage.saveConflict({
      projectId: context.projectSnapshot.id,
      ownerUserId: context.userId,
      localProject: context.projectSnapshot,
      conflictedAt,
      localVersion: context.projectSnapshot.version ?? 0,
      reason: 'version_mismatch',
      acknowledged: false,
      operationConflicts: [{
        actionType: connection.deletedAt ? 'connection:delete' : 'connection:update',
        entityType: 'connection',
        entityId: connection.id,
        projectId: context.projectSnapshot.id,
        localEntity: connection,
        remoteEntity: evidence.remoteEntity,
        code: evidence.code,
        message: evidence.message,
        details: evidence.details,
        conflictedAt,
        reason: evidence.reason,
      }],
    }).catch((saveError) => {
      this.logger.error('连接版本冲突证据保存失败，保留脏标记等待下次同步', {
        connectionId: connection.id,
        projectId: context.projectSnapshot.id,
        error: saveError,
      });
      return false;
    });

    return saved;
  }
}
