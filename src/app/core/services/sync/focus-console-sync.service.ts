import { Injectable, inject } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { SessionManagerService } from './session-manager.service';
import {
  DockSnapshot,
  FocusSessionRecord,
  RoutineCompletionMutation,
  RoutineTask,
} from '../../../../models/parking-dock';
import { nowISO } from '../../../../utils/date';
import { supabaseErrorToError } from '../../../../utils/supabase-error';
import {
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';
import {
  type Result,
  type OperationError,
  success,
  failure,
  ErrorCodes,
} from '../../../../utils/result';
import { PARKING_CONFIG } from '../../../../config/parking.config';

/** 最小化运行时校验：DockSnapshot 至少含合法 version */
function isDockSnapshotLike(value: unknown): value is DockSnapshot {
  if (!value || typeof value !== 'object') return false;
  const v = (value as Record<string, unknown>).version;
  return typeof v === 'number' && v >= 2 && v <= 7;
}

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
  private readonly logger = inject(LoggerService).category('FocusConsoleSync');
  private readonly sessionManager = inject(SessionManagerService);

  /** 短时请求去重：同一 userId 的 inflight loadFocusSession 共享同一 Promise */
  private loadInflight: Map<string, Promise<Result<DockSnapshot | null, OperationError>>> = new Map();

  private buildBrowserSuspendedFailure<T>(): Result<T, OperationError> {
    return failure(ErrorCodes.SYNC_OFFLINE, '浏览器恢复连接中，请稍后重试', {
      retryable: true,
      deferred: true,
      reason: 'browser-network-suspended',
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
      this.logger.info('会话已刷新，重试远端读请求', { context });
      return await fn();
    }
  }


  /**
   * Supabase client 安全获取：未就绪或未配置时返回 null，
   * 调用方以 SYNC_OFFLINE 错误处理。
   */
  private getSupabaseClient(): SupabaseClient | null {
    if (!this.supabase.isConfigured) return null;
    try {
      return this.supabase.client();
    } catch {
      return null;
    }
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
      this.logger.debug('loadFocusSession: 复用已有 inflight 请求', { userId: userId.substring(0, 8) });
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
      this.logger.debug('loadFocusSession: 浏览器网络挂起窗口内跳过远端读取');
      return this.buildBrowserSuspendedFailure();
    }

    const client = this.getSupabaseClient();
    if (!client) {
      // 离线时返回 null，让调用方使用本地数据继续工作
      this.logger.debug('离线模式，跳过远端专注会话加载');
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
      if (!data) return success(null);

      const row = data as FocusSessionRow;

      // H-LWW fix: 用 epoch ms 比较时间戳，避免 ISO 字符串格式差异
      // LWW：本地更新时间 > 远端时，跳过远端数据（本地赢）
      if (localUpdatedAt && row.updated_at) {
        const remoteMs = new Date(row.updated_at).getTime();
        const localMs = new Date(localUpdatedAt).getTime();
        if (Number.isFinite(remoteMs) && Number.isFinite(localMs) && remoteMs < localMs) {
          return success(null);
        }
      }

      const state = row.session_state;
      if (!isDockSnapshotLike(state)) return success(null);
      return success(state);
    } catch (error) {
      if (isBrowserNetworkSuspendedError(error)) {
        this.logger.debug('loadFocusSession: 浏览器网络挂起窗口内跳过远端读取');
        return this.buildBrowserSuspendedFailure();
      }

      this.logger.warn('loadFocusSession failed', error);
      return failure(ErrorCodes.FOCUS_CONSOLE_LOAD_FAILED, '加载专注会话失败');
    }
  }

  /**
   * 保存专注会话快照到远端。
   * 【H-05 说明】当前直接写 Supabase，离线时返回 SYNC_OFFLINE 错误。
   * 调用方（DockCloudSyncService）负责将失败操作入队到 RetryQueue。
   */
  async saveFocusSession(record: FocusSessionRecord): Promise<Result<void, OperationError>> {
    if (isBrowserNetworkSuspendedWindow()) {
      this.logger.debug('saveFocusSession: 浏览器网络挂起窗口内跳过远端写入');
      return this.buildBrowserSuspendedFailure();
    }

    const client = this.getSupabaseClient();
    if (!client) return failure(ErrorCodes.SYNC_OFFLINE, '当前离线');

    try {
      const payload: FocusSessionRow = {
        id: record.id,
        user_id: record.userId,
        started_at: record.startedAt || nowISO(),
        ended_at: record.endedAt,
        session_state: record.snapshot,
        updated_at: record.updatedAt || nowISO(),
      };

      // C-4 fix: 写入前检查远端版本，避免过期重试覆盖更新数据
      const { data: existing } = await client
        .from('focus_sessions')
        .select('session_state')
        .eq('id', record.id)
        .maybeSingle();
      if (existing?.session_state) {
        const remoteSavedAt = (existing.session_state as Record<string, unknown>)?.savedAt;
        const localSavedAt = (record.snapshot as unknown as Record<string, unknown>)?.savedAt;
        if (typeof remoteSavedAt === 'number' && typeof localSavedAt === 'number' && remoteSavedAt > localSavedAt) {
          this.logger.info('saveFocusSession skipped: remote is newer', { remoteSavedAt, localSavedAt });
          return success(undefined);
        }
      }

      const { error } = await client
        .from('focus_sessions')
        .upsert(payload, { onConflict: 'id' });
      if (error) throw supabaseErrorToError(error);
      return success(undefined);
    } catch (error) {
      if (isBrowserNetworkSuspendedError(error)) {
        this.logger.debug('saveFocusSession: 浏览器网络挂起窗口内跳过远端写入');
        return this.buildBrowserSuspendedFailure();
      }

      this.logger.warn('saveFocusSession failed', error);
      return failure(ErrorCodes.FOCUS_CONSOLE_SAVE_FAILED, '保存专注会话失败');
    }
  }

  async listRoutineTasks(userId: string): Promise<Result<RoutineTask[], OperationError>> {
    if (isBrowserNetworkSuspendedWindow()) {
      this.logger.debug('listRoutineTasks: 浏览器网络挂起窗口内跳过远端读取');
      return this.buildBrowserSuspendedFailure();
    }

    const client = this.getSupabaseClient();
    if (!client) {
      // 离线时返回空列表，让调用方使用本地缓存的日常任务
      this.logger.debug('离线模式，跳过远端日常任务加载');
      return success([]);
    }

    try {
      const data = await this.withAuthRetry('listRoutineTasks', async () => {
        const { data: rows, error } = await client
          .from('routine_tasks')
          .select('id,user_id,title,max_times_per_day,is_enabled,updated_at')
          .eq('user_id', userId)
          .order('updated_at', { ascending: false });
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
        this.logger.debug('listRoutineTasks: 浏览器网络挂起窗口内跳过远端读取');
        return this.buildBrowserSuspendedFailure();
      }

      this.logger.warn('listRoutineTasks failed', error);
      return failure(ErrorCodes.FOCUS_CONSOLE_ROUTINE_FAILED, '获取日常任务失败');
    }
  }

  /**
   * 保存日常任务到远端。
   * 离线时返回 SYNC_OFFLINE，调用方负责 RetryQueue。
   */
  async upsertRoutineTask(userId: string, task: RoutineTask): Promise<Result<void, OperationError>> {
    if (isBrowserNetworkSuspendedWindow()) {
      this.logger.debug('upsertRoutineTask: 浏览器网络挂起窗口内跳过远端写入');
      return this.buildBrowserSuspendedFailure();
    }

    const client = this.getSupabaseClient();
    if (!client) return failure(ErrorCodes.SYNC_OFFLINE, '当前离线');

    try {
      const payload: RoutineTaskRow = {
        id: task.routineId,
        user_id: userId,
        title: task.title,
        max_times_per_day: task.maxTimesPerDay,
        is_enabled: task.isEnabled,
        updated_at: nowISO(),
      };

      const { error } = await client
        .from('routine_tasks')
        .upsert(payload, { onConflict: 'id' });
      if (error) throw supabaseErrorToError(error);
      return success(undefined);
    } catch (error) {
      if (isBrowserNetworkSuspendedError(error)) {
        this.logger.debug('upsertRoutineTask: 浏览器网络挂起窗口内跳过远端写入');
        return this.buildBrowserSuspendedFailure();
      }

      this.logger.warn('upsertRoutineTask failed', error);
      return failure(ErrorCodes.FOCUS_CONSOLE_ROUTINE_FAILED, '更新日常任务失败');
    }
  }

  /**
   * 递增日常任务完成计数。
   * 【HR-3 修复】冲突时自动重试（读取最新 count 后再更新），
   * 避免静默丢弃增量。
   * DATA-C3 fix: 改为迭代循环，遵守禁递归规则。
   * TODO(NF-ROUTINE-RPC): 替换为 Supabase RPC `increment_routine_completion`
   * 实现真正的原子 `UPDATE ... SET count = count + 1`。
   */
  async incrementRoutineCompletion(
    mutation: RoutineCompletionMutation,
  ): Promise<Result<void, OperationError>> {
    if (isBrowserNetworkSuspendedWindow()) {
      this.logger.debug('incrementRoutineCompletion: 浏览器网络挂起窗口内跳过远端写入');
      return this.buildBrowserSuspendedFailure();
    }

    const client = this.getSupabaseClient();
    if (!client) return failure(ErrorCodes.SYNC_OFFLINE, '当前离线');

    const maxRetries = PARKING_CONFIG.CLOUD_PULL_MAX_RETRIES;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Step 1: 尝试插入（首次完成）
        const { error: insertError } = await client
          .from('routine_completions')
          .insert({
            id: mutation.completionId,
            routine_id: mutation.routineId,
            user_id: mutation.userId,
            date_key: mutation.dateKey,
            count: 1,
          });

        if (!insertError) return success(undefined);

        // 非唯一约束冲突(23505)则为真正错误
        const pgCode = (insertError as unknown as Record<string, unknown>).code;
        if (pgCode !== '23505') {
          throw supabaseErrorToError(insertError);
        }

        // Step 2: 已存在 — 读取当前 count 并乐观更新
        const { data, error } = await client
          .from('routine_completions')
          .select('id,count')
          .eq('user_id', mutation.userId)
          .eq('routine_id', mutation.routineId)
          .eq('date_key', mutation.dateKey)
          .maybeSingle();
        if (error) throw supabaseErrorToError(error);

        if (!data) {
          this.logger.warn('incrementRoutineCompletion: row disappeared after conflict');
          return failure(ErrorCodes.FOCUS_CONSOLE_INCREMENT_FAILED, '完成记录意外消失');
        }

        const record = data as Record<string, unknown>;
        const existingCount = Number(record.count ?? 0);
        const existingId = String(record.id ?? '');
        const nextCount = Math.max(1, existingCount + 1);

        // 乐观并发：filter on expected count 检测并发修改
        const { data: updateResult, error: updateError } = await client
          .from('routine_completions')
          .update({ count: nextCount })
          .eq('id', existingId)
          .eq('user_id', mutation.userId)
          .eq('count', existingCount)
          .select('id');
        if (updateError) throw supabaseErrorToError(updateError);

        if (updateResult && updateResult.length > 0) {
          return success(undefined);
        }

        // 并发冲突，继续下一次迭代重试
        if (attempt < maxRetries) {
          this.logger.warn(`incrementRoutineCompletion: conflict detected, retry ${attempt + 1}/${maxRetries}`);
        }
      } catch (error) {
        if (isBrowserNetworkSuspendedError(error)) {
          this.logger.debug('incrementRoutineCompletion: 浏览器网络挂起窗口内跳过远端写入');
          return this.buildBrowserSuspendedFailure();
        }

        this.logger.warn('incrementRoutineCompletion failed', error);
        return failure(ErrorCodes.FOCUS_CONSOLE_INCREMENT_FAILED, '完成记录更新失败');
      }
    }

    this.logger.warn('incrementRoutineCompletion: conflict persists after retry');
    return failure(ErrorCodes.SYNC_CONFLICT, '并发修改冲突');
  }
}
