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
import { SimpleSyncService } from '../core-bridge';
import { ActionQueueService } from './action-queue.service';
import {
  DockSnapshotPersistenceService,
  type SnapshotNormalizeContext,
} from './dock-snapshot-persistence.service';
import { LoggerService } from './logger.service';
import { withTimeout } from '../utils/timeout';
import { TimerHandle } from '../utils/timer-handle';
import { supabaseErrorToError } from '../utils/supabase-error';

const CLOUD_PUSH_DEBOUNCE_MS = SYNC_CONFIG.DEBOUNCE_DELAY;
const CLOUD_PULL_DEBOUNCE_MS = PARKING_CONFIG.CLOUD_PULL_DEBOUNCE_MS;
const CLOUD_PULL_MIN_INTERVAL_MS = PARKING_CONFIG.CLOUD_PULL_MIN_INTERVAL_MS;

/**
 * Callbacks provided by DockEngineService for engine state mutations
 * that must happen during cloud sync operations.
 */
export interface CloudSyncEngineCallbacks {
  exportSnapshot: () => DockSnapshot;
  restoreSnapshot: (snapshot: DockSnapshot) => void;
  scheduleLocalPersist: (snapshot: DockSnapshot, userId: string) => void;
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
  private readonly syncService = inject(SimpleSyncService);
  private readonly actionQueue = inject(ActionQueueService);
  private readonly snapshotPersistence = inject(DockSnapshotPersistenceService);
  private readonly logger = inject(LoggerService).category('DockCloudSync');

  private readonly cloudPushTimer = new TimerHandle();
  private readonly cloudPullTimer = new TimerHandle();
  private cloudPullRetryCount = 0;
  private lastCloudPullAt = 0;

  private callbacks: CloudSyncEngineCallbacks | null = null;

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

  /** H-3: 异步操作后检查用户是否仍为当前用户，防止跨用户数据污染 */
  private isCurrentUser(userId: string): boolean {
    return this.callbacks?.getCurrentSnapshotUserId() === userId;
  }

  // ─── Cloud Push ───────────────────────────────

  scheduleCloudPush(userId: string, snapshot: DockSnapshot | null): void {
    const cb = this.callbacks;
    if (!cb) return;

    const runPush = () => {
      const holdDelay = cb.getNonCriticalHoldDelay();
      if (holdDelay > 0) {
        this.cloudPushTimer.schedule(runPush, holdDelay);
        return;
      }
      const resolved = snapshot ?? cb.exportSnapshot();
      this.enqueueFocusSessionSync(userId, resolved);
    };
    this.cloudPushTimer.schedule(runPush, CLOUD_PUSH_DEBOUNCE_MS);
  }

  // ─── Cloud Pull ───────────────────────────────

  scheduleCloudPull(userId: string, force: boolean): void {
    if (!force && Date.now() - this.lastCloudPullAt < CLOUD_PULL_MIN_INTERVAL_MS) return;
    // H-4 fix: 强制拉取时重置重试计数（用户切换场景）
    if (force) this.cloudPullRetryCount = 0;
    this.cloudPullTimer.schedule(() => {
      void this.pullCloudSnapshot(userId);
    }, CLOUD_PULL_DEBOUNCE_MS);
  }

  private async pullCloudSnapshot(userId: string): Promise<void> {
    const cb = this.callbacks;
    if (!cb) return;

    this.lastCloudPullAt = Date.now();
    const ctx = cb.buildNormalizeContext();
    try {
      // H-1 fix: 传递本地快照的 savedAt 用于服务端 LWW 短路优化
      const local = cb.exportSnapshot();
      const localSavedAt = typeof local?.savedAt === 'number'
        ? new Date(local.savedAt).toISOString()
        : undefined;

      const loadResult = await withTimeout(
        this.syncService.loadFocusSession(userId, localSavedAt),
        { timeout: TIMEOUT_CONFIG.STANDARD, timeoutMessage: 'loadFocusSession 超时' },
      );

      // H-2 fix: 显式检查 Result.ok，区分错误和"无数据"
      if (!loadResult.ok) {
        this.logger.warn('loadFocusSession returned error, skipping legacy fallback', loadResult.error);
        await this.hydrateRoutineSlots(userId);
        return;
      }
      let remoteRaw = loadResult.value;

      // H-3 fix: 异步点后检查用户是否已切换
      if (!this.isCurrentUser(userId)) return;

      // One-time cloud migration path from legacy user_preferences.dock_snapshot.
      if (!remoteRaw) {
        const legacyResult = await withTimeout(
          this.syncService.importLegacyDockSnapshot(userId),
          { timeout: TIMEOUT_CONFIG.STANDARD, timeoutMessage: 'importLegacyDockSnapshot 超时' },
        );
        if (!legacyResult.ok) {
          this.logger.warn('importLegacyDockSnapshot returned error', legacyResult.error);
        }
        const legacyRaw = legacyResult.ok ? legacyResult.value : null;
        if (!this.isCurrentUser(userId)) return; // H-3: 再次检查
        const legacy = this.snapshotPersistence.normalizeSnapshot(legacyRaw, ctx);
        if (legacy) {
          this.enqueueFocusSessionSync(userId, legacy);
          remoteRaw = legacy;
        }
      }
      if (!remoteRaw) {
        await this.hydrateRoutineSlots(userId);
        return;
      }

      const remote = this.snapshotPersistence.normalizeSnapshot(remoteRaw, ctx);
      if (!remote) {
        await this.hydrateRoutineSlots(userId);
        return;
      }
      if (!this.snapshotPersistence.isSnapshotNewer(remote, local)) {
        await this.hydrateRoutineSlots(userId);
        return;
      }

      // H-3 fix: 恢复前最终检查用户是否仍然一致
      if (!this.isCurrentUser(userId)) return;
      cb.restoreSnapshot(remote);
      cb.scheduleLocalPersist(remote, userId);
      await this.hydrateRoutineSlots(userId);
      this.cloudPullRetryCount = 0; // reset on success
    } catch (rawError) {
      const error = supabaseErrorToError(rawError);
      this.logger.warn('Failed to pull focus session from cloud', error);
      this.cloudPullRetryCount += 1;
      if (this.cloudPullRetryCount > PARKING_CONFIG.CLOUD_PULL_MAX_RETRIES) {
        this.logger.warn(`pullCloudSnapshot: max retries (${PARKING_CONFIG.CLOUD_PULL_MAX_RETRIES}) reached, giving up`);
        this.cloudPullRetryCount = 0;
        return;
      }
      // 拉取失败后延迟重试（指数退避 + 随机抖动），避免多客户端同时重试造成雷群效应
      const baseMs = SYNC_CONFIG.DEBOUNCE_DELAY * 2 * Math.pow(2, this.cloudPullRetryCount - 1);
      const jitterMs = Math.floor(Math.random() * SYNC_CONFIG.DEBOUNCE_DELAY);
      const backoffMs = baseMs + jitterMs;
      this.cloudPullTimer.schedule(() => {
        this.lastCloudPullAt = 0; // 允许下次立即拉取
        this.scheduleCloudPull(userId, false);
      }, backoffMs);
    }
  }

  // ─── Routine Slot Hydration ───────────────────

  private async hydrateRoutineSlots(userId: string): Promise<void> {
    const cb = this.callbacks;
    if (!cb) return;

    try {
      const listResult = await withTimeout(
        this.syncService.listRoutineTasks(userId),
        { timeout: TIMEOUT_CONFIG.QUICK, timeoutMessage: 'listRoutineTasks 超时' },
      );
      const routineTasks = listResult.ok ? listResult.value : [];
      if (routineTasks.length === 0) return;
      cb.updateDailySlots(prev => {
        const byId = new Map(prev.map(slot => [slot.id, slot]));
        const next = [...prev];
        for (const routine of routineTasks) {
          const existing = byId.get(routine.routineId);
          if (existing) {
            const merged: DailySlotEntry = {
              ...existing,
              title: routine.title,
              maxDailyCount: routine.maxTimesPerDay,
              isEnabled: routine.isEnabled,
            };
            const idx = next.findIndex(slot => slot.id === existing.id);
            if (idx >= 0) next[idx] = merged;
            continue;
          }
          next.push({
            id: routine.routineId,
            title: routine.title,
            maxDailyCount: routine.maxTimesPerDay,
            todayCompletedCount: 0,
            isEnabled: routine.isEnabled,
            createdAt: new Date().toISOString(),
          });
        }
        return next;
      });
    } catch (rawError) {
      const error = supabaseErrorToError(rawError);
      this.logger.warn('hydrateRoutineSlots failed', error);
    }
  }

  // ─── Focus Session Records ────────────────────

  buildFocusSessionRecord(
    userId: string,
    snapshot: DockSnapshot,
  ): FocusSessionRecord {
    const cb = this.callbacks;
    if (!cb) {
      throw new Error('DockCloudSyncService not initialized');
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

  enqueueFocusSessionSync(userId: string, snapshot: DockSnapshot): void {
    const record = this.buildFocusSessionRecord(userId, snapshot);
    this.actionQueue.enqueue({
      type: 'update',
      entityType: 'focus-session',
      entityId: record.id,
      payload: { record },
      priority: 'critical',
    });
  }

  enqueueRoutineTaskSync(userId: string, routineTask: RoutineTask): void {
    this.actionQueue.enqueue({
      type: 'update',
      entityType: 'routine-task',
      entityId: routineTask.routineId,
      payload: { userId, routineTask },
      priority: 'normal',
    });
  }

  enqueueRoutineCompletionSync(completion: RoutineCompletionMutation): void {
    this.actionQueue.enqueue({
      type: 'create',
      entityType: 'routine-completion',
      entityId: completion.completionId,
      payload: { completion },
      priority: 'normal',
    });
  }

  // ─── Cleanup ──────────────────────────────────

  ngOnDestroy(): void {
    this.cancelTimers();
  }

  cancelTimers(): void {
    this.cloudPushTimer.cancel();
    this.cloudPullTimer.cancel();
  }
}
