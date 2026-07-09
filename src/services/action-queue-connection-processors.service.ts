import { Injectable, inject } from '@angular/core';
import {
  ConnectionSyncOperationsService,
  RetryQueueService,
} from '../core-bridge';
import { AUTH_CONFIG } from '../config/auth.config';
import type { Connection, Project } from '../models';
import { resolveRemoteVersionConflictEvidence } from './action-queue-operation-conflict.helpers';
import { ActionQueueService, type ActionQueueProcessorResult } from './action-queue.service';
import { retryOperationIdMatches } from './action-queue-retry-operation-id.helpers';
import type { QueueRetryError } from './action-queue-storage.service';
import type { ConnectionPayload, QueuedAction } from './action-queue.types';
import { AuthService } from './auth.service';
import { ConflictStorageService } from './conflict-storage.service';
import { LoggerService } from './logger.service';
import { ProjectStateService } from './project-state.service';
import { ToastService } from './toast.service';

type ConnectionActionType = 'connection:create' | 'connection:update' | 'connection:delete';

@Injectable({ providedIn: 'root' })
export class ActionQueueConnectionProcessorsService {
  private readonly logger = inject(LoggerService).category('ActionQueueConnectionProcessors');
  private readonly actionQueue = inject(ActionQueueService);
  private readonly connectionSyncOps = inject(ConnectionSyncOperationsService);
  private readonly retryQueue = inject(RetryQueueService);
  private readonly projectState = inject(ProjectStateService);
  private readonly authService = inject(AuthService);
  private readonly conflictStorage = inject(ConflictStorageService);
  private readonly toast = inject(ToastService);
  private legacyQueueWarningShown = false;

  setupProcessors(): void {
    this.actionQueue.registerProcessor('connection:create', async (action) => {
      return this.processConnectionMutation(action, 'connection:create', 'create');
    });

    this.actionQueue.registerProcessor('connection:update', async (action) => {
      return this.processConnectionMutation(action, 'connection:update', 'update');
    });

    this.actionQueue.registerProcessor('connection:delete', async (action) => {
      return this.processConnectionMutation(action, 'connection:delete', 'delete');
    });
  }

  private async processConnectionMutation(
    action: QueuedAction,
    actionType: ConnectionActionType,
    mutationType: 'create' | 'update' | 'delete',
  ): Promise<ActionQueueProcessorResult> {
    const payload = action.payload as ConnectionPayload;
    const userId = this.authService.currentUserId();
    if (!userId) {
      this.logger.warn(`${actionType} 延后：用户认证状态尚未就绪`);
      return this.actionQueue.deferRetry(this.buildAuthPendingRetryError(actionType, payload.connection.id));
    }

    if (this.shouldStopConnectionMutation(action, userId, payload, mutationType)) {
      return true;
    }

    try {
      return await this.flushConnectionMutation(action, payload, actionType);
    } catch (error) {
      if (await this.persistConnectionOperationConflict(action, payload, actionType, error)) {
        this.actionQueue.markActionResolvedWithoutRemote(action.id);
        this.toast.warning('检测到连接同步冲突', '本地连接修改已转入冲突中心等待处理');
        return true;
      }
      this.logger.error(`${actionType} 异常`, {
        error,
        connectionId: payload.connection.id,
        projectId: payload.projectId,
      });
      return this.actionQueue.failRetry(
        this.buildConnectionProcessorRetryError(error, actionType, payload.connection.id, payload.projectId),
      );
    }
  }

  private async persistConnectionOperationConflict(
    action: QueuedAction,
    payload: ConnectionPayload,
    actionType: ConnectionActionType,
    error: unknown,
  ): Promise<boolean> {
    const evidence = resolveRemoteVersionConflictEvidence(error, [
      'CONNECTION_REMOTE_NEWER',
      'CONNECTION_REMOTE_TOMBSTONE_NEWER',
    ]);
    if (!evidence) {
      return false;
    }

    const conflictedAt = new Date().toISOString();
    const localProject = this.buildConnectionConflictProject(payload);
    const saved = await this.conflictStorage.saveConflict({
      projectId: payload.projectId,
      ownerUserId: payload.sourceUserId ?? this.authService.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID,
      localProject,
      conflictedAt,
      localVersion: localProject.version ?? 0,
      reason: 'version_mismatch',
      acknowledged: false,
      operationConflicts: [{
        actionId: action.id,
        actionType,
        entityType: 'connection',
        entityId: payload.connection.id,
        projectId: payload.projectId,
        operationId: action.operationId,
        localEntity: payload.connection,
        remoteEntity: evidence.remoteEntity,
        code: evidence.code,
        message: evidence.message,
        details: evidence.details,
        conflictedAt,
        reason: evidence.reason,
      }],
    }).catch((saveError) => {
      this.logger.error(`${actionType} 冲突证据保存失败，保留 ActionQueue 项等待恢复`, {
        error: saveError,
        connectionId: payload.connection.id,
        projectId: payload.projectId,
      });
      return false;
    });

    return saved;
  }

  private buildConnectionConflictProject(payload: ConnectionPayload): Project {
    const currentProject = this.projectState.getProject(payload.projectId);
    if (currentProject) {
      return {
        ...currentProject,
        tasks: currentProject.tasks ?? [],
        connections: this.upsertConnectionConflictSnapshot(
          currentProject.connections ?? [],
          payload.connection,
        ),
      };
    }

    const now = new Date().toISOString();
    return {
      id: payload.projectId,
      name: '',
      description: '',
      createdDate: payload.connection.updatedAt ?? now,
      updatedAt: payload.connection.updatedAt ?? now,
      version: 0,
      tasks: [],
      connections: [payload.connection],
    };
  }

  private upsertConnectionConflictSnapshot(
    connections: Connection[],
    localConnection: Connection,
  ): Connection[] {
    const existingIndex = connections.findIndex(connection => connection.id === localConnection.id);
    if (existingIndex < 0) {
      return [...connections, localConnection];
    }

    return connections.map(connection => connection.id === localConnection.id ? localConnection : connection);
  }

  private async flushConnectionMutation(
    action: QueuedAction,
    payload: ConnectionPayload,
    actionType: ConnectionActionType,
  ): Promise<ActionQueueProcessorResult> {
    const success = await this.connectionSyncOps.pushConnection(
      payload.connection,
      payload.projectId,
      false,
      false,
      false,
      payload.sourceUserId,
      action.operationId,
    );
    if (success) {
      this.actionQueue.markActionSyncedRemotely(action.id);
      return true;
    }

    if (this.wasConnectionTransferredToRetryQueue(payload, action.operationId)) {
      this.logger.info(`${actionType} 已转交 RetryQueue，当前 ActionQueue 项视为完成`, {
        connectionId: payload.connection.id,
        projectId: payload.projectId,
      });
      return true;
    }

    return this.actionQueue.failRetry(
      this.buildConnectionSyncRetryError(actionType, payload.connection.id, payload.projectId),
    );
  }

  private wasConnectionTransferredToRetryQueue(payload: ConnectionPayload, operationId?: string): boolean {
    const retryItem = this.retryQueue.findItemForOwner(
      'connection',
      payload.connection.id,
      this.resolveQueueOwnerUserId(payload.sourceUserId),
    ) as {
      operation?: unknown;
      projectId?: unknown;
      data?: unknown;
      sourceUserId?: unknown;
      operationId?: unknown;
    } | undefined;
    if (!retryItem || retryItem.projectId !== payload.projectId) {
      return false;
    }

    if (retryItem.operation !== 'upsert' && retryItem.operation !== 'delete') {
      return false;
    }

    if (!retryOperationIdMatches(retryItem, operationId)) {
      return false;
    }

    return this.buildConnectionRetryPayloadSignature(retryItem.data, retryItem.projectId, retryItem.sourceUserId)
      === this.buildConnectionRetryPayloadSignature(payload.connection, payload.projectId, payload.sourceUserId);
  }

  private buildConnectionRetryPayloadSignature(
    connection: unknown,
    projectId: unknown,
    sourceUserId: unknown,
  ): string {
    return JSON.stringify({
      connection,
      projectId: typeof projectId === 'string' ? projectId : null,
      sourceUserId: typeof sourceUserId === 'string' ? sourceUserId : null,
    });
  }

  private shouldStopConnectionMutation(
    action: QueuedAction,
    userId: string,
    payload: ConnectionPayload,
    actionType: 'create' | 'update' | 'delete',
  ): boolean {
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.logger.warn(`connection:${actionType} 跳过：本地模式不进入云端队列`, {
        connectionId: payload.connection.id,
        projectId: payload.projectId,
      });
      return true;
    }

    if (payload.sourceUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.quarantineLegacyQueueAction(
        action,
        `connection:${actionType} legacy local-user 队列项禁止自动上云，请人工确认后重试`,
      );
      return true;
    }

    if (payload.sourceUserId && payload.sourceUserId !== userId) {
      this.quarantineLegacyQueueAction(
        action,
        `connection:${actionType} 队列来源用户 ${payload.sourceUserId} 与当前账号 ${userId} 不匹配，已转入失败记录`,
      );
      return true;
    }

    const currentProject = this.projectState.getProject(payload.projectId);
    if (currentProject?.syncSource === 'local-only') {
      this.logger.warn(`connection:${actionType} 跳过：local-only 项目不进入云端队列`, {
        connectionId: payload.connection.id,
        projectId: payload.projectId,
      });
      return true;
    }

    if (typeof payload.sourceUserId !== 'string') {
      this.quarantineLegacyQueueAction(
        action,
        `connection:${actionType} legacy 队列项缺少来源元数据，无法安全判断归属，已转入失败记录`,
      );
      return true;
    }

    return false;
  }

  private resolveQueueOwnerUserId(sourceUserId?: string | null): string {
    return (typeof sourceUserId === 'string' && sourceUserId.length > 0)
      ? sourceUserId
      : this.authService.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  private buildAuthPendingRetryError(actionType: string, connectionId: string): QueueRetryError {
    return {
      code: 'SYNC_AUTH_PENDING',
      message: '认证状态尚未就绪，请稍后重试',
      details: {
        reason: 'auth-pending',
        actionType,
        connectionId,
      },
    };
  }

  private buildConnectionSyncRetryError(
    actionType: ConnectionActionType,
    connectionId: string,
    projectId: string,
  ): QueueRetryError {
    return {
      code: 'SYNC_CONNECTION_WRITE_FAILED',
      message: `${actionType} 未完成，且未发现 RetryQueue 接管项`,
      details: {
        reason: 'connection-sync-failed',
        actionType,
        connectionId,
        projectId,
      },
    };
  }

  private buildConnectionProcessorRetryError(
    error: unknown,
    actionType: ConnectionActionType,
    connectionId: string,
    projectId: string,
  ): QueueRetryError {
    const maybeError = error && typeof error === 'object'
      ? error as { code?: unknown; message?: unknown; details?: unknown }
      : null;
    const details = maybeError?.details && typeof maybeError.details === 'object'
      ? maybeError.details as Record<string, unknown>
      : {};

    return {
      code: typeof maybeError?.code === 'string' ? maybeError.code : undefined,
      message: error instanceof Error
        ? error.message
        : typeof maybeError?.message === 'string'
          ? maybeError.message
          : String(error ?? `${actionType} 未提供失败原因`),
      details: {
        ...details,
        reason: details['reason'] ?? 'connection-processor-failed',
        actionType,
        connectionId,
        projectId,
      },
    };
  }

  private quarantineLegacyQueueAction(action: QueuedAction, reason: string): void {
    this.logger.warn('检测到需人工确认的连接离线队列项，已转入失败记录', {
      actionId: action.id,
      entityType: action.entityType,
      entityId: action.entityId,
      reason,
    });
    this.actionQueue.moveToDeadLetter(action, reason);
    if (!this.legacyQueueWarningShown) {
      this.legacyQueueWarningShown = true;
      this.toast.warning('检测到待确认的离线变更', '旧版或跨账号的连接队列项已转入失败记录，请确认后再重试');
    }
  }
}
