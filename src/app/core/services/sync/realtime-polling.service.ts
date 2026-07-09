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
import { MobileSyncStrategyService } from '../../../../services/mobile-sync-strategy.service';
import { SyncStateService } from './sync-state.service';
import { SYNC_CONFIG } from '../../../../config';
import type { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { RealtimeTransportCircuitService } from './realtime-transport-circuit.service';
import { RealtimePollingSchedulerController } from './realtime-polling-scheduler.controller';
import {
  RealtimeStatusController,
  type RealtimeStatusError,
  type RealtimeSubscribeState,
} from './realtime-status.controller';
import {
  RealtimePayloadDispatchController,
  type RealtimePayloadDispatchRuntime,
  type RemoteChangeCallback,
  type TaskChangeCallback,
  type UserPreferencesChangeCallback,
} from './realtime-payload-dispatch.controller';
import { createRealtimePollingRuntime } from './realtime-polling-runtime.factory';
import { createRealtimeChannelSubscription } from './realtime-channel-subscription.factory';
import {
  activateRealtimeTransportOrFallbackToPolling,
} from './realtime-polling-activation-fallback.helpers';
import { cleanupRealtimePollingTransport } from './realtime-polling-cleanup.helpers';
import {
  shouldAttemptRealtimeReentryFromPolling,
} from './realtime-polling-reentry.helpers';
import {
  createEffectiveRealtimeRemoteChangePayload,
  getStaleRealtimeRemoteChangePayload,
  RealtimeRemoteChangeDedupController,
} from './realtime-remote-change-dedup.controller';
import { teardownRealtimeChannel } from './realtime-channel-teardown.helpers';
import {
  pauseRealtimePollingUpdates,
  resumeRealtimePollingUpdates,
  shouldStartPollingFallbackAfterRealtimeResume,
} from './realtime-polling-pause-resume.helpers';
import { getRealtimeSupabaseClient } from './realtime-supabase-client.helpers';
export type {
  RemoteChangeCallback,
  TaskChangeCallback,
  UserPreferencesChangeCallback,
} from './realtime-payload-dispatch.controller';

@Injectable({
  providedIn: 'root'
})
export class RealtimePollingService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('RealtimePolling');
  private readonly mobileSyncStrategy = inject(MobileSyncStrategyService);
  private readonly syncState = inject(SyncStateService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly transportCircuit = inject(RealtimeTransportCircuitService);

  /** Realtime 订阅通道 */
  private realtimeChannel: RealtimeChannel | null = null;

  /** 当前订阅的项目 ID */
  private currentProjectId: string | null = null;
  private currentUserId: string | null = null;
  private transportGeneration = 0;
  private transportSuspended = false;
  private destroyed = false;

  /** Realtime 更新是否暂停 */
  private realtimePaused = false;
  private pollingFallbackActive = false;
  private restartPollingOnRealtimeResume = false;

  private readonly pollingScheduler = new RealtimePollingSchedulerController(this.logger);
  private readonly realtimeStatus = new RealtimeStatusController(
    this.logger,
    this.sentryLazyLoader,
    this.transportCircuit,
  );
  private readonly realtimePayloadDispatch = new RealtimePayloadDispatchController(this.logger);

  /** Realtime 是否启用（运行时可切换） */
  readonly isRealtimeEnabled = signal<boolean>(SYNC_CONFIG.REALTIME_ENABLED);

  /** 远程变更回调 */
  private onRemoteChangeCallback: RemoteChangeCallback | null = null;

  /** 用户偏好变更回调 */
  private onUserPreferencesChangeCallback: UserPreferencesChangeCallback | null = null;
  /** 任务级变更回调 */
  private onTaskChangeCallback: TaskChangeCallback | null = null;
  private readonly remoteChangeDedup = new RealtimeRemoteChangeDedupController(SYNC_CONFIG.REMOTE_CHANGE_DELAY);
  private readonly realtimePayloadDispatchRuntime: RealtimePayloadDispatchRuntime = {
    isStateCurrent: (state) => this.isRealtimeSubscribeStateCurrent(state),
    isPaused: () => this.realtimePaused,
    getRemoteChangeCallback: () => this.onRemoteChangeCallback,
    getUserPreferencesChangeCallback: () => this.onUserPreferencesChangeCallback,
    getTaskChangeCallback: () => this.onTaskChangeCallback,
  };
  private runtimeInitialized = false;

  constructor() {
    this.transportCircuit.loadState();

    effect(() => {
      const enableRealtime = this.mobileSyncStrategy.currentStrategy().enableRealtime;
      if (this.isRealtimeEnabled() !== enableRealtime) {
        this.setRealtimeEnabled(enableRealtime);
      }
    });

    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.cleanup();
    });
  }

  initializeRuntime(): void {
    if (this.destroyed) {
      return;
    }
    if (this.runtimeInitialized) {
      return;
    }

    this.runtimeInitialized = true;
    this.pollingScheduler.startUserActivityTracking();
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
    return getRealtimeSupabaseClient({
      supabase: this.supabase,
      logger: this.logger,
      syncState: this.syncState,
    });
  }

  private beginTransportGeneration(): number {
    this.pollingFallbackActive = false;
    this.restartPollingOnRealtimeResume = false;
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
    return this.realtimeChannel !== null || this.pollingScheduler.hasActivePolling();
  }

  private hasRealtimeTransportSupport(): boolean {
    return typeof WebSocket !== 'undefined';
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
      await teardownRealtimeChannel({
        channel,
        client: this.getSupabaseClient(),
        logger: this.logger,
        removeFailureMessage: 'Realtime 旧通道移除失败，继续切换传输',
        fallbackUnsubscribeMessage: 'Realtime 旧通道兜底取消失败',
        removeFailureLevel: 'warn',
      });
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
      await this.activateRealtimeOrFallbackToPolling(projectId, userId, transportGeneration);
    } else {
      this.startPolling(projectId, userId, transportGeneration);
    }
  }

  private async activateRealtimeOrFallbackToPolling(
    projectId: string,
    userId: string,
    transportGeneration: number,
  ): Promise<void> {
    this.transportCircuit.ensureUserScope(userId);
    await activateRealtimeTransportOrFallbackToPolling({
      projectId,
      userId,
      transportGeneration,
      realtimeTransportSupported: this.hasRealtimeTransportSupport(),
      transportCircuit: this.transportCircuit,
      logger: this.logger,
      startPolling: (projectId, userId, transportGeneration) =>
        this.startPolling(projectId, userId, transportGeneration),
      subscribeRealtime: (projectId, userId, transportGeneration) =>
        this.subscribeToProjectRealtime(projectId, userId, transportGeneration),
    });
  }

  private async maybeReenterRealtimeFromPolling(
    projectId: string,
    userId: string | null,
    transportGeneration: number,
  ): Promise<boolean> {
    if (!shouldAttemptRealtimeReentryFromPolling({
      projectId,
      userId,
      transportGeneration,
      realtimeEnabled: this.isRealtimeEnabled(),
      transportContextCurrent: userId
        ? this.isTransportContextCurrent(transportGeneration, projectId, userId)
        : false,
      remoteTransportActivatable: this.canActivateRemoteTransport(),
      hasActiveRealtimeChannel: this.realtimeChannel !== null,
      realtimeTransportSupported: this.hasRealtimeTransportSupport(),
      remainingCircuitMs: this.transportCircuit.remainingCircuitMs(),
      remainingBackoffMs: this.transportCircuit.remainingBackoffMs(projectId),
    })) {
      return false;
    }

    const activeUserId = userId;
    this.logger.info('Realtime 冷却窗口已结束，尝试恢复订阅', { projectId });
    try {
      await this.activateProjectTransport(projectId, activeUserId, transportGeneration);
    } catch (error) {
      this.logger.warn('Realtime 轮询恢复订阅失败，继续保留轮询兜底', { projectId, error });
      return false;
    }

    if (!this.isTransportContextCurrent(transportGeneration, projectId, activeUserId)) {
      return false;
    }

    if (this.realtimeChannel === null) {
      return false;
    }

    this.stopPolling();
    return true;
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
    return this.runRemoteChange(payload, '触发立即远程同步失败');
  }

  private async runRemoteChange(
    payload: { eventType?: string; projectId?: string } | undefined,
    failureMessage: string,
  ): Promise<boolean> {
    if (this.destroyed) {
      return false;
    }
    if (this.realtimePaused) {
      return false;
    }

    const effectivePayload = createEffectiveRealtimeRemoteChangePayload(payload, this.currentProjectId);
    const stalePayload = getStaleRealtimeRemoteChangePayload(effectivePayload, this.currentProjectId);
    if (stalePayload) {
      this.logger.debug('跳过过期项目的立即远程同步触发', stalePayload);
      return false;
    }

    return this.remoteChangeDedup.run(effectivePayload, {
      callback: this.onRemoteChangeCallback,
      failureMessage,
      logger: this.logger,
    });
  }

  /**
   * 启用/禁用 Realtime（运行时切换）
   */
  setRealtimeEnabled(enabled: boolean): void {
    if (this.destroyed) {
      return;
    }

    if (this.isRealtimeEnabled() === enabled) {
      return;
    }

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
          if (this.destroyed) {
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
    if (this.destroyed) {
      return;
    }

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
    if (
      this.isTransportContextCurrent(transportGeneration, projectId, userId)
      && this.canActivateRemoteTransport()
      && this.realtimeChannel === null
    ) {
      this.pollingFallbackActive = true;
    }
    this.pollingScheduler.startPolling(projectId, userId, transportGeneration, this.createPollingRuntime());
  }

  private async runPollingTick(
    projectId: string,
    userId: string | null,
    transportGeneration: number,
  ): Promise<void> {
    await this.pollingScheduler.runPollingTick(projectId, userId, transportGeneration, this.createPollingRuntime());
  }

  /**
   * 停止轮询
   */
  private stopPolling(): void {
    this.pollingFallbackActive = false;
    this.pollingScheduler.stopPolling();
  }

  private createPollingRuntime() {
    return createRealtimePollingRuntime({
      isTransportContextCurrent: (
        transportGeneration: number,
        projectId: string,
        userId: string | null,
      ) => this.isTransportContextCurrent(transportGeneration, projectId, userId),
      canActivateRemoteTransport: () => this.canActivateRemoteTransport(),
      getSyncState: () => this.syncState.syncState(),
      getRealtimePaused: () => this.realtimePaused,
      getRealtimeChannel: () => this.realtimeChannel,
      getCurrentProjectId: () => this.currentProjectId,
      getCurrentUserId: () => this.currentUserId,
      getTransportGeneration: () => this.transportGeneration,
      maybeReenterRealtimeFromPolling: (
        projectId: string,
        userId: string | null,
        transportGeneration: number,
      ) => this.maybeReenterRealtimeFromPolling(projectId, userId, transportGeneration),
      // 轮询 tick 的回调必须与 triggerRemoteChange 走同一条去重/stale 守卫通道：
      // 直连裸回调会绕过 remoteChangeDedup，重连时首个 tick 与 reconnect
      // 扇出在同一秒各自发起一次活动项目拉取
      getOnRemoteChangeCallback: () => this.onRemoteChangeCallback === null
        ? null
        : (payload) => this.runRemoteChange(
            payload ?? { eventType: 'polling', projectId: this.currentProjectId ?? undefined },
            '轮询触发远程同步失败',
          ).then(() => undefined),
    });
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

    const state = createRealtimeChannelSubscription({
      client,
      projectId,
      userId,
      transportGeneration,
      dispatchRuntime: this.realtimePayloadDispatchRuntime,
      logger: this.logger,
      handleTaskPayload: (...args) =>
        this.realtimePayloadDispatch.handleTaskRealtimePayload(...args),
      handleConnectionPayload: (...args) =>
        this.realtimePayloadDispatch.handleConnectionRealtimePayload(...args),
      handleUserPreferencesPayload: (...args) =>
        this.realtimePayloadDispatch.handleUserPreferencesRealtimePayload(...args),
      handleStatus: (status, err, state) =>
        this.handleRealtimeSubscribeStatus(status, err, state),
    });
    this.realtimeChannel = state.channel;
    this.pollingFallbackActive = false;
  }

  private handleRealtimeSubscribeStatus(
    status: string,
    err: RealtimeStatusError | undefined,
    state: RealtimeSubscribeState,
  ): void {
    this.realtimeStatus.handleSubscribeStatus(status, err, state, {
      isStateCurrent: (state) => this.isRealtimeSubscribeStateCurrent(state),
      isRealtimeEnabled: () => this.isRealtimeEnabled(),
      fallbackToPolling: (projectId, userId, transportGeneration) =>
        this.fallbackToPolling(projectId, userId, transportGeneration),
      triggerRealtimeReconnectChange: (projectId) => this.triggerRealtimeReconnectChange(projectId),
    });
  }

  private isRealtimeSubscribeStateCurrent(state: RealtimeSubscribeState): boolean {
    return this.isTransportContextCurrent(state.transportGeneration, state.projectId, state.userId)
      && this.realtimeChannel === state.channel;
  }

  private triggerRealtimeReconnectChange(projectId: string): void {
    void this.runRemoteChange({
      eventType: 'reconnect',
      projectId
    }, '重连后增量同步失败');
  }

  /**
   * Realtime 降级到轮询
   */
  private fallbackToPolling(projectId: string, userId: string, transportGeneration: number): void {
    if (!this.isTransportContextCurrent(transportGeneration, projectId, userId)) {
      return;
    }

    const channel = this.realtimeChannel;
    this.realtimeChannel = null;

    if (channel) {
      void teardownRealtimeChannel({
        channel,
        client: this.getSupabaseClient(),
        logger: this.logger,
        removeFailureMessage: '移除 Realtime 通道失败（可能已断开）',
        fallbackUnsubscribeMessage: '移除 Realtime 通道失败（无 Supabase client）',
      });
    }

    if (!this.canActivateRemoteTransport()) {
      this.transportSuspended = true;
      this.logger.debug('Realtime 降级时远端传输暂不可用，等待恢复后重新激活', {
        projectId,
        isOnline: this.syncState.syncState().isOnline,
        offlineMode: this.syncState.syncState().offlineMode,
      });
      return;
    }

    const backoffMs = this.transportCircuit.armBackoff(projectId);
    this.logger.info('Realtime 降级到轮询模式', { projectId, backoffMs });

    if (!this.isTransportContextCurrent(transportGeneration, projectId, userId)) {
      return;
    }

    this.startPolling(projectId, userId, transportGeneration);
    this.transportCircuit.notifyFallback();
  }

  /**
   * 取消订阅
   */
  async unsubscribeFromProject(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    this.beginTransportGeneration();
    await this.unsubscribeFromProjectInternal();
  }

  async suspendTransport(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    const transportGeneration = this.beginTransportGeneration();
    this.transportSuspended = true;
    await this.teardownActiveTransport(true);

    if (!this.isTransportGenerationCurrent(transportGeneration)) {
      return;
    }
  }

  async resumeTransport(): Promise<void> {
    if (this.destroyed) {
      return;
    }

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
    if (this.destroyed) {
      return;
    }

    const hadCircuitState = this.transportCircuit.hasCircuitState();
    const hadBackoffState = this.transportCircuit.hasActiveBackoff();
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

    this.transportCircuit.clearCircuit();
    this.transportCircuit.clearBackoff();

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
    if (this.destroyed) {
      return;
    }
    const state = pauseRealtimePollingUpdates({
      realtimeChannel: this.realtimeChannel,
      pollingFallbackActive: this.pollingFallbackActive,
      restartPollingOnRealtimeResume: this.restartPollingOnRealtimeResume,
    });
    this.realtimePaused = state.realtimePaused;
    this.restartPollingOnRealtimeResume = state.restartPollingOnRealtimeResume;
  }

  /**
   * 恢复 Realtime 更新
   */
  resumeRealtimeUpdates(): void {
    if (this.destroyed) {
      return;
    }
    const state = resumeRealtimePollingUpdates(this.restartPollingOnRealtimeResume);
    this.realtimePaused = state.realtimePaused;
    this.restartPollingOnRealtimeResume = state.restartPollingOnRealtimeResume;

    if (!state.shouldRestartPolling) {
      return;
    }

    this.restartPollingFallbackAfterRealtimeResume();
  }

  private restartPollingFallbackAfterRealtimeResume(): void {
    const projectId = this.currentProjectId;
    const userId = this.currentUserId;
    const transportGeneration = this.transportGeneration;

    if (!projectId || !shouldStartPollingFallbackAfterRealtimeResume({
      projectId,
      canActivateRemoteTransport: this.canActivateRemoteTransport(),
      realtimeChannel: this.realtimeChannel,
      hasActivePolling: this.pollingScheduler.hasActivePolling(),
      isTransportContextCurrent: this.isTransportContextCurrent(transportGeneration, projectId, userId),
    })) {
      return;
    }

    this.startPolling(projectId, userId, transportGeneration);
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
    this.remoteChangeDedup.clear();
    this.transportCircuit.clearBackoff();
    this.pollingScheduler.cleanup();

    // 清理 realtime channel
    const channel = this.realtimeChannel;
    this.realtimeChannel = null;

    cleanupRealtimePollingTransport({
      channel,
      client: this.getSupabaseClient(),
      logger: this.logger,
    });
  }
}
