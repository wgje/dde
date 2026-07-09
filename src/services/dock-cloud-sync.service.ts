/**
 * DockCloudSyncService
 * Cloud push/pull synchronization, focus session record management,
 * routine task & completion sync enqueuing.
 * Extracted from DockEngineService to decouple network/cloud operations
 * from business state logic.
 */
import { Injectable, OnDestroy, inject } from '@angular/core';
import { PARKING_CONFIG } from '../config/parking.config';
import { SYNC_CONFIG } from '../config/sync.config';
import { TIMEOUT_CONFIG } from '../config/timeout.config';
import {
  DailySlotEntry,
  DockSnapshot,
  FocusSessionRecord,
  RoutineCompletionMutation,
  RoutineTask,
} from '../models/parking-dock';
import { FocusConsoleSyncService } from '../core-bridge';
import { ActionQueueService } from './action-queue.service';
import {
  DockSnapshotPersistenceService,
  type SnapshotNormalizeContext,
} from './dock-snapshot-persistence.service';
import { LoggerService } from './logger.service';
import { SupabaseClientService } from './supabase-client.service';
import { withTimeout } from '../utils/timeout';
import { TimerHandle } from '../utils/timer-handle';
import { supabaseErrorToError } from '../utils/supabase-error';
import { AUTH_CONFIG } from '../config/auth.config';
import {
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../utils/browser-network-suspension';
import { DockCloudPushSchedulerController } from './dock-cloud-push-scheduler.controller';
import { DockDirectWidgetNotifyController } from './dock-direct-widget-notify.controller';
import { DockDirectWidgetNotifyOutboxService } from './dock-direct-widget-notify-outbox.service';

const CLOUD_PUSH_DEBOUNCE_MS = SYNC_CONFIG.DEBOUNCE_DELAY;
const CLOUD_PULL_DEBOUNCE_MS = PARKING_CONFIG.CLOUD_PULL_DEBOUNCE_MS;
const CLOUD_PULL_MIN_INTERVAL_MS = PARKING_CONFIG.CLOUD_PULL_MIN_INTERVAL_MS;
const LOAD_FOCUS_SESSION_TIMEOUT_MESSAGE = 'loadFocusSession 超时';
type LoadFocusSessionResult = Awaited<ReturnType<FocusConsoleSyncService['loadFocusSession']>>;
type RoutineTaskListResult = Awaited<ReturnType<FocusConsoleSyncService['listRoutineTasks']>>;

/**
 * Callbacks provided by DockEngineService for engine state mutations
 * that must happen during cloud sync operations.
 */
export interface CloudSyncEngineCallbacks {
  exportSnapshot: () => DockSnapshot;
  restoreSnapshot: (snapshot: DockSnapshot) => void;
  scheduleLocalPersist: (snapshot: DockSnapshot, userId: string) => void;
  persistLocalSnapshotImmediately: (snapshot: DockSnapshot, userId: string) => Promise<boolean>;
  updateDailySlots: (updater: (prev: DailySlotEntry[]) => DailySlotEntry[]) => void;
  getNonCriticalHoldDelay: () => number;
  getFocusSessionContext: () => { id: string; startedAt: number } | null;
  setFocusSessionContext: (ctx: { id: string; startedAt: number }) => void;
  buildNormalizeContext: () => SnapshotNormalizeContext;
  /** H-3: 获取当前快照用户 ID，用于异步操作后的过期检查 */
  getCurrentSnapshotUserId: () => string | null;
}

@Injectable({
  providedIn: 'root',
})
export class DockCloudSyncService implements OnDestroy {
  private readonly focusConsoleSync = inject(FocusConsoleSyncService);
  private readonly actionQueue = inject(ActionQueueService);
  private readonly snapshotPersistence = inject(DockSnapshotPersistenceService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly logger = inject(LoggerService).category('DockCloudSync');
  private readonly directWidgetNotifyOutbox = inject(DockDirectWidgetNotifyOutboxService);
  private readonly directWidgetNotify = new DockDirectWidgetNotifyController({
    isDestroyed: () => this.isDestroyed,
    logger: this.logger,
    outbox: this.directWidgetNotifyOutbox,
    supabase: this.supabase,
  });
  private readonly cloudPushScheduler = new DockCloudPushSchedulerController({
    isDestroyed: () => this.isDestroyed,
    isCurrentUser: userId => this.isCurrentUser(userId),
    enqueueFocusSessionSync: (userId, snapshot) => this.enqueueFocusSessionSync(userId, snapshot),
    logger: this.logger,
  });

  private readonly cloudPullTimer = new TimerHandle();
  private cloudPullRetryCount = 0;
  private lastCloudPullAt = 0;
  /** 断路器：连续不可恢复错误（如 401/403）时停止重试 */
  private circuitBreakerOpen = false;
  private circuitBreakerResetTimer = new TimerHandle();
  /** 免费层优化：按 owner 记录上次入队的快照指纹，避免跨账号相互去重 */
  private readonly lastEnqueuedSnapshotFingerprints = new Map<string, string>();

  private callbacks: CloudSyncEngineCallbacks | null = null;
  private isDestroyed = false;

  private isBrowserSuspendedResult(error: { details?: Record<string, unknown> } | null | undefined): boolean {
    return error?.details?.['reason'] === 'browser-network-suspended';
  }

  /**
   * 由 DockEngineService 在其构造函数中调用，注入引擎回调。
   * 此服务使用手动上下文注入而非 Angular DI，因为所需回调引用的是 DockEngineService 的私有成员
   * （如 exportSnapshot、restoreSnapshot 等），无法通过常规注入获取。
   *
   * 注意：与 DockCompletionFlowService 等服务不同，本服务对未初始化状态采用「静默跳过」策略
   * （而非 throw），因为云同步调用可能在 init 前就被触发（如快照恢复期间的防抖定时器）。
   */
  init(callbacks: CloudSyncEngineCallbacks): void {
    if (this.callbacks) {
      this.logger.warn('init() called again — overwriting previous callbacks');
    }
    this.callbacks = callbacks;
  }

  seedFocusModeBaseline(userId: string | null, snapshot: DockSnapshot | null): void {
    if (!userId || userId === AUTH_CONFIG.LOCAL_MODE_USER_ID || !snapshot) {
      return;
    }

    this.cloudPushScheduler.seedFocusModeBaseline(userId, snapshot);
  }

  /** H-3: 异步操作后检查用户是否仍为当前用户，防止跨用户数据污染 */
  private isCurrentUser(userId: string): boolean {
    return this.callbacks?.getCurrentSnapshotUserId() === userId;
  }

  // ─── Cloud Push ───────────────────────────────

  scheduleCloudPush(userId: string, snapshot: DockSnapshot | null): void {
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return;
    }

    if (this.isDestroyed) {
      this.logger.debug('scheduleCloudPush called after destroy — skipping', { userId });
      return;
    }

    const cb = this.callbacks;
    if (!cb) {
      // H-4 fix: 未初始化时记录警告而非静默吞掉，防止 init 顺序变更后
      // 云同步静默失效而无任何可观测信号。
      this.logger.warn('scheduleCloudPush called before init() — skipping', { userId });
      return;
    }
    const frozenSnapshot = snapshot ?? cb.exportSnapshot();

    const {
      nextFocusMode,
      shouldFastTrackWidgetSync,
    } = this.cloudPushScheduler.scheduleCloudPush(
      userId,
      frozenSnapshot,
      cb,
      CLOUD_PUSH_DEBOUNCE_MS,
    );

    // 2026-04-22 颠覆性压缩 (plan D)：focusMode 翻转瞬间并行直调 widget-notify 绕过
    // 「ActionQueue → DB upsert → pg_net 轮询 → widget-notify」的 3-8s 链路。
    // 直调路径用用户 JWT 认证，edge function 在同一张 widget_notify_events 表上做幂等，
    // 若 pg_net 后续仍送达则会被去重 kind='duplicate' 静默丢弃，不会导致双推。
    if (shouldFastTrackWidgetSync && !this.isDestroyed) {
      void this.directWidgetNotify.notifyFocusChange(
        userId,
        frozenSnapshot,
        nextFocusMode,
      );
    }
  }

  // ─── Cloud Pull ───────────────────────────────

  scheduleCloudPull(userId: string, force: boolean): void {
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return;
    }

    if (this.isDestroyed) {
      this.logger.debug('scheduleCloudPull called after destroy — skipping', { userId, force });
      return;
    }

    if (!force && Date.now() - this.lastCloudPullAt < CLOUD_PULL_MIN_INTERVAL_MS) return;
    // H-4 fix: 强制拉取时重置重试计数（用户切换场景）
    if (force) this.cloudPullRetryCount = 0;
    this.cloudPullTimer.schedule(() => {
      if (this.isDestroyed) {
        return;
      }
      void this.pullCloudSnapshot(userId);
    }, CLOUD_PULL_DEBOUNCE_MS);
  }

  private deferCloudPullForBrowserResume(userId: string, reason: 'preflight' | 'error'): void {
    if (this.isDestroyed) {
      return;
    }

    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      this.logger.debug('pullCloudSnapshot: 页面不可见，跳过当前云拉取', { userId, reason });
      return;
    }

    const delayMs = Math.max(getRemainingBrowserNetworkResumeDelayMs(), CLOUD_PULL_DEBOUNCE_MS);
    this.logger.debug('pullCloudSnapshot: 浏览器网络挂起窗口内延后云拉取', {
      userId,
      reason,
      delayMs,
    });
    this.cloudPullTimer.schedule(() => {
      if (this.isDestroyed) {
        return;
      }
      this.lastCloudPullAt = 0;
      void this.pullCloudSnapshot(userId);
    }, delayMs);
  }

  private async pullCloudSnapshot(userId: string): Promise<void> {
    if (this.isDestroyed) return;

    const cb = this.prepareCloudPull(userId);
    if (!cb) return;

    this.lastCloudPullAt = Date.now();
    try {
      const remote = await this.loadNewerRemoteSnapshot(userId, cb);
      if (!remote) return;

      this.applyPulledSnapshot(userId, cb, remote);
      await this.hydrateRoutineSlots(userId);
    } catch (rawError) {
      this.handleCloudPullError(userId, rawError);
    }
  }

  private prepareCloudPull(userId: string): CloudSyncEngineCallbacks | null {
    if (this.isDestroyed) {
      return null;
    }

    const cb = this.callbacks;
    if (!cb) {
      this.logger.warn('pullCloudSnapshot called before init() — skipping', { userId });
      return null;
    }

    if (this.circuitBreakerOpen) {
      this.logger.warn('pullCloudSnapshot: circuit breaker open — skipping');
      return null;
    }

    if (!this.isCurrentUser(userId)) {
      this.logger.debug('pullCloudSnapshot: stale owner — skipping', {
        userId,
        currentUserId: cb.getCurrentSnapshotUserId(),
      });
      return null;
    }

    if (isBrowserNetworkSuspendedWindow()) {
      this.deferCloudPullForBrowserResume(userId, 'preflight');
      return null;
    }

    return cb;
  }

  private async loadNewerRemoteSnapshot(
    userId: string,
    cb: CloudSyncEngineCallbacks
  ): Promise<DockSnapshot | null> {
    const local = cb.exportSnapshot();
    const loadResult = await this.loadFocusSessionForPull(userId, local);
    if (!this.isCurrentUser(userId)) return null;

    const remoteRaw = await this.resolveFocusSessionLoadResult(userId, loadResult);
    if (!remoteRaw || !this.isCurrentUser(userId)) return null;

    const remote = this.snapshotPersistence.normalizeSnapshot(remoteRaw, cb.buildNormalizeContext());
    if (!remote) {
      await this.hydrateRoutineSlots(userId);
      return null;
    }

    if (!this.isCurrentUser(userId)) return null;
    if (!this.snapshotPersistence.isSnapshotNewer(remote, local)) {
      await this.hydrateRoutineSlots(userId);
      return null;
    }

    return this.isCurrentUser(userId) ? remote : null;
  }

  private async loadFocusSessionForPull(
    userId: string,
    local: DockSnapshot
  ): Promise<LoadFocusSessionResult> {
    const localSavedAt = typeof local.savedAt === 'string' && local.savedAt
      ? local.savedAt
      : undefined;

    return withTimeout(
      this.focusConsoleSync.loadFocusSession(userId, localSavedAt),
      { timeout: TIMEOUT_CONFIG.STANDARD, timeoutMessage: LOAD_FOCUS_SESSION_TIMEOUT_MESSAGE },
    );
  }

  private async resolveFocusSessionLoadResult(
    userId: string,
    loadResult: LoadFocusSessionResult
  ): Promise<unknown | null> {
    if (!loadResult.ok) {
      if (this.isBrowserSuspendedResult(loadResult.error)) {
        this.deferCloudPullForBrowserResume(userId, 'error');
        return null;
      }

      this.logger.warn('loadFocusSession returned error, skipping legacy fallback', loadResult.error);
      await this.hydrateRoutineSlots(userId);
      return null;
    }

    if (!loadResult.value) {
      await this.hydrateRoutineSlots(userId);
      return null;
    }

    return loadResult.value;
  }

  private applyPulledSnapshot(
    userId: string,
    cb: CloudSyncEngineCallbacks,
    remote: DockSnapshot
  ): void {
    if (this.isDestroyed) {
      return;
    }

    cb.restoreSnapshot(remote);
    // C-4 fix: 恢复远端快照后取消待执行的云推送，防止旧数据覆盖刚拉取的新快照
    this.cloudPushScheduler.cancelPendingPush();
    cb.scheduleLocalPersist(remote, userId);
    this.cloudPullRetryCount = 0;
    this.resetCircuitBreaker();
  }

  private handleCloudPullError(userId: string, rawError: unknown): void {
    if (this.isDestroyed) {
      return;
    }

    if (!this.isCurrentUser(userId)) {
      this.logger.debug('pullCloudSnapshot: stale owner error — skipping retry side effects', {
        userId,
        currentUserId: this.callbacks?.getCurrentSnapshotUserId(),
      });
      return;
    }

    if (isBrowserNetworkSuspendedError(rawError)) {
      this.deferCloudPullForBrowserResume(userId, 'error');
      return;
    }

    this.logCloudPullError(rawError);

    const statusCode = (rawError as { status?: number })?.status;
    if (statusCode === 401 || statusCode === 403) {
      this.openCircuitBreaker();
      return;
    }

    this.cloudPullRetryCount += 1;
    if (this.cloudPullRetryCount > PARKING_CONFIG.CLOUD_PULL_MAX_RETRIES) {
      this.logger.warn(`pullCloudSnapshot: max retries (${PARKING_CONFIG.CLOUD_PULL_MAX_RETRIES}) reached, giving up`);
      this.cloudPullRetryCount = 0;
      return;
    }

    this.scheduleCloudPullRetry(userId);
  }

  private logCloudPullError(rawError: unknown): void {
    const error = supabaseErrorToError(rawError);
    if (this.isLoadFocusSessionTimeout(rawError)) {
      this.logger.debug('pullCloudSnapshot: loadFocusSession timed out, keeping local focus snapshot', error);
      return;
    }

    this.logger.warn('Failed to pull focus session from cloud', error);
  }

  private scheduleCloudPullRetry(userId: string): void {
    if (this.isDestroyed) {
      return;
    }

    const baseMs = SYNC_CONFIG.DEBOUNCE_DELAY * 2 * Math.pow(2, this.cloudPullRetryCount - 1);
    const jitterMs = Math.floor(Math.random() * SYNC_CONFIG.DEBOUNCE_DELAY);
    const backoffMs = baseMs + jitterMs;
    this.cloudPullTimer.schedule(() => {
      if (this.isDestroyed) {
        return;
      }
      if (!this.isCurrentUser(userId)) {
        this.logger.debug('pullCloudSnapshot: stale owner retry — skipping', {
          userId,
          currentUserId: this.callbacks?.getCurrentSnapshotUserId(),
        });
        return;
      }
      this.lastCloudPullAt = 0;
      this.scheduleCloudPull(userId, false);
    }, backoffMs);
  }

  private isLoadFocusSessionTimeout(error: unknown): boolean {
    const message = String((error as { message?: string })?.message ?? error ?? '');
    return message.includes(LOAD_FOCUS_SESSION_TIMEOUT_MESSAGE);
  }

  // ─── Routine Slot Hydration ───────────────────

  private async hydrateRoutineSlots(userId: string): Promise<void> {
    if (this.isDestroyed) return;

    const cb = this.callbacks;
    if (!cb) return;

    try {
      const routineTasks = await this.loadRoutineTasksForHydration(userId);
      if (this.isDestroyed) return;
      if (routineTasks.length === 0) return;
      cb.updateDailySlots(prev => this.mergeRoutineTasksIntoSlots(prev, routineTasks));
    } catch (rawError) {
      if (isBrowserNetworkSuspendedError(rawError)) {
        this.logger.debug('hydrateRoutineSlots: 浏览器网络挂起窗口内跳过远端读取', { userId });
        return;
      }

      const error = supabaseErrorToError(rawError);
      this.logger.warn('hydrateRoutineSlots failed', error);
    }
  }

  private async loadRoutineTasksForHydration(userId: string): Promise<RoutineTask[]> {
    if (this.isDestroyed) return [];

    const listResult = await withTimeout(
      this.focusConsoleSync.listRoutineTasks(userId),
      { timeout: TIMEOUT_CONFIG.QUICK, timeoutMessage: 'listRoutineTasks 超时' },
    );
    // DATA-C5 fix: async 边界后检查用户是否仍为当前用户，防止跨用户数据污染
    if (this.isDestroyed || !this.isCurrentUser(userId)) return [];

    return this.resolveRoutineTaskListResult(userId, listResult);
  }

  private resolveRoutineTaskListResult(
    userId: string,
    listResult: RoutineTaskListResult
  ): RoutineTask[] {
    if (!listResult.ok) {
      if (this.isBrowserSuspendedResult(listResult.error)) {
        this.deferCloudPullForBrowserResume(userId, 'error');
        return [];
      }

      this.logger.warn('hydrateRoutineSlots: listRoutineTasks returned error', listResult.error);
      return [];
    }

    return listResult.value;
  }

  private mergeRoutineTasksIntoSlots(
    prev: DailySlotEntry[],
    routineTasks: RoutineTask[]
  ): DailySlotEntry[] {
    const byId = new Map(prev.map(slot => [slot.id, slot]));
    const next = [...prev];
    for (const routine of routineTasks) {
      const existing = byId.get(routine.routineId);
      if (existing) {
        this.replaceRoutineSlot(next, existing, routine);
        continue;
      }
      next.push(this.createRoutineSlotEntry(routine));
    }
    return next;
  }

  private replaceRoutineSlot(
    slots: DailySlotEntry[],
    existing: DailySlotEntry,
    routine: RoutineTask
  ): void {
    const idx = slots.findIndex(slot => slot.id === existing.id);
    if (idx < 0) return;

    slots[idx] = {
      ...existing,
      title: routine.title,
      maxDailyCount: routine.maxTimesPerDay,
      isEnabled: routine.isEnabled,
    };
  }

  private createRoutineSlotEntry(routine: RoutineTask): DailySlotEntry {
    return {
      id: routine.routineId,
      title: routine.title,
      maxDailyCount: routine.maxTimesPerDay,
      todayCompletedCount: 0,
      isEnabled: routine.isEnabled,
      createdAt: new Date().toISOString(),
    };
  }

  // ─── Focus Session Records ────────────────────

  buildFocusSessionRecord(
    userId: string,
    snapshot: DockSnapshot,
  ): FocusSessionRecord {
    const cb = this.callbacks;
    if (!cb) {
      this.logger.error('buildFocusSessionRecord called before init() — returning fallback record');
      const now = new Date().toISOString();
      return {
        id: crypto.randomUUID(),
        userId,
        startedAt: now,
        endedAt: null,
        snapshot,
        updatedAt: now,
      };
    }

    const currentContext = cb.getFocusSessionContext();
    const resolvedSessionId =
      snapshot.session.focusSessionId ??
      snapshot.focusSessionState?.sessionId ??
      currentContext?.id ??
      crypto.randomUUID();
    const resolvedSessionStartedAt =
      snapshot.session.focusSessionStartedAt ??
      snapshot.focusSessionState?.sessionStartedAt ??
      currentContext?.startedAt ??
      Date.now();

    cb.setFocusSessionContext({
      id: resolvedSessionId,
      startedAt: resolvedSessionStartedAt,
    });

    const updatedAt = snapshot.savedAt || new Date().toISOString();
    return {
      id: resolvedSessionId,
      userId,
      startedAt: new Date(resolvedSessionStartedAt).toISOString(),
      endedAt: snapshot.focusMode ? null : updatedAt,
      snapshot,
      updatedAt,
    };
  }

  // ─── Action Queue Enqueue Helpers ─────────────

  private async enqueueDurableSyncAction(
    ownerUserId: string,
    action: Parameters<ActionQueueService['enqueueDurablyForOwner']>[1],
    context: {
      entityType: string;
      entityId: string;
      onFailure?: () => void;
    },
  ): Promise<boolean> {
    try {
      const actionId = await this.actionQueue.enqueueDurablyForOwner(ownerUserId, action);
      if (actionId) {
        return true;
      }

      context.onFailure?.();
      this.logger.warn('离线同步操作未能完成 durable 入队', {
        ownerUserId,
        entityType: context.entityType,
        entityId: context.entityId,
      });
      return false;
    } catch (error: unknown) {
      context.onFailure?.();
      this.logger.error('离线同步操作 durable 入队异常', {
        ownerUserId,
        entityType: context.entityType,
        entityId: context.entityId,
        error,
      });
      return false;
    }
  }

  enqueueFocusSessionSync(userId: string, snapshot: DockSnapshot): Promise<boolean> {
    let fingerprint: string | undefined;
    try {
      // 免费层优化：生成快照指纹，跳过无变化的写入（日均节省 ~100 次 focus_sessions UPDATE）
      fingerprint = this.computeSnapshotFingerprint(snapshot);
      if (fingerprint === this.lastEnqueuedSnapshotFingerprints.get(userId)) {
        return Promise.resolve(true);
      }
      this.lastEnqueuedSnapshotFingerprints.set(userId, fingerprint);

      const record = this.buildFocusSessionRecord(userId, snapshot);
      return this.enqueueDurableSyncAction(userId, {
        type: 'update',
        entityType: 'focus-session',
        entityId: record.id,
        payload: { record, sourceUserId: userId },
        priority: 'critical',
      }, {
        entityType: 'focus-session',
        entityId: record.id,
        onFailure: () => {
          if (this.lastEnqueuedSnapshotFingerprints.get(userId) === fingerprint) {
            this.lastEnqueuedSnapshotFingerprints.delete(userId);
          }
        },
      });
    } catch (error) {
      this.logger.error('focus session sync setup failed', { userId, error });
      if (fingerprint !== undefined) {
        if (this.lastEnqueuedSnapshotFingerprints.get(userId) === fingerprint) {
          this.lastEnqueuedSnapshotFingerprints.delete(userId);
        }
      }
      return Promise.resolve(false);
    }
  }

  /** 计算快照业务指纹（忽略 savedAt 等时间戳，仅关注业务状态变化） */
  private computeSnapshotFingerprint(snapshot: DockSnapshot): string {
    return JSON.stringify({
      fm: snapshot.focusMode,
      mt: snapshot.session?.mainTaskId ?? null,
      cs: snapshot.session?.comboSelectIds ?? [],
      bs: snapshot.session?.backupIds ?? [],
      entries: snapshot.entries?.map(entry => ({
        id: entry.taskId,
        lane: entry.lane,
        status: entry.status,
        main: entry.isMain === true,
        order: entry.manualOrder ?? entry.dockedOrder,
      })) ?? [],
      ver: snapshot.version ?? 0,
      fs: snapshot.focusSessionState?.sessionId ?? null,
    });
  }

  enqueueRoutineTaskSync(userId: string, routineTask: RoutineTask): Promise<boolean> {
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return Promise.resolve(true);
    }

    return this.enqueueDurableSyncAction(userId, {
      type: 'update',
      entityType: 'routine-task',
      entityId: routineTask.routineId,
      payload: { userId, routineTask, sourceUserId: userId },
      priority: 'normal',
    }, {
      entityType: 'routine-task',
      entityId: routineTask.routineId,
    });
  }

  enqueueRoutineCompletionSync(completion: RoutineCompletionMutation): Promise<boolean> {
    if (completion.userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return Promise.resolve(true);
    }

    return this.enqueueDurableSyncAction(completion.userId, {
      type: 'create',
      entityType: 'routine-completion',
      entityId: completion.completionId,
      payload: { completion, sourceUserId: completion.userId },
      priority: 'normal',
    }, {
      entityType: 'routine-completion',
      entityId: completion.completionId,
    });
  }

  // ─── Cleanup ──────────────────────────────────

  ngOnDestroy(): void {
    if (this.isDestroyed) {
      return;
    }
    this.isDestroyed = true;
    this.cancelTimers();
  }

  cancelTimers(): void {
    this.cloudPushScheduler.cancel();
    this.directWidgetNotify.dispose();
    this.cloudPullTimer.cancel();
    this.circuitBreakerResetTimer.cancel();
    this.circuitBreakerOpen = false;
    this.cloudPullRetryCount = 0;
    this.lastCloudPullAt = 0;
  }

  /** 断路器：不可恢复错误时停止重试，30 秒后自动半开 */
  private openCircuitBreaker(): void {
    this.circuitBreakerOpen = true;
    this.cloudPullRetryCount = 0;
    this.logger.warn('Circuit breaker opened — halting cloud pull retries for 30s');
    this.circuitBreakerResetTimer.schedule(() => {
      if (this.isDestroyed) {
        return;
      }
      this.circuitBreakerOpen = false;
      this.logger.info('Circuit breaker half-open — next pull attempt allowed');
    }, PARKING_CONFIG.CLOUD_CIRCUIT_BREAKER_RESET_MS);
  }

  private resetCircuitBreaker(): void {
    if (this.circuitBreakerOpen) {
      this.circuitBreakerOpen = false;
      this.circuitBreakerResetTimer.cancel();
    }
  }
}
