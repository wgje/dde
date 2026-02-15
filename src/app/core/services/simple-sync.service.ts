/**
 * SimpleSyncService - 简化的同步服务（门面模式）
 * 
 * 核心原则（来自 agents.md）：
 * - 采用 Last-Write-Wins (LWW) 策略
 * - 用户操作 → 立即写入本地 → 后台推送到 Supabase
 * - 错误处理：失败放入 RetryQueue，网络恢复自动重试
 * 
 * 【技术债务重构】2026-02-01
 * - 从 3499 行重构为 ≤800 行门面服务
 * - 任务同步逻辑委托给 TaskSyncOperationsService
 * - 连接同步逻辑委托给 ConnectionSyncOperationsService
 * - 重试队列逻辑整合到 RetryQueueService
 * - 项目同步逻辑委托给 ProjectDataService
 */

import { Injectable, inject, signal, computed, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SupabaseClientService } from '../../../services/supabase-client.service';
import { LoggerService } from '../../../services/logger.service';
import { ToastService } from '../../../services/toast.service';
import { RequestThrottleService } from '../../../services/request-throttle.service';
import { ClockSyncService } from '../../../services/clock-sync.service';
import { EventBusService } from '../../../services/event-bus.service';
// 拆分的子服务
import {
  TombstoneService, 
  RealtimePollingService,
  SessionManagerService,
  SyncOperationHelperService,
  UserPreferencesSyncService,
  ProjectDataService,
  BatchSyncService,
  TaskSyncOperationsService,
  ConnectionSyncOperationsService,
  RetryQueueService,
  type RetryableEntityType,
  type RetryableOperation
} from './sync';
import { Task, Project, Connection, UserPreferences } from '../../../models';
import { ProjectRow, TaskRow, ConnectionRow } from '../../../models/supabase-types';
import { nowISO } from '../../../utils/date';
import {
  supabaseErrorToError,
  classifySupabaseClientFailure
} from '../../../utils/supabase-error';
import { PermanentFailureError, isPermanentFailureError } from '../../../utils/permanent-failure-error';
import { SYNC_CONFIG, SYNC_DURABILITY_CONFIG, FIELD_SELECT_CONFIG, CACHE_CONFIG } from '../../../config/sync.config';
import { APP_LIFECYCLE_CONFIG } from '../../../config/app-lifecycle.config';
import { FEATURE_FLAGS } from '../../../config/feature-flags.config';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SentryLazyLoaderService } from '../../../services/sentry-lazy-loader.service';
import { BlackBoxSyncService } from '../../../services/black-box-sync.service';
import { BlackBoxEntry } from '../../../models/focus';
import { SyncStateService } from './sync/sync-state.service';

/**
 * 冲突数据
 */
interface ConflictData {
  local: Project;
  remote: Project;
  projectId: string;
}

/** 远程变更回调 */
export type RemoteChangeCallback = (payload: { eventType?: string; projectId?: string } | undefined) => Promise<void>;

/** 任务变更回调 */
export type TaskChangeCallback = (payload: { eventType: string; taskId: string; projectId: string }) => void;

/** 用户偏好变更回调 */
export type UserPreferencesChangeCallback = (payload: { eventType: string; userId: string }) => void;

/** 恢复链路参数 */
export interface ResumeRecoverOptions {
  mode?: 'light' | 'heavy';
  stage?: 'full' | 'compensation';
  allowRemoteProbe?: boolean;
  force?: boolean;
  sessionValidated?: boolean;
  retryProcessing?: 'background' | 'blocking';
  interactionBudgetMs?: number;
  skipSessionValidationWithinMs?: number;
  resumeProbeTimeoutMs?: number;
  backgroundDrainMaxRounds?: number;
  deferBlackBoxPull?: boolean;
  backgroundProbeDelayMs?: number;
  recoveryTicketId?: string;
  skipRetryQueue?: boolean;
  skipRealtimeResume?: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class SimpleSyncService {
  private readonly supabase = inject(SupabaseClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('SimpleSync');
  private readonly toast = inject(ToastService);
  private readonly throttle = inject(RequestThrottleService);
  private readonly clockSync = inject(ClockSyncService);
  private readonly eventBus = inject(EventBusService);
  private readonly destroyRef = inject(DestroyRef);
  
  // 子服务注入
  private readonly tombstoneService = inject(TombstoneService);
  private readonly realtimePollingService = inject(RealtimePollingService);
  private readonly sessionManager = inject(SessionManagerService);
  private readonly syncOpHelper = inject(SyncOperationHelperService);
  private readonly userPrefsSync = inject(UserPreferencesSyncService);
  private readonly projectDataService = inject(ProjectDataService);
  private readonly batchSyncService = inject(BatchSyncService);
  private readonly taskSyncOps = inject(TaskSyncOperationsService);
  private readonly connectionSyncOps = inject(ConnectionSyncOperationsService);
  private readonly syncStateService = inject(SyncStateService);
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly retryQueueService = inject(RetryQueueService);
  private readonly blackBoxSync = inject(BlackBoxSyncService);
  
  /**
   * 获取 Supabase 客户端
   */
  private async getSupabaseClient(): Promise<SupabaseClient | null> {
    if (!this.supabase.isConfigured) {
      const failure = classifySupabaseClientFailure(false);
      this.syncState.update(s => ({ ...s, syncError: failure.message }));
      this.logger.warn('无法获取 Supabase 客户端', failure);
      return null;
    }
    try {
      return await this.supabase.clientAsync();
    } catch (error) {
      const failure = classifySupabaseClientFailure(true, error);
      this.syncState.update(s => ({ ...s, syncError: failure.message }));
      this.logger.warn('无法获取 Supabase 客户端', {
        category: failure.category,
        message: failure.message
      });
      this.sentryLazyLoader.captureMessage('Sync client unavailable', {
        level: 'warning',
        tags: {
          operation: 'SimpleSync.getSupabaseClient',
          category: failure.category
        }
      });
      // eslint-disable-next-line no-restricted-syntax -- 需保持历史接口语义，客户端不可用时返回 null 触发离线降级分支
      return null;
    }
  }
  
  /** 同步状态（委托给 SyncStateService 统一管理，解决双源进度不一致问题） */
  readonly syncState = this.syncStateService.syncState;
  
  /** 兼容旧接口 */
  readonly state = this.syncState;
  
  /** 便捷 computed 属性 */
  readonly isOnline = computed(() => this.syncState().isOnline);
  readonly isSyncing = computed(() => this.syncState().isSyncing);
  readonly hasConflict = computed(() => this.syncState().hasConflict);
  readonly isLoadingRemote = signal(false);
  
  /** 最后一次同步时间 */
  private lastSyncTimeByProject: Map<string, string> = new Map();
  
  /** 配置常量 */
  private readonly RETRY_INTERVAL = 5000;
  private readonly OFFLINE_CACHE_KEY = CACHE_CONFIG.OFFLINE_CACHE_KEY;
  /** 恢复 ticket 状态缓存（防止同 ticket 重复 heavy/light） */
  private readonly recoveryTicketState = new Map<
    string,
    { createdAt: number; modes: Set<'light' | 'heavy'>; probeCompleted: boolean }
  >();
  
  constructor() {
    // 订阅会话恢复事件
    this.eventBus.onSessionRestored$.pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(() => this.resetSessionExpired());
    
    // 初始化 BatchSyncService 回调
    this.batchSyncService.setCallbacks({
      pushProject: (p, f) => this.pushProject(p, f),
      pushTask: (t, pid, s, f) => this.pushTask(t, pid, s, f),
      pushTaskPosition: (tid, x, y) => this.pushTaskPosition(tid, x, y),
      pushConnection: (c, pid, s, te, f) => this.pushConnection(c, pid, s, te, f),
      getTombstoneIds: (pid) => this.getTombstoneIds(pid),
      getConnectionTombstoneIds: (pid) => this.getConnectionTombstoneIds(pid),
      purgeTasksFromCloud: (pid, tids) => this.purgeTasksFromCloud(pid, tids),
      topologicalSortTasks: (tasks) => this.topologicalSortTasks(tasks),
      addToRetryQueue: (t, o, d, p) => this.addToRetryQueue(t, o, d as Task | Project | Connection | { id: string }, p)
    });
    
    // 设置重试队列操作处理器
    this.retryQueueService.setOperationHandler({
      pushTask: (task, pid) => this.pushTask(task, pid, true, true),
      deleteTask: (tid, pid) => this.deleteTask(tid, pid),
      pushProject: (project) => this.pushProject(project, true),
      pushConnection: (conn, pid) => this.pushConnection(conn, pid, true, true, true),
      pushBlackBoxEntry: (entry: BlackBoxEntry) => this.blackBoxSync.pushToServer(entry),
      isSessionExpired: () => this.syncState().sessionExpired,
      // 离线模式下返回 false，避免 RetryQueue 尝试处理未配置的 Supabase
      isOnline: () => this.state().isOnline && !this.supabase.isOfflineMode(),
      onProcessingStateChange: (processing, pendingCount) =>
        this.state.update(s => ({ ...s, isSyncing: processing, pendingCount }))
    });

    // 将黑匣子同步集成到主同步体系的 RetryQueue
    this.blackBoxSync.setRetryQueueHandler((entry: BlackBoxEntry) => {
      this.retryQueueService.add('blackbox', 'upsert', entry, entry.projectId);
    });
    
    // 启动网络监听和重试循环
    this.setupNetworkListeners();
    this.retryQueueService.startLoop(this.RETRY_INTERVAL);
    
    this.destroyRef.onDestroy(() => this.cleanup());
  }
  
  // ==================== 网络与生命周期 ====================
  
  private setupNetworkListeners(): void {
    if (typeof window === 'undefined') return;
    
    const handleOnline = () => {
      this.logger.info('网络恢复');
      this.state.update(s => ({ ...s, isOnline: true }));
      if (this.retryQueueService.length > 0) {
        this.retryQueueService.processQueue();
      }
    };
    
    const handleOffline = () => {
      this.logger.info('网络断开');
      this.state.update(s => ({ ...s, isOnline: false }));
    };
    
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    this.destroyRef.onDestroy(() => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    });
  }
  
  private cleanup(): void {
    this.retryQueueService.stopLoop();
    this.realtimePollingService.unsubscribeFromProject();
  }
  
  flushRetryQueueSync(): void {
    this.retryQueueService.flushSync();
  }

  /**
   * 页面恢复后的同步自愈流程
   * 顺序：重试队列 -> 远程增量/全量拉取回调 -> 恢复实时更新
   */
  async recoverAfterResume(reason: string, options: ResumeRecoverOptions = {}): Promise<void> {
    const startedAt = Date.now();
    const mode = options.mode ?? 'heavy';
    const stage = options.stage ?? 'full';
    const interactionFirstEnabled = FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1 || options.force === true;
    const allowRemoteProbe = options.allowRemoteProbe ?? mode === 'heavy';
    const force = options.force === true;
    const retryProcessing = options.retryProcessing ?? 'background';
    const skipRetryQueue = options.skipRetryQueue ?? stage === 'compensation';
    const skipRealtimeResume = options.skipRealtimeResume ?? stage === 'compensation';
    const recoveryTicketId = options.recoveryTicketId?.trim() || null;
    const recoveryTicketDedupEnabled = FEATURE_FLAGS.RECOVERY_TICKET_DEDUP_V1;
    const deferBlackBoxPull = options.deferBlackBoxPull ?? true;
    const interactionBudgetMs = Math.max(
      80,
      options.interactionBudgetMs ?? APP_LIFECYCLE_CONFIG.RESUME_INTERACTION_BUDGET_MS
    );
    const skipSessionValidationWithinMs = Math.max(
      0,
      options.skipSessionValidationWithinMs ?? (FEATURE_FLAGS.RESUME_SESSION_SNAPSHOT_V1 ? 10_000 : 0)
    );
    const resumeProbeTimeoutMs = Math.max(200, options.resumeProbeTimeoutMs ?? 1500);
    const backgroundProbeDelayMs = Math.max(0, options.backgroundProbeDelayMs ?? 150);
    const backgroundDrainMaxRounds = Math.max(1, options.backgroundDrainMaxRounds ?? 5);
    const onlineNow = typeof navigator !== 'undefined' ? navigator.onLine : this.state().isOnline;
    this.state.update(s => ({ ...s, isOnline: onlineNow }));

    this.cleanupRecoveryTicketState(startedAt);
    let ticketState: { createdAt: number; modes: Set<'light' | 'heavy'>; probeCompleted: boolean } | null = null;
    let duplicateModeInSameTicket = false;
    if (recoveryTicketId && recoveryTicketDedupEnabled) {
      ticketState = this.recoveryTicketState.get(recoveryTicketId) ?? {
        createdAt: startedAt,
        modes: new Set<'light' | 'heavy'>(),
        probeCompleted: false,
      };
      duplicateModeInSameTicket = ticketState.modes.has(mode);
      this.recoveryTicketState.set(recoveryTicketId, ticketState);
    }

    this.sentryLazyLoader.addBreadcrumb({
      category: 'lifecycle',
      message: 'recovery.step',
      level: 'info',
      data: {
        step: 'sync-recovery-start',
        reason,
        mode,
        stage,
        isOnline: onlineNow,
        interactionFirstEnabled,
        recoveryTicketId,
        deferBlackBoxPull,
        skipRetryQueue,
        skipRealtimeResume
      }
    });

    if (!onlineNow && !force) {
      this.logger.info('页面恢复时处于离线状态，跳过恢复同步', { reason });
      return;
    }

    let session: { valid: boolean; userId?: string } | null = null;
    if (options.sessionValidated !== true) {
      if (skipSessionValidationWithinMs > 0) {
        const snapshot = this.sessionManager.getRecentValidationSnapshot(skipSessionValidationWithinMs);
        if (snapshot?.valid) {
          session = { valid: true, userId: snapshot.userId };
        }
      }

      // light/heavy 都执行会话校验，确保恢复链路在无效会话下快速退出
      session = session ?? await this.sessionManager.validateSession();
      if (!session.valid && !force) {
        this.logger.info('页面恢复时会话无效，跳过远端恢复链路', { reason, mode });
        return;
      }
    }

    // 1) 先处理离线积压队列
    if (!skipRetryQueue && this.retryQueueService.length > 0) {
      const retrySlice = Math.max(1, APP_LIFECYCLE_CONFIG.RESUME_RETRY_SLICE_MAX_ITEMS);
      this.sentryLazyLoader.addBreadcrumb({
        category: 'lifecycle',
        message: 'recovery.step',
        level: 'info',
        data: {
          step: 'retry-queue-process',
          reason,
          mode,
          stage,
          pendingCount: this.retryQueueService.length,
          retrySlice,
          retryProcessing,
          interactionBudgetMs
        }
      });

      if (retryProcessing === 'blocking') {
        await this.retryQueueService.processQueueSlice({
          maxItems: retrySlice,
          maxDurationMs: interactionBudgetMs
        });
      } else {
        const firstSlice = await this.retryQueueService.processQueueSlice({
          maxItems: retrySlice,
          maxDurationMs: interactionBudgetMs
        });
        if (!firstSlice.completed) {
          this.scheduleRetryQueueContinuation(
            reason,
            mode,
            retrySlice,
            interactionBudgetMs,
            backgroundDrainMaxRounds
          );
        }
      }
    }

    // 2) 恢复实时更新状态（若之前被暂停），并在 heavy 下探测远端变更
    if (!skipRealtimeResume) {
      this.realtimePollingService.resumeRealtimeUpdates();
    }

    if (duplicateModeInSameTicket) {
      this.sentryLazyLoader.addBreadcrumb({
        category: 'lifecycle',
        message: 'recovery.step',
        level: 'info',
        data: {
          step: 'ticket-duplicate-mode-skipped',
          reason,
          mode,
          stage,
          recoveryTicketId,
        }
      });
      this.logger.debug('同一 recovery ticket 重复恢复已跳过主流程', { reason, mode, stage, recoveryTicketId });
    }

    if (ticketState && !duplicateModeInSameTicket) {
      ticketState.modes.add(mode);
    }

    // light 模式只做本地状态恢复，不触发远端探测
    if (mode === 'heavy' && allowRemoteProbe && !duplicateModeInSameTicket && !(ticketState?.probeCompleted)) {
      const currentProjectId = this.realtimePollingService.getCurrentProjectId();
      const payload = {
        eventType: 'resume',
        projectId: currentProjectId ?? undefined
      };
      const firstProbe = await this.triggerRemoteProbeWithTimeout(payload, resumeProbeTimeoutMs);
      let triggered = firstProbe.triggered;
      const hasCallback = this.realtimePollingService.hasRemoteChangeCallback();

      if (!triggered && hasCallback && !firstProbe.timedOut) {
        this.sentryLazyLoader.addBreadcrumb({
          category: 'lifecycle',
          message: 'recovery.step',
          level: 'info',
          data: { step: 'remote-probe-retry', reason, mode }
        });
        const retryProbe = await this.triggerRemoteProbeWithTimeout(payload, resumeProbeTimeoutMs);
        triggered = retryProbe.triggered;
      }

      if (!triggered && firstProbe.timedOut && hasCallback) {
        setTimeout(() => {
          void this.realtimePollingService.triggerRemoteChange(payload);
        }, backgroundProbeDelayMs);
        this.sentryLazyLoader.addBreadcrumb({
          category: 'lifecycle',
          message: 'recovery.step',
          level: 'info',
          data: {
            step: 'remote-probe-timeout-background-fallback',
            reason,
            mode,
            stage,
            recoveryTicketId,
            backgroundProbeDelayMs
          }
        });
      }

      // 3) 灰度开关关闭时保留旧兜底；开启后禁止全量 loadProjectsFromCloud
      if (!triggered) {
        if (!interactionFirstEnabled) {
          this.sentryLazyLoader.addBreadcrumb({
            category: 'lifecycle',
            message: 'recovery.step',
            level: 'info',
            data: { step: 'fallback-cloud-load', reason, mode }
          });

          const fallbackSession = session ?? await this.sessionManager.validateSession();
          if (fallbackSession.valid && fallbackSession.userId) {
            await this.loadProjectsFromCloud(fallbackSession.userId, true);
          }
        } else if (!hasCallback) {
          this.sentryLazyLoader.addBreadcrumb({
            category: 'lifecycle',
            message: 'recovery.step',
            level: 'info',
            data: {
              step: 'skip-fallback-no-callback',
              reason,
              mode,
              stage
            }
          });
          this.logger.info('恢复链路未注册远端回调，已跳过全量云端加载兜底', { reason, mode });
        }
      }

      if (ticketState) {
        ticketState.probeCompleted = triggered || firstProbe.timedOut;
      }
    } else if (mode === 'heavy' && ticketState?.probeCompleted) {
      this.sentryLazyLoader.addBreadcrumb({
        category: 'lifecycle',
        message: 'recovery.step',
        level: 'info',
        data: {
          step: 'remote-probe-skipped-ticket-probed',
          reason,
          mode,
          stage,
          recoveryTicketId
        }
      });
    }

    this.sentryLazyLoader.addBreadcrumb({
      category: 'lifecycle',
      message: 'recovery.step',
      level: 'info',
      data: {
        step: 'sync-recovery-complete',
        reason,
        mode,
        stage,
        elapsedMs: Date.now() - startedAt
      }
    });
  }

  private cleanupRecoveryTicketState(nowMs: number): void {
    if (this.recoveryTicketState.size === 0) {
      return;
    }

    const ttlMs = APP_LIFECYCLE_CONFIG.RESUME_HEAVY_COOLDOWN_MS * 4;
    for (const [ticketId, state] of this.recoveryTicketState.entries()) {
      if (nowMs - state.createdAt > ttlMs) {
        this.recoveryTicketState.delete(ticketId);
      }
    }
  }

  private scheduleRetryQueueContinuation(
    reason: string,
    mode: 'light' | 'heavy',
    retrySlice: number,
    maxDurationMs: number,
    maxRounds: number,
    round = 1
  ): void {
    if (round > maxRounds) {
      this.sentryLazyLoader.addBreadcrumb({
        category: 'lifecycle',
        message: 'recovery.step',
        level: 'warning',
        data: {
          step: 'retry-queue-background-drain-max-rounds',
          reason,
          mode,
          maxRounds
        }
      });
      return;
    }

    const backoffDelaysMs = [200, 500, 1000, 1000, 1000];
    const backoffMs = backoffDelaysMs[Math.min(round - 1, backoffDelaysMs.length - 1)];
    const runSlice = () => {
      void this.retryQueueService.processQueueSlice({
        maxItems: retrySlice,
        maxDurationMs
      }).then((result) => {
        if (!result.completed && result.remaining > 0) {
          this.scheduleRetryQueueContinuation(reason, mode, retrySlice, maxDurationMs, maxRounds, round + 1);
          return;
        }

        this.sentryLazyLoader.addBreadcrumb({
          category: 'lifecycle',
          message: 'recovery.step',
          level: 'info',
          data: {
            step: 'retry-queue-background-drain',
            reason,
            mode,
            remaining: result.remaining,
            processed: result.processed,
            durationMs: result.durationMs,
            round
          }
        });
      }).catch((error) => {
        this.logger.warn('恢复链路后台重试切片失败', { reason, mode, error });
        this.scheduleRetryQueueContinuation(reason, mode, retrySlice, maxDurationMs, maxRounds, round + 1);
      });
    };

    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      (
        window as Window & {
          requestIdleCallback: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
        }
      ).requestIdleCallback(() => runSlice(), { timeout: backoffMs });
      return;
    }
    setTimeout(runSlice, backoffMs);
  }

  private async triggerRemoteProbeWithTimeout(
    payload: { eventType?: string; projectId?: string },
    timeoutMs: number
  ): Promise<{ triggered: boolean; timedOut: boolean }> {
    try {
      const result = await Promise.race([
        this.realtimePollingService.triggerRemoteChange(payload).then(triggered => ({
          triggered,
          timedOut: false
        })),
        new Promise<{ triggered: false; timedOut: true }>((resolve) =>
          setTimeout(() => resolve({ triggered: false, timedOut: true }), timeoutMs)
        )
      ]);
      return result;
    } catch {
      return { triggered: false, timedOut: false };
    }
  }
  
  // ==================== 任务同步（委托） ====================
  
  async pushTask(task: Task, projectId: string, skipTombstoneCheck = false, fromRetryQueue = false): Promise<boolean> {
    return this.taskSyncOps.pushTask(task, projectId, skipTombstoneCheck, fromRetryQueue);
  }
  
  async pushTaskPosition(taskId: string, x: number, y: number): Promise<boolean> {
    return this.taskSyncOps.pushTaskPosition(taskId, x, y);
  }
  
  async pullTasks(projectId: string, since?: string): Promise<Task[]> {
    return this.taskSyncOps.pullTasks(projectId, since);
  }
  
  async deleteTask(taskId: string, projectId: string): Promise<boolean> {
    return this.taskSyncOps.deleteTask(taskId, projectId);
  }
  
  async softDeleteTasksBatch(projectId: string, taskIds: string[]): Promise<number> {
    return this.taskSyncOps.softDeleteTasksBatch(projectId, taskIds);
  }
  
  async purgeTasksFromCloud(projectId: string, taskIds: string[]): Promise<boolean> {
    return this.taskSyncOps.purgeTasksFromCloud(projectId, taskIds);
  }
  
  async getTombstoneIds(projectId: string): Promise<Set<string>> {
    return this.taskSyncOps.getTombstoneIds(projectId);
  }
  
  async getTombstoneIdsWithStatus(projectId: string): Promise<{ ids: Set<string>; fromRemote: boolean; localCacheOnly: boolean; timestamp: number }> {
    return this.taskSyncOps.getTombstoneIdsWithStatus(projectId);
  }
  
  getLocalTombstones(projectId: string): Set<string> {
    return this.taskSyncOps.getLocalTombstones(projectId);
  }
  
  addLocalTombstones(projectId: string, taskIds: string[]): void {
    this.taskSyncOps.addLocalTombstones(projectId, taskIds);
  }
  
  private topologicalSortTasks(tasks: Task[]): Task[] {
    return this.taskSyncOps.topologicalSortTasks(tasks);
  }
  
  invalidateTombstoneCache(projectId: string): void {
    this.tombstoneService.invalidateCache(projectId);
  }
  
  // ==================== 连接同步（委托） ====================
  
  async pushConnection(connection: Connection, projectId: string, skipTombstoneCheck = false, skipTaskExistenceCheck = false, fromRetryQueue = false): Promise<boolean> {
    return this.connectionSyncOps.pushConnection(connection, projectId, skipTombstoneCheck, skipTaskExistenceCheck, fromRetryQueue);
  }
  
  async getConnectionTombstoneIds(projectId: string): Promise<Set<string>> {
    return this.connectionSyncOps.getConnectionTombstoneIds(projectId);
  }
  
  // ==================== 项目同步 ====================
  
  async pushProject(project: Project, fromRetryQueue = false): Promise<boolean> {
    if (this.syncState().sessionExpired) {
      this.sessionManager.handleSessionExpired('pushProject', { projectId: project.id });
      return false;
    }
    
    const client = await this.getSupabaseClient();
    if (!client) {
      if (!fromRetryQueue) this.addToRetryQueue('project', 'upsert', project);
      return false;
    }
    
    // 【#95057880 修复】支持自动刷新后重试的内部执行函数（与 pushTask 对齐）
    const executeProjectPush = async (): Promise<void> => {
      const { data: { session } } = await client.auth.getSession();
      const userId = session?.user?.id;
      if (!userId) {
        // 先尝试刷新会话，而非立即标记永久失败
        const refreshed = await this.sessionManager.tryRefreshSession('pushProject.getSession');
        if (refreshed) {
          const { data: { session: newSession } } = await client.auth.getSession();
          if (newSession?.user?.id) {
            return await this.doProjectPush(client, project, newSession.user.id);
          }
        }
        this.sessionManager.handleSessionExpired('pushProject.getSession', { projectId: project.id });
        return;
      }
      
      return await this.doProjectPush(client, project, userId);
    };
    
    try {
      await this.throttle.execute(
        `push-project:${project.id}`,
        executeProjectPush,
        { priority: 'high', retries: 2 }
      );
      return true;
    } catch (e) {
      // 【#95057880 修复】PermanentFailureError 直接向上冒泡，不做二次处理
      if (isPermanentFailureError(e)) {
        throw e;
      }
      
      const enhanced = supabaseErrorToError(e);
      
      // 【#95057880 修复】检测到认证错误时先尝试刷新 session（与 pushTask 对齐）
      if (this.sessionManager.isSessionExpiredError(enhanced)) {
        const canRetry = await this.sessionManager.handleAuthErrorWithRefresh('pushProject', {
          projectId: project.id,
          errorCode: enhanced.code
        });
        if (canRetry) {
          try {
            await executeProjectPush();
            return true;
          } catch (retryError) {
            if (isPermanentFailureError(retryError)) throw retryError;
            const retryEnhanced = supabaseErrorToError(retryError);
            if (this.sessionManager.isSessionExpiredError(retryEnhanced)) {
              this.sessionManager.handleSessionExpired('pushProject.retryAfterRefresh', {
                projectId: project.id,
                errorCode: retryEnhanced.code
              });
              return false;
            }
          }
        } else {
          this.sessionManager.handleSessionExpired('pushProject', { projectId: project.id, errorCode: enhanced.code });
          return false;
        }
      }
      
      if (enhanced.errorType === 'VersionConflictError') {
        this.toast.warning('版本冲突', '数据已被修改，请刷新后重试');
        throw new PermanentFailureError('Version conflict', enhanced, { operation: 'pushProject', projectId: project.id });
      }
      
      if (enhanced.isRetryable && !fromRetryQueue) {
        this.addToRetryQueue('project', 'upsert', project);
      }
      return false;
    }
  }
  
  /**
   * 执行项目 upsert 操作（内部方法，由 pushProject 调用）
   */
  private async doProjectPush(client: SupabaseClient, project: Project, userId: string): Promise<void> {
    // 【P2-1 修复】不发送客户端 updated_at，让 DB 触发器统一设置，避免时钟偏移影响 LWW 判定
    const { error } = await client
      .from('projects')
      .upsert({
        id: project.id,
        owner_id: userId,
        title: project.name,
        description: project.description,
        version: project.version || 1,
        migrated_to_v2: true
      });
    
    if (error) throw supabaseErrorToError(error);
  }
  
  async pullProjects(since?: string): Promise<Project[]> {
    const client = await this.getSupabaseClient();
    if (!client) return [];

    try {
      const userId = this.sessionManager.getRecentValidationSnapshot(60_000)?.userId;
      let query = client.from('projects').select(FIELD_SELECT_CONFIG.PROJECT_LIST_FIELDS);
      if (userId) query = query.eq('owner_id', userId);
      if (since) query = query.gt('updated_at', since);

      const { data, error } = await query;
      if (error) throw supabaseErrorToError(error);
      
      return (data || []).map(row => this.projectDataService.rowToProject(row as ProjectRow));
    } catch (e) {
      this.logger.error('拉取项目失败', e);
      return [];
    }
  }
  
  // ==================== 重试队列（委托 RetryQueueService） ====================
  
  /**
   * 添加项目到重试队列（含会话和数据有效性检查）
   */
  addToRetryQueue(
    type: RetryableEntityType,
    operation: RetryableOperation,
    data: Task | Project | Connection | { id: string },
    projectId?: string
  ): void {
    if (this.syncState().sessionExpired) return;
    if (!data?.id) {
      this.logger.warn('addToRetryQueue: 跳过无效数据（缺少 id）', { type, operation });
      return;
    }
    if ((type === 'task' || type === 'connection') && !projectId) {
      this.logger.warn('addToRetryQueue: 跳过无效数据（缺少 projectId）', { type, operation, id: data.id });
      return;
    }
    const enqueued = this.retryQueueService.add(type, operation, data, projectId);
    if (enqueued) {
      this.state.update(s => ({ ...s, pendingCount: this.retryQueueService.length }));
    } else {
      this.state.update(s => ({ ...s, syncError: '同步队列已满，暂未写入重试队列' }));
    }
  }
  
  clearRetryQueue(): void {
    const count = this.retryQueueService.length;
    this.retryQueueService.clear();
    this.state.update(s => ({ ...s, pendingCount: 0 }));
    this.logger.info(`已清理 ${count} 个重试项`);
    this.toast.info(`已清理 ${count} 个待同步项`);
  }
  
  // ==================== Realtime / 轮询 ====================
  
  isRealtimeEnabled(): boolean {
    return this.realtimePollingService.isRealtimeEnabled();
  }
  
  setOnRemoteChange(callback: RemoteChangeCallback): void {
    this.realtimePollingService.setOnRemoteChange(callback);
  }

  setUserPreferencesChangeCallback(callback: UserPreferencesChangeCallback | null): void {
    this.realtimePollingService.setUserPreferencesChangeCallback(callback);
  }
  
  setRealtimeEnabled(enabled: boolean): void {
    this.realtimePollingService.setRealtimeEnabled(enabled);
  }
  
  async subscribeToProject(projectId: string, userId: string): Promise<void> {
    await this.realtimePollingService.subscribeToProject(projectId, userId);
  }
  
  async unsubscribeFromProject(): Promise<void> {
    await this.realtimePollingService.unsubscribeFromProject();
  }
  
  setRemoteChangeCallback(callback: RemoteChangeCallback): void {
    this.realtimePollingService.setOnRemoteChange(callback);
  }
  
  setTaskChangeCallback(callback: TaskChangeCallback): void {
    this.realtimePollingService.setTaskChangeCallback(callback);
  }
  
  async initRealtimeSubscription(userId: string): Promise<void> {
    this.logger.debug('Realtime 订阅已初始化', { userId: userId.substring(0, 8) });
  }
  
  teardownRealtimeSubscription(): void {
    this.realtimePollingService.unsubscribeFromProject();
  }
  
  pauseRealtimeUpdates(): void {
    this.realtimePollingService.pauseRealtimeUpdates();
  }
  
  resumeRealtimeUpdates(): void {
    this.realtimePollingService.resumeRealtimeUpdates();
  }
  
  // ==================== 用户偏好 ====================
  
  async loadUserPreferences(userId: string): Promise<UserPreferences | null> {
    return this.userPrefsSync.loadUserPreferences(userId);
  }
  
  async saveUserPreferences(userId: string, preferences: Partial<UserPreferences>): Promise<boolean> {
    return this.userPrefsSync.saveUserPreferences(userId, preferences);
  }
  
  // ==================== Delta Sync ====================
  
  async checkForDrift(projectId: string): Promise<{ tasks: Task[]; connections: Connection[] }> {
    const client = await this.getSupabaseClient();
    if (!client || !SYNC_CONFIG.DELTA_SYNC_ENABLED) {
      return { tasks: [], connections: [] };
    }
    
    const lastSyncTime = this.lastSyncTimeByProject.get(projectId);
    if (!lastSyncTime) {
      return { tasks: [], connections: [] };
    }
    
    try {
      const driftMs = Math.abs(this.clockSync.currentDriftMs());
      const lookbackMs = Math.max(SYNC_CONFIG.CURSOR_SAFETY_LOOKBACK_MS, driftMs);
      const sinceMs = new Date(lastSyncTime).getTime() - lookbackMs;
      const effectiveSince = new Date(Math.max(0, sinceMs)).toISOString();

      const [tasksResult, connectionsResult] = await Promise.all([
        client.from('tasks').select(FIELD_SELECT_CONFIG.TASK_LIST_FIELDS).eq('project_id', projectId).gt('updated_at', effectiveSince),
        client.from('connections').select(FIELD_SELECT_CONFIG.CONNECTION_FIELDS).eq('project_id', projectId).gt('updated_at', effectiveSince)
      ]);
      
      if (tasksResult.error || connectionsResult.error) {
        throw supabaseErrorToError(tasksResult.error || connectionsResult.error);
      }
      
      const taskRows = (tasksResult.data || []) as TaskRow[];
      const connectionRows = (connectionsResult.data || []) as ConnectionRow[];
      const deltaTasks = this.dedupeTasksByLatest(
        taskRows.map(row => this.projectDataService.rowToTask(row))
      );
      const deltaConnections = this.dedupeConnectionsByLatest(
        connectionRows.map(row => this.projectDataService.rowToConnection(row))
      );
      const maxUpdatedAt = this.computeMaxUpdatedAt(taskRows, connectionRows);
      
      if (SYNC_DURABILITY_CONFIG.CURSOR_STRATEGY === 'max-server-updated-at' && maxUpdatedAt) {
        this.lastSyncTimeByProject.set(projectId, maxUpdatedAt);
      } else {
        this.lastSyncTimeByProject.set(projectId, nowISO());
      }
      this.sentryLazyLoader.setContext('sync_delta', {
        project_id: projectId,
        cursor_lag_ms: maxUpdatedAt ? Math.max(0, Date.now() - new Date(maxUpdatedAt).getTime()) : null,
        lookback_ms: lookbackMs
      });
      
      return {
        tasks: deltaTasks,
        connections: deltaConnections
      };
    } catch (e) {
      this.logger.error('Delta Sync 检查失败', e);
      throw e;
    }
  }

  private dedupeTasksByLatest(tasks: Task[]): Task[] {
    const byId = new Map<string, Task>();
    for (const task of tasks) {
      const existing = byId.get(task.id);
      if (!existing) {
        byId.set(task.id, task);
        continue;
      }
      const existingTs = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
      const nextTs = task.updatedAt ? new Date(task.updatedAt).getTime() : 0;
      if (nextTs >= existingTs) {
        byId.set(task.id, task);
      }
    }
    return Array.from(byId.values());
  }

  private dedupeConnectionsByLatest(connections: Connection[]): Connection[] {
    const byId = new Map<string, Connection>();
    for (const connection of connections) {
      const existing = byId.get(connection.id);
      if (!existing) {
        byId.set(connection.id, connection);
        continue;
      }
      const existingTs = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
      const nextTs = connection.updatedAt ? new Date(connection.updatedAt).getTime() : 0;
      if (nextTs >= existingTs) {
        byId.set(connection.id, connection);
      }
    }
    return Array.from(byId.values());
  }

  private computeMaxUpdatedAt(taskRows: TaskRow[], connectionRows: ConnectionRow[]): string | null {
    let max = 0;
    for (const row of taskRows) {
      if (row.updated_at) {
        max = Math.max(max, new Date(row.updated_at).getTime());
      }
    }
    for (const row of connectionRows) {
      if (row.updated_at) {
        max = Math.max(max, new Date(row.updated_at).getTime());
      }
    }
    return max > 0 ? new Date(max).toISOString() : null;
  }
  
  setLastSyncTime(projectId: string, timestamp: string): void {
    this.lastSyncTimeByProject.set(projectId, timestamp);
  }
  
  getLastSyncTime(projectId: string): string | null {
    return this.lastSyncTimeByProject.get(projectId) || null;
  }
  
  clearLastSyncTime(projectId: string): void {
    this.lastSyncTimeByProject.delete(projectId);
  }
  
  // ==================== 冲突解决 ====================
  
  resolveConflict(projectId: string, resolvedProject: Project, strategy: 'local' | 'remote'): void {
    this.logger.info('解决冲突', { projectId, strategy });
    this.syncState.update(s => ({ ...s, hasConflict: false, conflictData: null }));
  }
  
  setConflict(conflictData: ConflictData): void {
    this.syncState.update(s => ({ ...s, hasConflict: true, conflictData }));
  }
  
  // ==================== 项目加载 ====================
  
  async saveProjectToCloud(project: Project, userId: string): Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; newVersion?: number; failedTaskIds?: string[]; failedConnectionIds?: string[] }> {
    return this.batchSyncService.saveProjectToCloud(project, userId);
  }

  async saveProjectSmart(project: Project, userId: string): Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; newVersion?: number; validationWarnings?: string[]; failedTaskIds?: string[]; failedConnectionIds?: string[] }> {
    const result = await this.saveProjectToCloud(project, userId);
    return { ...result, newVersion: project.version };
  }
  
  async loadFullProjectOptimized(projectId: string): Promise<Project | null> {
    return this.projectDataService.loadFullProjectOptimized(projectId);
  }
  
  async loadFullProject(projectId: string, _userId: string): Promise<Project | null> {
    return this.projectDataService.loadFullProject(projectId);
  }
  
  async loadProjectsFromCloud(userId: string, _silent?: boolean): Promise<Project[]> {
    return this.projectDataService.loadProjectsFromCloud(userId);
  }
  
  async deleteProjectFromCloud(projectId: string, userId: string): Promise<boolean> {
    const client = await this.getSupabaseClient();
    if (!client) return false;
    
    try {
      // 【P1-3 修复】软删除替代硬删除，防止离线端 pushProject 使项目复活
      const { error } = await client.from('projects')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', projectId)
        .eq('owner_id', userId);
      if (error) throw supabaseErrorToError(error);
      return true;
    } catch (e) {
      this.logger.error('删除项目失败', e);
      return false;
    }
  }
  
  async loadSingleProject(projectId: string, userId: string): Promise<Project | null> {
    return this.loadFullProject(projectId, userId);
  }

  async getProjectSyncWatermark(projectId: string): Promise<string | null> {
    return this.projectDataService.getProjectSyncWatermark(projectId);
  }

  async getUserProjectsWatermark(): Promise<string | null> {
    return this.projectDataService.getUserProjectsWatermark();
  }

  async listProjectHeadsSince(
    watermark: string | null
  ): Promise<Array<{ id: string; updatedAt: string; version: number }>> {
    return this.projectDataService.listProjectHeadsSince(watermark);
  }

  async getAccessibleProjectProbe(projectId: string): Promise<{
    projectId: string;
    accessible: boolean;
    watermark: string | null;
  } | null> {
    return this.projectDataService.getAccessibleProjectProbe(projectId);
  }

  async getBlackBoxSyncWatermark(): Promise<string | null> {
    return this.projectDataService.getBlackBoxSyncWatermark();
  }

  async getResumeRecoveryProbe(projectId?: string): Promise<{
    activeProjectId: string | null;
    activeAccessible: boolean;
    activeWatermark: string | null;
    projectsWatermark: string | null;
    blackboxWatermark: string | null;
    serverNow: string | null;
  } | null> {
    return this.projectDataService.getResumeRecoveryProbe(projectId);
  }
  
  async tryReloadConflictData(userId: string, _findProject?: (id: string) => Project | undefined): Promise<Project | undefined> {
    const state = this.syncState();
    if (!state.hasConflict || !state.conflictData) return undefined;
    const project = await this.loadFullProject(state.conflictData.projectId, userId);
    return project ?? undefined;
  }
  
  clearOfflineCache(): void {
    this.retryQueueService.clear();
    this.syncState.update(s => ({ ...s, pendingCount: 0 }));
    this.logger.info('离线缓存已清除');
  }
  
  saveOfflineSnapshot(projects: Project[]): void {
    this.projectDataService.saveOfflineSnapshot(projects);
  }
  
  loadOfflineSnapshot(): Project[] | null {
    return this.projectDataService.loadOfflineSnapshot();
  }
  
  // ==================== 会话管理 ====================
  
  resetSessionExpired(): void {
    if (!this.syncState().sessionExpired) return;
    
    const previousQueueLength = this.retryQueueService.length;
    this.syncState.update(s => ({ ...s, sessionExpired: false }));
    
    this.logger.info('会话状态已重置', { previousQueueLength });
    
    if (this.state().isOnline && this.retryQueueService.length > 0) {
      this.logger.info('会话恢复，触发重试队列处理');
      this.retryQueueService.processQueue();
    }
  }
  
  destroy(): void {
    this.cleanup();
    this.unsubscribeFromProject();
    this.retryQueueService.clear();
    this.logger.info('SimpleSyncService 已销毁');
  }
}
