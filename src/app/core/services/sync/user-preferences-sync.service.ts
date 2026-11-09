/**
 * UserPreferencesSyncService - 用户偏好同步服务
 * 
 * 职责：
 * - 加载用户偏好 (loadUserPreferences)
 * - 保存用户偏好 (saveUserPreferences)
 * 
 * 从 SimpleSyncService 提取，Sprint 9 技术债务修复
 */

import { Injectable, inject } from '@angular/core';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { SyncRpcClientService, type SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import { DataSafetyWriteAuditService } from '../../../../services/data-safety-write-audit.service';
import { UserPreferences, ThemeType, ColorMode } from '../../../../models';
import { FocusPreferences, DEFAULT_FOCUS_PREFERENCES } from '../../../../models/focus';
import { supabaseErrorToError } from '../../../../utils/supabase-error';
import {
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';
import type { SupabaseClient } from '@supabase/supabase-js';
import { UserPreferencesBaselineStore } from '../../../../services/user-preferences-baseline.store';
import type { QueueProcessorContext } from '../../../../services/action-queue-processing.types';

@Injectable({
  providedIn: 'root'
})
export class UserPreferencesSyncService {
  private readonly supabase = inject(SupabaseClientService);
  private readonly syncRpc = inject(SyncRpcClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('UserPrefsSync');
  private readonly dataSafetyWriteAudit = new DataSafetyWriteAuditService();
  private readonly baselineStore = inject(UserPreferencesBaselineStore);

  private shouldDeferForBrowserSuspension(
    operation: '加载' | '保存',
    userId: string,
    error?: unknown,
  ): boolean {
    const suspended = error === undefined
      ? isBrowserNetworkSuspendedWindow()
      : isBrowserNetworkSuspendedError(error) || isBrowserNetworkSuspendedWindow();

    if (!suspended) {
      return false;
    }

    this.logger.debug(`浏览器网络挂起，延后${operation}用户偏好`, { userId });
    return true;
  }

  private parseFocusPreferences(value: unknown): FocusPreferences | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }

    const fp = value as Record<string, unknown>;
    const parsed: FocusPreferences & { updatedAt?: string } = {
      gateEnabled: (fp['gateEnabled'] as boolean) ?? DEFAULT_FOCUS_PREFERENCES.gateEnabled,
      strataEnabled: (fp['strataEnabled'] as boolean) ?? DEFAULT_FOCUS_PREFERENCES.strataEnabled,
      blackBoxEnabled: (fp['blackBoxEnabled'] as boolean) ?? DEFAULT_FOCUS_PREFERENCES.blackBoxEnabled,
      maxSnoozePerDay: (fp['maxSnoozePerDay'] as number) ?? DEFAULT_FOCUS_PREFERENCES.maxSnoozePerDay,
      routineResetHourLocal:
        (fp['routineResetHourLocal'] as number) ?? DEFAULT_FOCUS_PREFERENCES.routineResetHourLocal,
      restReminderHighLoadMinutes:
        (fp['restReminderHighLoadMinutes'] as number) ?? DEFAULT_FOCUS_PREFERENCES.restReminderHighLoadMinutes,
      restReminderLowLoadMinutes:
        (fp['restReminderLowLoadMinutes'] as number) ?? DEFAULT_FOCUS_PREFERENCES.restReminderLowLoadMinutes,
    };

    if (typeof fp['updatedAt'] === 'string') {
      parsed.updatedAt = fp['updatedAt'];
    }

    return parsed;
  }

  private normalizePreferences(preferences: Partial<UserPreferences>): Partial<UserPreferences> {
    const normalized: Partial<UserPreferences> = {};
    if (preferences.theme !== undefined) normalized.theme = preferences.theme;
    if (preferences.layoutDirection !== undefined) normalized.layoutDirection = preferences.layoutDirection;
    if (preferences.floatingWindowPref !== undefined) normalized.floatingWindowPref = preferences.floatingWindowPref;
    if (preferences.colorMode !== undefined) normalized.colorMode = preferences.colorMode;
    if (preferences.autoResolveConflicts !== undefined) {
      normalized.autoResolveConflicts = preferences.autoResolveConflicts;
    }
    if (preferences.localBackupEnabled !== undefined) normalized.localBackupEnabled = preferences.localBackupEnabled;
    if (preferences.localBackupIntervalMs !== undefined) {
      normalized.localBackupIntervalMs = preferences.localBackupIntervalMs;
    }
    if (preferences.lastBackupProofAt !== undefined) normalized.lastBackupProofAt = preferences.lastBackupProofAt;
    if (preferences.focusPreferences !== undefined) normalized.focusPreferences = preferences.focusPreferences;
    return normalized;
  }

  private canUseSyncRpc(): boolean {
    return this.syncRpc.isFeatureEnabled()
      && !this.syncRpc.isClientRejected();
  }

  private recordUserPreferencesRpcWriteAudit(input: {
    operationId: string;
    userId: string;
    preferences: Partial<UserPreferences>;
    result: SyncRpcResult;
    localTimestamp: number;
    updatedAtBaseline: string | null;
  }): void {
    this.dataSafetyWriteAudit.recordWrite({
      ownerUserId: input.userId,
      operationId: input.operationId,
      sourceUserId: input.userId,
      entityType: 'preference',
      entityId: input.userId,
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
   * 获取 Supabase 客户端
   */
  private getSupabaseClient(): SupabaseClient | null {
    if (!this.supabase.isConfigured) return null;
    try {
      return this.supabase.client();
    } catch {
      // eslint-disable-next-line no-restricted-syntax -- 返回 null 语义正确：客户端不可用时静默降级
      return null;
    }
  }
  
  /**
   * 加载用户偏好
   * 
   * 【修复】查询所有偏好字段，支持跨设备同步 colorMode/autoResolveConflicts/localBackup/focusPreferences
   */
  async loadUserPreferences(userId: string): Promise<UserPreferences | null> {
    const client = this.getSupabaseClient();
    if (!client) return null;

    if (this.shouldDeferForBrowserSuspension('加载', userId)) {
      return null;
    }
    
    try {
      const { data, error } = await client
        .from('user_preferences')
        .select('theme,layout_direction,floating_window_pref,color_mode,auto_resolve_conflicts,local_backup_enabled,local_backup_interval_ms,last_backup_proof_at,focus_preferences,updated_at')
        .eq('user_id', userId)
        .maybeSingle();
      
      if (error) throw supabaseErrorToError(error);
      if (!data) return null;
      await this.persistConfirmedBaseline(userId, data.updated_at);
      
      // 解析 focusPreferences（JSONB → 领域模型）
      const focusPreferences = this.parseFocusPreferences(data.focus_preferences);

      return {
        theme: (data.theme as ThemeType) || 'default',
        layoutDirection: (data.layout_direction as 'ltr' | 'rtl') || 'ltr',
        floatingWindowPref: (data.floating_window_pref as 'auto' | 'fixed') || 'auto',
        colorMode: (data.color_mode as ColorMode) || 'system',
        autoResolveConflicts: data.auto_resolve_conflicts ?? true,
        localBackupEnabled: data.local_backup_enabled ?? false,
        localBackupIntervalMs: data.local_backup_interval_ms ?? 3600000,
        lastBackupProofAt: data.last_backup_proof_at ?? undefined,
        focusPreferences,
      };
    } catch (e) {
      if (this.shouldDeferForBrowserSuspension('加载', userId, e)) {
        return null;
      }

      this.logger.error('加载用户偏好失败', e);
      // eslint-disable-next-line no-restricted-syntax -- 返回 null 语义正确：偏好加载失败使用默认值
      return null;
    }
  }
  
  /**
   * 保存用户偏好
   * 
   * 写入必须走带 operationId 的 Sync RPC；否则返回 false，
   * 由持久化的 ActionQueue/PendingPreferenceOutbox 恢复同步。
   */
  async saveUserPreferences(
    userId: string,
    preferences: Partial<UserPreferences>,
    operationId?: string,
    baseUpdatedAt?: string | null,
    replayContext?: QueueProcessorContext,
  ): Promise<boolean> {
    if (!this.isReplayCurrent(replayContext)) return false;
    if (this.shouldDeferForBrowserSuspension('保存', userId)) {
      return false;
    }

    try {
      const normalizedPreferences = this.normalizePreferences(preferences);
      const hasOperationId = typeof operationId === 'string' && operationId.length > 0;

      if (hasOperationId && this.canUseSyncRpc()) {
        return await this.saveUserPreferencesViaSyncRpc(
          userId,
          normalizedPreferences,
          operationId,
          baseUpdatedAt,
          replayContext,
        );
      }

      this.logger.warn('保存用户偏好跳过 legacy upsert：缺少可用 Sync RPC，保留本地队列等待重试', {
        userId,
        operationId,
        reason: hasOperationId ? 'sync-rpc-unavailable' : 'missing-operation-id',
        featureEnabled: this.syncRpc.isFeatureEnabled(),
        clientRejected: this.syncRpc.isClientRejected(),
      });
      return false;
    } catch (e) {
      if (!this.isReplayCurrent(replayContext)) return false;
      if (this.shouldDeferForBrowserSuspension('保存', userId, e)) {
        return false;
      }

      this.logger.error('保存用户偏好失败', e);
      return false;
    }
  }

  private async saveUserPreferencesViaSyncRpc(
    userId: string,
    preferences: Partial<UserPreferences>,
    operationId: string,
    baseUpdatedAt: string | null | undefined,
    replayContext?: QueueProcessorContext,
  ): Promise<boolean> {
    const localTimestamp = Date.now();
    if (!this.isReplayCurrent(replayContext)) return false;
    let updatedAtBaseline = baseUpdatedAt;
    if (updatedAtBaseline === undefined) {
      updatedAtBaseline = await this.baselineStore.read(userId);
      if (!this.isReplayCurrent(replayContext)) return false;
    }
    if (!this.isReplayCurrent(replayContext)) return false;
    const result = await this.syncRpc.upsertUserPreferences({
      operationId,
      userId,
      baseUpdatedAt: updatedAtBaseline,
      preferences,
      abortSignal: replayContext?.leaseSignal,
      isCurrent: replayContext?.isCurrent,
    });
    if (!this.isReplayCurrent(replayContext)) return false;
    if (result.status === 'applied' || result.status === 'idempotent-replay') {
      if (!await this.persistReplayBaseline(
        userId, operationId, result.serverUpdatedAt, replayContext,
      )) return false;
      if (!this.isReplayCurrent(replayContext)) return false;
      this.recordReplayAudit(
        operationId, userId, preferences, result, localTimestamp, updatedAtBaseline,
      );
      if (!this.isReplayCurrent(replayContext)) return false;
      return true;
    }
    if (!this.isReplayCurrent(replayContext)) return false;
    this.recordReplayAudit(
      operationId, userId, preferences, result, localTimestamp, updatedAtBaseline,
    );
    if (!this.isReplayCurrent(replayContext)) return false;
    this.logger.warn(`保存用户偏好 RPC 未应用：${result.status}`, {
      userId,
      operationId,
      reason: result.reason,
    });
    return false;
  }

  private async persistReplayBaseline(
    userId: string,
    operationId: string,
    serverUpdatedAt: string | undefined,
    replayContext?: QueueProcessorContext,
  ): Promise<boolean> {
    if (!serverUpdatedAt) return this.isReplayCurrent(replayContext);
    try {
      if (!this.isReplayCurrent(replayContext)) return false;
      await this.baselineStore.save(userId, serverUpdatedAt);
      return this.isReplayCurrent(replayContext);
    } catch (error) {
      if (!this.isReplayCurrent(replayContext)) return false;
      this.logger.error('偏好 RPC 已应用但新 baseline 本地持久化失败，保留队列等待幂等重放', {
        userId,
        operationId,
        serverUpdatedAt,
        error,
      });
      return false;
    }
  }

  private recordReplayAudit(
    operationId: string,
    userId: string,
    preferences: Partial<UserPreferences>,
    result: SyncRpcResult,
    localTimestamp: number,
    updatedAtBaseline: string | null,
  ): void {
    this.recordUserPreferencesRpcWriteAudit({
      operationId,
      userId,
      preferences,
      result,
      localTimestamp,
      updatedAtBaseline,
    });
  }

  private isReplayCurrent(context?: QueueProcessorContext): boolean {
    return context === undefined
      || (context.leaseSignal !== undefined
        && !context.leaseSignal.aborted
        && context.isCurrent?.() === true);
  }

  private async persistConfirmedBaseline(userId: string, updatedAt: unknown): Promise<void> {
    if (typeof updatedAt !== 'string' || updatedAt.length === 0) {
      return;
    }
    try {
      await this.baselineStore.save(userId, updatedAt);
    } catch (error) {
      this.logger.warn('云端偏好已加载，但 confirmed baseline 持久化失败', {
        userId,
        updatedAt,
        error,
      });
    }
  }
}
