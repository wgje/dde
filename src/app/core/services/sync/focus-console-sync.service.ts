import { Injectable, inject } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { AuthService } from '../../../../services/auth.service';
import { LoggerService } from '../../../../services/logger.service';
import { SyncRpcClientService, type SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import { DataSafetyWriteAuditService } from '../../../../services/data-safety-write-audit.service';
import { SessionManagerService } from './session-manager.service';
import {
  DockSnapshot,
  FocusSessionRecord,
  RoutineCompletionMutation,
  RoutineTask,
} from '../../../../models/parking-dock';
import { supabaseErrorToError } from '../../../../utils/supabase-error';
import {
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';
import {
  type Result,
  type OperationError,
  type ErrorCode,
  success,
  failure,
  ErrorCodes,
} from '../../../../utils/result';
import { fetchAllSupabasePages } from '../../../../utils/supabase-pagination';
import { selectRemoteFocusSnapshot } from './focus-console-load';

interface FocusSessionRow {
  id: string;
  user_id: string;
  started_at: string;
  ended_at: string | null;
  session_state: unknown;
  updated_at: string;
}

interface RoutineTaskRow {
  id: string;
  user_id: string;
  title: string;
  max_times_per_day: number;
  is_enabled: boolean;
  updated_at: string;
}

@Injectable({
  providedIn: 'root',
})
export class FocusConsoleSyncService {
  private readonly supabase = inject(SupabaseClientService);
  private readonly syncRpc = inject(SyncRpcClientService);
  private readonly auth = inject(AuthService);
  private readonly logger = inject(LoggerService).category('FocusConsoleSync');
  private readonly sessionManager = inject(SessionManagerService);
  private readonly dataSafetyWriteAudit = new DataSafetyWriteAuditService();

  /** 短时请求去重：同一 userId 的 inflight loadFocusSession 共享同一 Promise */
  private loadInflight: Map<string, Promise<Result<DockSnapshot | null, OperationError>>> = new Map();

  private buildBrowserSuspendedFailure<T>(): Result<T, OperationError> {
    return failure(ErrorCodes.SYNC_OFFLINE, '浏览器恢复连接中，请稍后重试', {
      retryable: true,
      deferred: true,
      reason: 'browser-network-suspended',
    });
  }

  private buildStalePayloadFailure<T>(
    code: ErrorCode,
    message: string,
    result: SyncRpcResult,
  ): Result<T, OperationError> {
    return failure(code, message, {
      retryable: false,
      reason: 'stale-payload-preserved-remotely',
      rpcStatus: result.status,
      rpcReason: result.reason,
      remoteUpdatedAt: result.remoteUpdatedAt,
      serverUpdatedAt: result.serverUpdatedAt,
    });
  }

  private buildSyncRpcRequiredFailure<T>(
    code: ErrorCode,
    message: string,
    operationId: string | undefined,
    context: string,
  ): Result<T, OperationError> {
    const hasOperationId = typeof operationId === 'string' && operationId.length > 0;
    const reason = hasOperationId ? 'sync-rpc-unavailable' : 'missing-operation-id';
    this.logWarn(`${context}: 跳过 legacy 远端直写，保留本地操作等待队列重试`, {
      operationId,
      reason,
      featureEnabled: this.syncRpc.isFeatureEnabled(),
      clientRejected: this.syncRpc.isClientRejected(),
    });
    return failure(code, message, {
      retryable: true,
      deferred: true,
      reason,
      operationId,
      featureEnabled: this.syncRpc.isFeatureEnabled(),
      clientRejected: this.syncRpc.isClientRejected(),
    });
  }

  /**
   * 远端读请求执行器：在检测到 JWT 过期/401 时自动刷新 session 并重试一次。
   * 与 ProjectDataService.withAuthRetry 语义一致：使用 tryRefreshSessionWithSession
   * (allowWhenExpired: true) 绕过 syncState.sessionExpired 短路，避免写路径一旦
   * 将 flag 设为 true 后读路径永远无法触发刷新的死锁。
   */
  private async withAuthRetry<T>(context: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      const enhanced = supabaseErrorToError(error);
      if (!this.sessionManager.isSessionExpiredError(enhanced)) {
        throw error;
      }
      const refreshResult = await this.sessionManager.tryRefreshSessionWithSession(context);
      if (!refreshResult.refreshed) {
        throw error;
      }
      this.logInfo('会话已刷新，重试远端读请求', { context });
      return await fn();
    }
  }

  private logDebug(message: string): void;
  private logDebug(message: string, data: unknown): void;
  private logDebug(message: string, data?: unknown): void {
    try {
      if (arguments.length > 1) {
        this.logger.debug(message, data);
      } else {
        this.logger.debug(message);
      }
    } catch {
      // Diagnostic sinks must not affect focus console sync behavior.
    }
  }

  private logInfo(message: string): void;
  private logInfo(message: string, data: unknown): void;
  private logInfo(message: string, data?: unknown): void {
    try {
      if (arguments.length > 1) {
        this.logger.info(message, data);
      } else {
        this.logger.info(message);
      }
    } catch {
      // Diagnostic sinks must not affect focus console sync behavior.
    }
  }

  private logWarn(message: string): void;
  private logWarn(message: string, data: unknown): void;
  private logWarn(message: string, data?: unknown): void {
    try {
      if (arguments.length > 1) {
        this.logger.warn(message, data);
      } else {
        this.logger.warn(message);
      }
    } catch {
      // Diagnostic sinks must not affect focus console sync behavior.
    }
  }


  /**
   * Supabase client 安全获取：未就绪或未配置时返回 null，
   * 调用方以 SYNC_OFFLINE 错误处理。
   */
  private resolveRemoteSessionUserId(): string | null {
    const currentUserId = this.auth.currentUserId();
    if (currentUserId) {
      return currentUserId;
    }

    const authSettling = !this.auth.sessionInitialized()
      || this.auth.authState().isCheckingSession
      || this.auth.runtimeState() === 'pending';

    return authSettling
      ? (this.auth.peekPersistedSessionIdentity()?.userId ?? null)
      : null;
  }

  private getSupabaseClient(): SupabaseClient | null {
    if (!this.supabase.isConfigured) return null;
    if (!this.resolveRemoteSessionUserId()) return null;
    try {
      return this.supabase.client();
    } catch {
      return null; // eslint-disable-line no-restricted-syntax -- Supabase 未就绪时返回 null，调用方统一转为离线分支
    }
  }

  private shouldUseSyncRpc(operationId?: string): operationId is string {
    return typeof operationId === 'string'
      && operationId.length > 0
      && this.syncRpc.isFeatureEnabled()
      && !this.syncRpc.isClientRejected();
  }

  private async saveFocusSessionViaSyncRpc(
    record: FocusSessionRecord,
    operationId: string,
  ): Promise<Result<void, OperationError>> {
    const localTimestamp = Date.now();
    const updatedAtBaseline = record.updatedAt || null;
    const result = await this.syncRpc.upsertFocusSession({
      operationId,
      record,
    });
    this.recordFocusConsoleRpcWriteAudit({
      ownerUserId: record.userId,
      operationId,
      entityType: 'focus-session',
      entityId: record.id,
      result,
      localTimestamp,
      updatedAtBaseline,
    });
    if (result.stalePayload === true) {
      return this.buildStalePayloadFailure(
        ErrorCodes.FOCUS_CONSOLE_SAVE_FAILED,
        '远端专注会话已更新，本地变更已保留等待处理',
        result,
      );
    }

    if (result.status === 'applied' || result.status === 'idempotent-replay') {
      return success(undefined);
    }

    this.logWarn('saveFocusSession RPC 未应用', {
      operationId,
      status: result.status,
      reason: result.reason,
      stalePayload: result.stalePayload,
    });
    return failure(ErrorCodes.FOCUS_CONSOLE_SAVE_FAILED, '保存专注会话失败');
  }

  private async upsertRoutineTaskViaSyncRpc(
    userId: string,
    task: RoutineTask,
    operationId: string,
  ): Promise<Result<void, OperationError>> {
    const localTimestamp = Date.now();
    const updatedAtBaseline = task.updatedAt ?? null;
    const result = await this.syncRpc.upsertRoutineTask({
      operationId,
      userId,
      task,
    });
    this.recordFocusConsoleRpcWriteAudit({
      ownerUserId: userId,
      operationId,
      entityType: 'routine-task',
      entityId: task.routineId,
      result,
      localTimestamp,
      updatedAtBaseline,
    });
    if (result.stalePayload === true) {
      return this.buildStalePayloadFailure(
        ErrorCodes.FOCUS_CONSOLE_ROUTINE_FAILED,
        '远端日常任务已更新，本地变更已保留等待处理',
        result,
      );
    }

    if (result.status === 'applied' || result.status === 'idempotent-replay') {
      return success(undefined);
    }

    this.logWarn('upsertRoutineTask RPC 未应用', {
      userId,
      operationId,
      status: result.status,
      reason: result.reason,
      stalePayload: result.stalePayload,
    });
    return failure(ErrorCodes.FOCUS_CONSOLE_ROUTINE_FAILED, '更新日常任务失败');
  }

  private recordFocusConsoleRpcWriteAudit(input: {
    ownerUserId: string;
    operationId: string;
    entityType: 'focus-session' | 'routine-task' | 'routine-completion';
    entityId: string;
    result: SyncRpcResult;
    localTimestamp: number;
    updatedAtBaseline: string | null;
  }): void {
    this.dataSafetyWriteAudit.recordWrite({
      ownerUserId: input.ownerUserId,
      operationId: input.operationId,
      sourceUserId: input.ownerUserId,
      entityType: input.entityType,
      entityId: input.entityId,
      operation: 'upsert',
      localTimestamp: input.localTimestamp,
      updatedAtBaseline: input.updatedAtBaseline,
      beforeVersion: input.updatedAtBaseline,
      rpcResult: input.result,
      enteredRetryQueue: false,
      retryCount: 0,
      lastSyncTimeBefore: null,
      lastSyncTimeAfter: null,
    });
  }

  /**
   * 加载远端专注会话快照。
   * 【HR-2 LWW 修复】当提供 localUpdatedAt 时，仅在远端更新时间严格晚于本地时返回，
   * 否则返回 null 表示本地数据更新（Last-Write-Wins）。
   * 【性能优化】同一 userId 的并发请求自动去重，避免重复网络调用。
   */
  async loadFocusSession(
    userId: string,
    localUpdatedAt?: string,
  ): Promise<Result<DockSnapshot | null, OperationError>> {
    // 请求去重：如果同一用户已有 inflight 请求则复用
    const existing = this.loadInflight.get(userId);
    if (existing) {
      this.logDebug('loadFocusSession: 复用已有 inflight 请求', { userId: userId.substring(0, 8) });
      return existing;
    }

    const promise = this.doLoadFocusSession(userId, localUpdatedAt);
    this.loadInflight.set(userId, promise);
    try {
      return await promise;
    } finally {
      this.loadInflight.delete(userId);
    }
  }

  private async doLoadFocusSession(
    userId: string,
    localUpdatedAt?: string,
  ): Promise<Result<DockSnapshot | null, OperationError>> {
    if (isBrowserNetworkSuspendedWindow()) {
      this.logDebug('loadFocusSession: 浏览器网络挂起窗口内跳过远端读取');
      return this.buildBrowserSuspendedFailure();
    }

    const client = this.getSupabaseClient();
    if (!client) {
      // 离线时返回 null，让调用方使用本地数据继续工作
      this.logDebug('离线模式，跳过远端专注会话加载');
      return success(null);
    }

    try {
      const data = await this.withAuthRetry('loadFocusSession', async () => {
        const { data: row, error } = await client
          .from('focus_sessions')
          .select('id,user_id,started_at,ended_at,session_state,updated_at')
          .eq('user_id', userId)
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) throw supabaseErrorToError(error);
        return row;
      });
      return success(selectRemoteFocusSnapshot(data as FocusSessionRow | null, localUpdatedAt));
    } catch (error) {
      if (isBrowserNetworkSuspendedError(error)) {
        this.logDebug('loadFocusSession: 浏览器网络挂起窗口内跳过远端读取');
        return this.buildBrowserSuspendedFailure();
      }

      const enhanced = supabaseErrorToError(error);
      if (this.sessionManager.isSessionExpiredError(enhanced)) {
        this.logInfo('loadFocusSession: 会话不可用，保留本地专注会话快照', {
          code: enhanced.code,
          message: enhanced.message,
        });
        return success(null);
      }

      this.logWarn('loadFocusSession failed', error);
      return failure(ErrorCodes.FOCUS_CONSOLE_LOAD_FAILED, '加载专注会话失败');
    }
  }

  /**
   * 保存专注会话快照到远端。
   * 写入必须走带 operationId 的 Sync RPC；否则返回 deferred failure，
   * 由已持久化的本地队列恢复同步，避免 legacy REST 直写绕过幂等协议。
   */
  async saveFocusSession(
    record: FocusSessionRecord,
    operationId?: string,
  ): Promise<Result<void, OperationError>> {
    if (isBrowserNetworkSuspendedWindow()) {
      this.logDebug('saveFocusSession: 浏览器网络挂起窗口内跳过远端写入');
      return this.buildBrowserSuspendedFailure();
    }

    try {
      if (this.shouldUseSyncRpc(operationId)) {
        return await this.saveFocusSessionViaSyncRpc(record, operationId);
      }

      return this.buildSyncRpcRequiredFailure(
        ErrorCodes.FOCUS_CONSOLE_SAVE_FAILED,
        '保存专注会话等待后台同步',
        operationId,
        'saveFocusSession',
      );
    } catch (error) {
      if (isBrowserNetworkSuspendedError(error)) {
        this.logDebug('saveFocusSession: 浏览器网络挂起窗口内跳过远端写入');
        return this.buildBrowserSuspendedFailure();
      }

      this.logWarn('saveFocusSession failed', error);
      return failure(ErrorCodes.FOCUS_CONSOLE_SAVE_FAILED, '保存专注会话失败');
    }
  }

  async listRoutineTasks(userId: string): Promise<Result<RoutineTask[], OperationError>> {
    if (isBrowserNetworkSuspendedWindow()) {
      this.logDebug('listRoutineTasks: 浏览器网络挂起窗口内跳过远端读取');
      return this.buildBrowserSuspendedFailure();
    }

    const client = this.getSupabaseClient();
    if (!client) {
      // 离线时返回空列表，让调用方使用本地缓存的日常任务
      this.logDebug('离线模式，跳过远端日常任务加载');
      return success([]);
    }

    try {
      const data = await this.withAuthRetry('listRoutineTasks', async () => {
        const { data: rows, error } = await fetchAllSupabasePages<RoutineTaskRow>(() => client
          .from('routine_tasks')
          .select('id,user_id,title,max_times_per_day,is_enabled,updated_at')
          .eq('user_id', userId)
          .order('updated_at', { ascending: false }));
        if (error) throw supabaseErrorToError(error);
        return rows;
      });

      const rows = Array.isArray(data) ? (data as RoutineTaskRow[]) : [];
      return success(rows.map(row => ({
        routineId: row.id,
        title: row.title,
        triggerCondition: 'any-blank-period' as const,
        maxTimesPerDay: row.max_times_per_day,
        isEnabled: row.is_enabled,
        updatedAt: row.updated_at,
      })));
    } catch (error) {
      if (isBrowserNetworkSuspendedError(error)) {
        this.logDebug('listRoutineTasks: 浏览器网络挂起窗口内跳过远端读取');
        return this.buildBrowserSuspendedFailure();
      }

      this.logWarn('listRoutineTasks failed', error);
      return failure(ErrorCodes.FOCUS_CONSOLE_ROUTINE_FAILED, '获取日常任务失败');
    }
  }

  /**
   * 保存日常任务到远端。
   * 写入必须走带 operationId 的 Sync RPC；否则返回 deferred failure，
   * 由已持久化的本地队列恢复同步，避免 legacy REST 直写绕过幂等协议。
   */
  async upsertRoutineTask(
    userId: string,
    task: RoutineTask,
    operationId?: string,
  ): Promise<Result<void, OperationError>> {
    if (isBrowserNetworkSuspendedWindow()) {
      this.logDebug('upsertRoutineTask: 浏览器网络挂起窗口内跳过远端写入');
      return this.buildBrowserSuspendedFailure();
    }

    try {
      if (this.shouldUseSyncRpc(operationId)) {
        return await this.upsertRoutineTaskViaSyncRpc(userId, task, operationId);
      }

      return this.buildSyncRpcRequiredFailure(
        ErrorCodes.FOCUS_CONSOLE_ROUTINE_FAILED,
        '更新日常任务等待后台同步',
        operationId,
        'upsertRoutineTask',
      );
    } catch (error) {
      if (isBrowserNetworkSuspendedError(error)) {
        this.logDebug('upsertRoutineTask: 浏览器网络挂起窗口内跳过远端写入');
        return this.buildBrowserSuspendedFailure();
      }

      this.logWarn('upsertRoutineTask failed', error);
      return failure(ErrorCodes.FOCUS_CONSOLE_ROUTINE_FAILED, '更新日常任务失败');
    }
  }

  /**
   * 递增日常任务完成计数。
   * 通过幂等事件 + 原子聚合 RPC 避免并发丢增量和队列重放双计数。
   */
  async incrementRoutineCompletion(
    mutation: RoutineCompletionMutation,
    operationId?: string,
  ): Promise<Result<void, OperationError>> {
    if (isBrowserNetworkSuspendedWindow()) {
      this.logDebug('incrementRoutineCompletion: 浏览器网络挂起窗口内跳过远端写入');
      return this.buildBrowserSuspendedFailure();
    }

    if (this.shouldUseSyncRpc(operationId)) {
      return await this.incrementRoutineCompletionViaSyncRpc(mutation, operationId);
    }

    return this.buildSyncRpcRequiredFailure(
      ErrorCodes.FOCUS_CONSOLE_INCREMENT_FAILED,
      '完成记录等待后台同步',
      operationId,
      'incrementRoutineCompletion',
    );
  }

  private async incrementRoutineCompletionViaSyncRpc(
    mutation: RoutineCompletionMutation,
    operationId: string,
  ): Promise<Result<void, OperationError>> {
    const localTimestamp = Date.now();
    const result = await this.syncRpc.incrementRoutineCompletion({
      operationId,
      mutation,
    });
    this.recordFocusConsoleRpcWriteAudit({
      ownerUserId: mutation.userId,
      operationId,
      entityType: 'routine-completion',
      entityId: mutation.completionId,
      result,
      localTimestamp,
      updatedAtBaseline: null,
    });
    if (result.status === 'applied' || result.status === 'idempotent-replay') {
      return success(undefined);
    }

    this.logWarn('incrementRoutineCompletion RPC 未应用', {
      userId: mutation.userId,
      operationId,
      status: result.status,
      reason: result.reason,
    });
    return failure(ErrorCodes.FOCUS_CONSOLE_INCREMENT_FAILED, '完成记录更新失败');
  }
}
