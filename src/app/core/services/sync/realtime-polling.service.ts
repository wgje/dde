/**
 * RealtimePollingService - 实时订阅与轮询管理
 * 
 * 职责：
 * - Realtime 订阅项目变更
 * - 轮询同步（流量优化模式）
 * - 订阅状态管理
 * - 降级机制（Realtime → 轮询）
 * 
 * 从 SimpleSyncService 提取，作为 Sprint 9 技术债务修复的一部分
 */

import { Injectable, inject, signal, DestroyRef, effect } from '@angular/core';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { MobileSyncStrategyService } from '../../../../services/mobile-sync-strategy.service';
import { SyncStateService } from './sync-state.service';
import { MOBILE_SYNC_CONFIG, SYNC_CONFIG } from '../../../../config';
import { classifySupabaseClientFailure } from '../../../../utils/supabase-error';
import type { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { isBrowserNetworkSuspendedWindow } from '../../../../utils/browser-network-suspension';
/**
 * 远程变更回调
 */
export type RemoteChangeCallback = (payload: { eventType?: string; projectId?: string } | undefined) => Promise<void>;

/**
 * 用户偏好变更回调
 */
export type UserPreferencesChangeCallback = (payload: { eventType: string; userId: string }) => void;

/**
 * 任务级变更回调
 */
export type TaskChangeCallback = (payload: { eventType: string; taskId: string; projectId: string }) => void;

@Injectable({
  providedIn: 'root'
})
export class RealtimePollingService {
  private static readonly REALTIME_CIRCUIT_STORAGE_KEY = 'nanoflow.realtime-transport-circuit';
  private static readonly REALTIME_CIRCUIT_TTL_MS = 30 * 60 * 1000;
  private static readonly REALTIME_FALLBACK_TOAST_COOLDOWN_MS = 10 * 60 * 1000;

  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('RealtimePolling');
  private readonly toast = inject(ToastService);
  private readonly mobileSyncStrategy = inject(MobileSyncStrategyService);
  private readonly syncState = inject(SyncStateService);
  private readonly destroyRef = inject(DestroyRef);

  /** Realtime 订阅通道 */
  private realtimeChannel: RealtimeChannel | null = null;
  
  /** 轮询定时器 */
  private pollingTimer: ReturnType<typeof setTimeout> | null = null;
  
  /** 当前订阅的项目 ID */
  private currentProjectId: string | null = null;
  private currentUserId: string | null = null;
  private transportGeneration = 0;
  private transportSuspended = false;
  private realtimeBackoffProjectId: string | null = null;
  private realtimeBackoffUntil = 0;
  private realtimeCircuitUntil = 0;
  private realtimeCircuitOwnerUserId: string | null = null;
  private realtimeCircuitFailures = 0;
  private realtimeCircuitLastError: string | null = null;
  private lastRealtimeFallbackToastAt = 0;
  
  /** Realtime 更新是否暂停 */
  private realtimePaused = false;
  
  /** 用户活跃状态 */
  private isUserActive = true;
  
  /** 用户活跃超时定时器 */
  private userActiveTimer: ReturnType<typeof setTimeout> | null = null;

  /** 用户活跃状态事件清理函数 */
  private activityCleanupFns: (() => void)[] = [];

  /** 轮询回调是否正在执行（互斥锁，防止并发 poll） */
  private isPolling = false;
  
  /** Realtime 是否启用（运行时可切换） */
  readonly isRealtimeEnabled = signal<boolean>(SYNC_CONFIG.REALTIME_ENABLED);
  
  /** 远程变更回调 */
  private onRemoteChangeCallback: RemoteChangeCallback | null = null;
  
  /** 用户偏好变更回调 */
  private onUserPreferencesChangeCallback: UserPreferencesChangeCallback | null = null;
  /** 任务级变更回调 */
  private onTaskChangeCallback: TaskChangeCallback | null = null;
  private runtimeInitialized = false;

  constructor() {
    this.loadRealtimeCircuitState();

    effect(() => {
      const enableRealtime = this.mobileSyncStrategy.currentStrategy().enableRealtime;
      if (this.isRealtimeEnabled() !== enableRealtime) {
        this.setRealtimeEnabled(enableRealtime);
      }
    });

    this.destroyRef.onDestroy(() => {
      this.cleanup();
    });
  }

  initializeRuntime(): void {
    if (this.runtimeInitialized) {
      return;
    }

    this.runtimeInitialized = true;
    this.setupUserActivityTracking();
  }

  teardownRuntime(): void {
    if (!this.runtimeInitialized) {
      return;
    }

    this.runtimeInitialized = false;
    this.cleanup();
  }

  /**
   * 获取 Supabase 客户端
   */
  private getSupabaseClient(): SupabaseClient | null {
    if (!this.supabase.isConfigured) {
      const failure = classifySupabaseClientFailure(false);
      this.logger.warn('无法获取 Supabase 客户端', failure);
      this.syncState.setSyncError(failure.message);
      return null;
    }
    try {
      return this.supabase.client();
    } catch (error) {
      const failure = classifySupabaseClientFailure(true, error);
      this.logger.warn('无法获取 Supabase 客户端', {
        category: failure.category,
        message: failure.message
      });
      this.syncState.setSyncError(failure.message);
      // eslint-disable-next-line no-restricted-syntax -- 保持空客户端判定，避免在订阅路径抛出阻断异常
      return null;
    }
  }

  private beginTransportGeneration(): number {
    this.transportGeneration += 1;
    return this.transportGeneration;
  }

  private isTransportGenerationCurrent(transportGeneration: number): boolean {
    return this.transportGeneration === transportGeneration;
  }

  private isTransportContextCurrent(
    transportGeneration: number,
    projectId: string,
    userId: string | null
  ): boolean {
    return this.isTransportGenerationCurrent(transportGeneration)
      && this.currentProjectId === projectId
      && this.currentUserId === userId;
  }

  private canActivateRemoteTransport(): boolean {
    const state = this.syncState.syncState();
    return state.isOnline && !state.offlineMode && !this.transportSuspended;
  }

  private hasActiveTransport(): boolean {
    return this.realtimeChannel !== null || this.pollingTimer !== null || this.isPolling;
  }

  private getRemainingRealtimeBackoffMs(projectId: string): number {
    if (this.realtimeBackoffProjectId !== projectId) {
      return 0;
    }

    return Math.max(0, this.realtimeBackoffUntil - Date.now());
  }

  private armRealtimeBackoff(projectId: string): number {
    const backoffMs = MOBILE_SYNC_CONFIG.MEDIUM_QUALITY_SYNC_DELAY;
    this.realtimeBackoffProjectId = projectId;
    this.realtimeBackoffUntil = Date.now() + backoffMs;
    return backoffMs;
  }

  private clearRealtimeBackoff(projectId?: string): void {
    if (projectId && this.realtimeBackoffProjectId !== projectId) {
      return;
    }

    this.realtimeBackoffProjectId = null;
    this.realtimeBackoffUntil = 0;
  }

  private loadRealtimeCircuitState(): void {
    if (typeof window === 'undefined' || typeof window.sessionStorage === 'undefined') {
      return;
    }

    try {
      const stored = window.sessionStorage.getItem(RealtimePollingService.REALTIME_CIRCUIT_STORAGE_KEY);
      if (!stored) {
        return;
      }

      const parsed = JSON.parse(stored) as {
        until?: number;
        ownerUserId?: string | null;
        failures?: number;
        lastError?: string | null;
        lastToastAt?: number;
      };

      if (typeof parsed.until !== 'number' || parsed.until <= Date.now()) {
        window.sessionStorage.removeItem(RealtimePollingService.REALTIME_CIRCUIT_STORAGE_KEY);
        return;
      }

      this.realtimeCircuitUntil = parsed.until;
      this.realtimeCircuitOwnerUserId = typeof parsed.ownerUserId === 'string' ? parsed.ownerUserId : null;
      this.realtimeCircuitFailures = typeof parsed.failures === 'number' ? parsed.failures : 0;
      this.realtimeCircuitLastError = typeof parsed.lastError === 'string' ? parsed.lastError : null;
      this.lastRealtimeFallbackToastAt = typeof parsed.lastToastAt === 'number' ? parsed.lastToastAt : 0;
    } catch {
      // eslint-disable-next-line no-restricted-syntax -- 存储损坏时静默回退到默认状态即可
    }
  }

  private saveRealtimeCircuitState(): void {
    if (typeof window === 'undefined' || typeof window.sessionStorage === 'undefined') {
      return;
    }

    try {
      window.sessionStorage.setItem(RealtimePollingService.REALTIME_CIRCUIT_STORAGE_KEY, JSON.stringify({
        until: this.realtimeCircuitUntil,
        ownerUserId: this.realtimeCircuitOwnerUserId,
        failures: this.realtimeCircuitFailures,
        lastError: this.realtimeCircuitLastError,
        lastToastAt: this.lastRealtimeFallbackToastAt,
      }));
    } catch {
      // eslint-disable-next-line no-restricted-syntax -- sessionStorage 不可写时保持内存态熔断即可
    }
  }

  private clearRealtimeCircuitState(): void {
    this.realtimeCircuitUntil = 0;
    this.realtimeCircuitOwnerUserId = null;
    this.realtimeCircuitFailures = 0;
    this.realtimeCircuitLastError = null;
    this.lastRealtimeFallbackToastAt = 0;

    if (typeof window === 'undefined' || typeof window.sessionStorage === 'undefined') {
      return;
    }

    try {
      window.sessionStorage.removeItem(RealtimePollingService.REALTIME_CIRCUIT_STORAGE_KEY);
    } catch {
      // eslint-disable-next-line no-restricted-syntax -- 清理失败不影响后续轮询回退
    }
  }

  private getRemainingRealtimeCircuitMs(): number {
    const remainingMs = this.realtimeCircuitUntil - Date.now();
    if (remainingMs > 0) {
      return remainingMs;
    }

    if (this.realtimeCircuitUntil !== 0 || this.realtimeCircuitFailures !== 0 || this.realtimeCircuitLastError !== null) {
      this.clearRealtimeCircuitState();
    }

    return 0;
  }

  private ensureRealtimeCircuitUserScope(userId: string): void {
    if (!this.realtimeCircuitOwnerUserId || this.realtimeCircuitOwnerUserId === userId) {
      return;
    }

    this.clearRealtimeCircuitState();
  }

  private armRealtimeCircuit(userId: string, errorMessage: string | undefined, consecutiveErrors: number): number {
    const now = Date.now();
    this.realtimeCircuitUntil = Math.max(
      this.realtimeCircuitUntil,
      now + RealtimePollingService.REALTIME_CIRCUIT_TTL_MS
    );
    this.realtimeCircuitOwnerUserId = userId;
    this.realtimeCircuitFailures = Math.max(this.realtimeCircuitFailures, consecutiveErrors);
    this.realtimeCircuitLastError = errorMessage ?? null;
    this.saveRealtimeCircuitState();
    return this.realtimeCircuitUntil - now;
  }

  private hasRealtimeTransportSupport(): boolean {
    return typeof WebSocket !== 'undefined';
  }

  private notifyRealtimeFallback(): void {
    const now = Date.now();
    if (now - this.lastRealtimeFallbackToastAt < RealtimePollingService.REALTIME_FALLBACK_TOAST_COOLDOWN_MS) {
      return;
    }

    this.lastRealtimeFallbackToastAt = now;
    this.saveRealtimeCircuitState();
    this.toast.info('实时同步暂不可用', '已切换到定时同步模式');
  }

  private async teardownActiveTransport(preserveContext = false): Promise<void> {
    if (!preserveContext) {
      this.currentProjectId = null;
      this.currentUserId = null;
    }

    this.stopPolling();

    const channel = this.realtimeChannel;
    this.realtimeChannel = null;

    if (channel) {
      const client = this.getSupabaseClient();
      if (client) {
        await client.removeChannel(channel);
      }
    }
  }

  private async unsubscribeFromProjectInternal(): Promise<void> {
    this.transportSuspended = false;
    await this.teardownActiveTransport(false);
  }

  private async activateProjectTransport(
    projectId: string,
    userId: string | null,
    transportGeneration: number
  ): Promise<void> {
    if (!this.isTransportGenerationCurrent(transportGeneration)) {
      return;
    }

    this.currentProjectId = projectId;
    this.currentUserId = userId;

    if (!this.canActivateRemoteTransport()) {
      this.transportSuspended = true;
      this.logger.debug('远端传输暂不可用，已保留项目上下文等待恢复', {
        projectId,
        isOnline: this.syncState.syncState().isOnline,
        offlineMode: this.syncState.syncState().offlineMode,
      });
      return;
    }

    if (!userId) {
      this.logger.warn('Realtime 重订阅缺少 userId，回退到轮询', { projectId });
      this.startPolling(projectId, userId, transportGeneration);
      return;
    }

    if (this.isRealtimeEnabled()) {
      this.ensureRealtimeCircuitUserScope(userId);

      if (!this.hasRealtimeTransportSupport()) {
        this.logger.info('当前环境不支持 WebSocket，继续使用轮询', { projectId });
        this.startPolling(projectId, userId, transportGeneration);
        return;
      }

      const realtimeCircuitMs = this.getRemainingRealtimeCircuitMs();
      if (realtimeCircuitMs > 0) {
        this.logger.info('Realtime 熔断窗口内继续使用轮询', {
          projectId,
          remainingMs: realtimeCircuitMs,
          failures: this.realtimeCircuitFailures,
          lastError: this.realtimeCircuitLastError,
        });
        this.startPolling(projectId, userId, transportGeneration);
        return;
      }

      const realtimeBackoffMs = this.getRemainingRealtimeBackoffMs(projectId);
      if (realtimeBackoffMs > 0) {
        this.logger.info('Realtime 冷却期内继续使用轮询', {
          projectId,
          remainingMs: realtimeBackoffMs,
        });
        this.startPolling(projectId, userId, transportGeneration);
        return;
      }

      await this.subscribeToProjectRealtime(projectId, userId, transportGeneration);
      return;
    }

    this.startPolling(projectId, userId, transportGeneration);
  }

  private async maybeReenterRealtimeFromPolling(
    projectId: string,
    userId: string | null,
    transportGeneration: number,
  ): Promise<boolean> {
    if (!userId || !this.isRealtimeEnabled()) {
      return false;
    }

    if (!this.isTransportContextCurrent(transportGeneration, projectId, userId) || !this.canActivateRemoteTransport()) {
      return false;
    }

    if (this.realtimeChannel) {
      return false;
    }

    if (this.getRemainingRealtimeCircuitMs() > 0 || this.getRemainingRealtimeBackoffMs(projectId) > 0) {
      return false;
    }

    this.logger.info('Realtime 冷却窗口已结束，停止轮询并尝试恢复订阅', { projectId });
    this.stopPolling();
    await this.activateProjectTransport(projectId, userId, transportGeneration);
    return this.realtimeChannel !== null;
  }

  /**
   * 设置用户活跃状态追踪
   */
  private setupUserActivityTracking(): void {
    if (typeof window === 'undefined') return;

    const resetActiveTimer = () => {
      this.isUserActive = true;
      if (this.userActiveTimer) {
        clearTimeout(this.userActiveTimer);
      }
      this.userActiveTimer = setTimeout(() => {
        this.isUserActive = false;
      }, SYNC_CONFIG.USER_ACTIVE_TIMEOUT);
    };

    const events = ['mousedown', 'keydown', 'touchstart', 'scroll'];
    events.forEach(event => {
      window.addEventListener(event, resetActiveTimer, { passive: true });
      this.activityCleanupFns.push(() => window.removeEventListener(event, resetActiveTimer));
    });

    resetActiveTimer();
  }

  /**
   * 设置远程变更回调
   */
  setOnRemoteChange(callback: RemoteChangeCallback): void {
    this.onRemoteChangeCallback = callback;
  }

  /**
   * 是否已注册远程变更回调
   */
  hasRemoteChangeCallback(): boolean {
    return this.onRemoteChangeCallback !== null;
  }

  /**
   * 设置用户偏好变更回调
   */
  setUserPreferencesChangeCallback(callback: UserPreferencesChangeCallback | null): void {
    this.onUserPreferencesChangeCallback = callback;
  }

  setTaskChangeCallback(callback: TaskChangeCallback | null): void {
    this.onTaskChangeCallback = callback;
  }

  /**
   * 触发一次立即远程变更检查（用于前后台恢复等场景）
   *
   * @returns 是否成功触发回调
   */
  async triggerRemoteChange(
    payload?: { eventType?: string; projectId?: string }
  ): Promise<boolean> {
    if (!this.onRemoteChangeCallback || this.realtimePaused) {
      return false;
    }

    const effectivePayload = payload ?? {
      eventType: 'manual',
      projectId: this.currentProjectId ?? undefined
    };

    try {
      await this.onRemoteChangeCallback(effectivePayload);
      return true;
    } catch (error) {
      this.logger.warn('触发立即远程同步失败', { error, payload: effectivePayload });
      return false;
    }
  }

  /**
   * 启用/禁用 Realtime（运行时切换）
   */
  setRealtimeEnabled(enabled: boolean): void {
    this.isRealtimeEnabled.set(enabled);

    const projectId = this.currentProjectId;
    const userId = this.currentUserId;
    if (projectId && !this.transportSuspended) {
      const transportGeneration = this.beginTransportGeneration();
      void this.unsubscribeFromProjectInternal()
        .then(async () => {
          if (!this.isTransportGenerationCurrent(transportGeneration)) {
            return;
          }

          await this.activateProjectTransport(projectId, userId, transportGeneration);
        })
        .catch((error: unknown) => {
          if (!this.isTransportGenerationCurrent(transportGeneration)) {
            return;
          }

          this.logger.warn('Realtime 传输方式切换失败', { error, enabled, projectId });
        });
    }
    
    this.logger.info(`Realtime ${enabled ? '已启用' : '已禁用，使用轮询'}`);
  }

  /**
   * 订阅项目变更（自动选择 Realtime 或轮询）
   */
  async subscribeToProject(projectId: string, userId: string): Promise<void> {
    this.transportSuspended = false;
    const transportGeneration = this.beginTransportGeneration();
    await this.unsubscribeFromProjectInternal();

    if (!this.isTransportGenerationCurrent(transportGeneration)) {
      return;
    }

    await this.activateProjectTransport(projectId, userId, transportGeneration);
  }

  /**
   * 启动轮询
   * 【2026-02-15 修复】添加互斥锁防止 poll 并发执行
   * 确保上一次 poll 完成后才调度下一次，避免同步回调堆积
   */
  private startPolling(projectId: string, userId: string | null, transportGeneration: number): void {
    if (!this.isTransportContextCurrent(transportGeneration, projectId, userId)) {
      return;
    }
    if (!this.canActivateRemoteTransport()) {
      return;
    }

    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
    }
    
    this.logger.info('启动轮询同步', { projectId, interval: SYNC_CONFIG.POLLING_INTERVAL });
    
    const poll = async () => {
      if (!this.isTransportContextCurrent(transportGeneration, projectId, userId)) return;
      if (!this.syncState.syncState().isOnline || this.realtimePaused) return;
      if (await this.maybeReenterRealtimeFromPolling(projectId, userId, transportGeneration)) {
        return;
      }
      // 互斥锁：如果上一次 poll 回调尚未完成，跳过本次
      if (this.isPolling) {
        this.logger.debug('轮询跳过：上一次 poll 仍在执行');
        return;
      }
      this.isPolling = true;
      try {
        if (this.onRemoteChangeCallback) {
          await this.onRemoteChangeCallback({ 
            eventType: 'polling', 
            projectId 
          });
        }
      } catch (e) {
        this.logger.debug('轮询检查失败', e);
      } finally {
        this.isPolling = false;
      }
    };
    
    const getPollingInterval = () => 
      this.isUserActive ? SYNC_CONFIG.POLLING_ACTIVE_INTERVAL : SYNC_CONFIG.POLLING_INTERVAL;
    
    const scheduleNextPoll = () => {
      if (!this.isTransportContextCurrent(transportGeneration, projectId, userId)) {
        return;
      }

      this.pollingTimer = setTimeout(async () => {
        if (!this.isTransportContextCurrent(transportGeneration, projectId, userId)) {
          return;
        }
        await poll();
        if (this.realtimeChannel !== null) {
          return;
        }
        scheduleNextPoll();
      }, getPollingInterval());
    };
    
    void poll().then(() => {
      if (this.isTransportContextCurrent(transportGeneration, projectId, userId) && this.realtimeChannel === null) {
        scheduleNextPoll();
      }
    });
  }

  /**
   * 停止轮询
   */
  private stopPolling(): void {
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  /**
   * 订阅项目实时变更（Realtime 模式）
   */
  private async subscribeToProjectRealtime(
    projectId: string,
    userId: string,
    transportGeneration: number
  ): Promise<void> {
    if (!this.isTransportContextCurrent(transportGeneration, projectId, userId)) {
      return;
    }
    if (!this.canActivateRemoteTransport()) {
      return;
    }

    const client = this.getSupabaseClient();
    if (!client) return;
    
    const channelName = `project:${projectId}:${userId.substring(0, 8)}`;
    
    this.logger.info('启用 Realtime 订阅', { projectId, channel: channelName });
    
    let previousStatus: string | null = null;
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 3;
    
    const channel = client.channel(channelName);

    channel.on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tasks',
          filter: `project_id=eq.${projectId}`
        },
        (payload) => {
          if (!this.isTransportContextCurrent(transportGeneration, projectId, userId)) {
            return;
          }

          const taskData = (payload.new || payload.old) as { id?: string; project_id?: string } | undefined;
          if (taskData?.project_id && taskData.project_id !== projectId) {
            return;
          }
          
          this.logger.debug('收到任务变更', { event: payload.eventType });
          if (this.realtimePaused) {
            return;
          }

          const taskId = taskData?.id;
          if (taskId && this.onTaskChangeCallback) {
            this.onTaskChangeCallback({
              eventType: payload.eventType,
              taskId,
              projectId
            });
          }

          // 所有事件类型统一触发项目级增量拉取
          if (this.onRemoteChangeCallback) {
            this.onRemoteChangeCallback({
              eventType: payload.eventType,
              projectId
            }).catch(e => {
              this.logger.debug('任务级事件触发项目增量拉取失败', e);
            });
          }
        }
      ).on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'connections',
          filter: `project_id=eq.${projectId}`
        },
        (payload) => {
          if (!this.isTransportContextCurrent(transportGeneration, projectId, userId)) {
            return;
          }

          const connData = (payload.new || payload.old) as { project_id?: string } | undefined;
          if (connData?.project_id && connData.project_id !== projectId) {
            return;
          }
          
          this.logger.debug('收到连接变更', { event: payload.eventType });
          if (this.onRemoteChangeCallback && !this.realtimePaused) {
            this.onRemoteChangeCallback({ 
              eventType: payload.eventType, 
              projectId 
            }).catch(e => {
              this.logger.debug('连接级事件触发项目增量拉取失败', e);
            });
          }
        }
      ).on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'user_preferences',
          filter: userId ? `user_id=eq.${userId}` : undefined
        },
        (payload) => {
          if (!this.isTransportContextCurrent(transportGeneration, projectId, userId)) {
            return;
          }

          this.logger.debug('收到用户偏好变更', { event: payload.eventType });
          if (this.onUserPreferencesChangeCallback && !this.realtimePaused && userId) {
            this.onUserPreferencesChangeCallback({
              eventType: payload.eventType,
              userId
            });
          }
        }
      ).subscribe((status, err) => {
        if (!this.isTransportContextCurrent(transportGeneration, projectId, userId)) {
          return;
        }

        if (this.realtimeChannel !== channel) {
          return;
        }

        this.logger.info('Realtime 订阅状态', { status, channel: channelName, previousStatus });

        if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && isBrowserNetworkSuspendedWindow()) {
          this.logger.debug('浏览器网络挂起期间忽略 Realtime 通道中断', {
            status,
            channel: channelName,
            error: err?.message,
          });
          previousStatus = status;
          return;
        }

        if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && !this.isRealtimeEnabled()) {
          this.logger.debug('Realtime 已被策略禁用，忽略通道中断', {
            status,
            channel: channelName,
            error: err?.message,
          });
          previousStatus = status;
          return;
        }
        
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          consecutiveErrors++;
          
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            const realtimeCircuitMs = this.armRealtimeCircuit(userId, err?.message, consecutiveErrors);
            this.sentryLazyLoader.captureMessage('Realtime 订阅错误', {
              level: 'warning',
              extra: {
                status,
                error: err?.message,
                consecutiveErrors,
                degradedToPolling: true,
                realtimeCircuitMs,
              }
            });
            this.logger.warn('Realtime 连续失败，降级到轮询', {
              consecutiveErrors,
              realtimeCircuitMs,
              error: err?.message,
            });
            this.fallbackToPolling(projectId, userId, transportGeneration);
            return;
          }

          this.logger.debug('Realtime 通道瞬时错误，等待连续失败阈值', {
            status,
            channel: channelName,
            consecutiveErrors,
            error: err?.message,
          });
        } else if (status === 'SUBSCRIBED') {
          consecutiveErrors = 0;
          this.clearRealtimeBackoff(projectId);
          this.clearRealtimeCircuitState();
        }
        
        if (status === 'SUBSCRIBED' && previousStatus && previousStatus !== 'SUBSCRIBED') {
          this.logger.info('Realtime 重连成功，触发增量同步', { previousStatus });
          
          if (this.onRemoteChangeCallback && !this.realtimePaused) {
            this.onRemoteChangeCallback({ 
              eventType: 'reconnect', 
              projectId 
            }).catch(e => {
              this.logger.warn('重连后增量同步失败', e);
            });
          }
        }
        
        previousStatus = status;
      });

      this.realtimeChannel = channel;
  }

  /**
   * Realtime 降级到轮询
   */
  private fallbackToPolling(projectId: string, userId: string, transportGeneration: number): void {
    if (!this.isTransportContextCurrent(transportGeneration, projectId, userId)) {
      return;
    }
    if (!this.canActivateRemoteTransport()) {
      return;
    }

    const backoffMs = this.armRealtimeBackoff(projectId);
    this.logger.info('Realtime 降级到轮询模式', { projectId, backoffMs });

    const channel = this.realtimeChannel;
    this.realtimeChannel = null;

    if (channel) {
      const client = this.getSupabaseClient();
      if (client) {
        client.removeChannel(channel).catch((e: unknown) => {
          this.logger.debug('移除 Realtime 通道失败（可能已断开）', { error: e });
        });
      }
    }

    if (!this.isTransportContextCurrent(transportGeneration, projectId, userId)) {
      return;
    }

    this.startPolling(projectId, userId, transportGeneration);
    this.notifyRealtimeFallback();
  }

  /**
   * 取消订阅
   */
  async unsubscribeFromProject(): Promise<void> {
    this.beginTransportGeneration();
    await this.unsubscribeFromProjectInternal();
  }

  async suspendTransport(): Promise<void> {
    const transportGeneration = this.beginTransportGeneration();
    this.transportSuspended = true;
    await this.teardownActiveTransport(true);

    if (!this.isTransportGenerationCurrent(transportGeneration)) {
      return;
    }
  }

  async resumeTransport(): Promise<void> {
    const projectId = this.currentProjectId;
    const userId = this.currentUserId;
    const shouldResume = this.transportSuspended || (!!projectId && !this.hasActiveTransport());
    if (!projectId || !shouldResume) {
      return;
    }

    this.transportSuspended = false;
    const transportGeneration = this.beginTransportGeneration();
    await this.activateProjectTransport(projectId, userId, transportGeneration);
  }

  async resetRealtimeCircuit(reason: string): Promise<void> {
    const hadCircuitState = this.realtimeCircuitUntil > 0
      || this.realtimeCircuitFailures > 0
      || this.realtimeCircuitLastError !== null;
    const hadBackoffState = this.realtimeBackoffUntil > Date.now();
    const shouldReconnect = hadCircuitState
      || hadBackoffState
      || this.transportSuspended
      || this.realtimeChannel === null;

    this.logger.info('重置 Realtime 熔断状态', {
      reason,
      currentProjectId: this.currentProjectId,
      currentUserId: this.currentUserId,
      shouldReconnect,
    });

    this.clearRealtimeCircuitState();
    this.clearRealtimeBackoff();

    const projectId = this.currentProjectId;
    const userId = this.currentUserId;
    if (!projectId || !userId) {
      return;
    }

    if (!this.isRealtimeEnabled() || !this.canActivateRemoteTransport()) {
      return;
    }

    if (!shouldReconnect) {
      return;
    }

    const transportGeneration = this.beginTransportGeneration();
    await this.teardownActiveTransport(true);

    if (!this.isTransportGenerationCurrent(transportGeneration)) {
      return;
    }

    await this.activateProjectTransport(projectId, userId, transportGeneration);
  }

  /**
   * 暂停 Realtime 更新
   */
  pauseRealtimeUpdates(): void {
    this.realtimePaused = true;
  }

  /**
   * 恢复 Realtime 更新
   */
  resumeRealtimeUpdates(): void {
    this.realtimePaused = false;
  }

  /**
   * 获取当前项目 ID
   */
  getCurrentProjectId(): string | null {
    return this.currentProjectId;
  }

  /**
   * 清理资源
   */
  private cleanup(): void {
    this.beginTransportGeneration();
    this.transportSuspended = false;
    this.currentProjectId = null;
    this.currentUserId = null;
    this.clearRealtimeBackoff();
    this.stopPolling();

    // 清理 realtime channel
    const channel = this.realtimeChannel;
    this.realtimeChannel = null;

    if (channel) {
      const client = this.getSupabaseClient();
      if (client) {
        client.removeChannel(channel).catch((e: unknown) => {
          this.logger.debug('清理时移除 Realtime 通道失败', { error: e });
        });
      }
    }

    if (this.userActiveTimer) {
      clearTimeout(this.userActiveTimer);
      this.userActiveTimer = null;
    }

    // 移除用户活跃状态事件监听器
    for (const cleanupFn of this.activityCleanupFns) {
      cleanupFn();
    }
    this.activityCleanupFns = [];
  }
}
