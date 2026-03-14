/**
 * DockCloudSyncService
 * Cloud push/pull synchronization, focus session record management,
 * routine task & completion sync enqueuing.
 * Extracted from DockEngineService to decouple network/cloud operations
 * from business state logic.
 */
import { Injectable, inject } from '@angular/core';
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

const CLOUD_PUSH_DEBOUNCE_MS = SYNC_CONFIG.DEBOUNCE_DELAY;
const CLOUD_PULL_DEBOUNCE_MS = 250;
const CLOUD_PULL_MIN_INTERVAL_MS = 5000;

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
}

@Injectable({
  providedIn: 'root',
})
export class DockCloudSyncService {
  private readonly syncService = inject(SimpleSyncService);
  private readonly actionQueue = inject(ActionQueueService);
  private readonly snapshotPersistence = inject(DockSnapshotPersistenceService);
  private readonly logger = inject(LoggerService).category('DockCloudSync');

  private cloudPushTimer: ReturnType<typeof setTimeout> | null = null;
  private cloudPullTimer: ReturnType<typeof setTimeout> | null = null;
  private cloudPullRetryCount = 0;
  private lastCloudPullAt = 0;

  private callbacks: CloudSyncEngineCallbacks | null = null;

  /**
   * Initialize with engine callbacks. Must be called once during
   * DockEngineService construction before any sync operations.
   */
  init(callbacks: CloudSyncEngineCallbacks): void {
    this.callbacks = callbacks;
  }

  // ─── Cloud Push ───────────────────────────────

  scheduleCloudPush(userId: string, snapshot: DockSnapshot | null): void {
    const cb = this.callbacks;
    if (!cb) return;

    if (this.cloudPushTimer) clearTimeout(this.cloudPushTimer);
    const runPush = () => {
      const holdDelay = cb.getNonCriticalHoldDelay();
      if (holdDelay > 0) {
        this.cloudPushTimer = setTimeout(runPush, holdDelay);
        return;
      }
      this.cloudPushTimer = null;
      const resolved = snapshot ?? cb.exportSnapshot();
      this.enqueueFocusSessionSync(userId, resolved);
    };
    this.cloudPushTimer = setTimeout(runPush, CLOUD_PUSH_DEBOUNCE_MS);
  }

  // ─── Cloud Pull ───────────────────────────────

  scheduleCloudPull(userId: string, force: boolean): void {
    if (!force && Date.now() - this.lastCloudPullAt < CLOUD_PULL_MIN_INTERVAL_MS) return;
    if (this.cloudPullTimer) clearTimeout(this.cloudPullTimer);
    this.cloudPullTimer = setTimeout(() => {
      void this.pullCloudSnapshot(userId);
    }, CLOUD_PULL_DEBOUNCE_MS);
  }

  private async pullCloudSnapshot(userId: string): Promise<void> {
    const cb = this.callbacks;
    if (!cb) return;

    this.lastCloudPullAt = Date.now();
    const ctx = cb.buildNormalizeContext();
    try {
      let remoteRaw = await withTimeout(
        this.syncService.loadFocusSession(userId),
        { timeout: TIMEOUT_CONFIG.STANDARD, timeoutMessage: 'loadFocusSession 超时' },
      );

      // One-time cloud migration path from legacy user_preferences.dock_snapshot.
      if (!remoteRaw) {
        const legacyRaw = await withTimeout(
          this.syncService.importLegacyDockSnapshot(userId),
          { timeout: TIMEOUT_CONFIG.STANDARD, timeoutMessage: 'importLegacyDockSnapshot 超时' },
        );
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
      const local = cb.exportSnapshot();
      if (!this.snapshotPersistence.isSnapshotNewer(remote, local)) {
        await this.hydrateRoutineSlots(userId);
        return;
      }

      cb.restoreSnapshot(remote);
      cb.scheduleLocalPersist(remote, userId);
      await this.hydrateRoutineSlots(userId);
      this.cloudPullRetryCount = 0; // reset on success
    } catch (error) {
      this.logger.warn('Failed to pull focus session from cloud', error);
      this.cloudPullRetryCount += 1;
      if (this.cloudPullRetryCount > 5) {
        this.logger.warn('pullCloudSnapshot: max retries (5) reached, giving up');
        this.cloudPullRetryCount = 0;
        return;
      }
      // 拉取失败后延迟重试（指数退避），避免静默丢失云端数据（离线优先 RetryQueue 语义）
      const backoffMs = SYNC_CONFIG.DEBOUNCE_DELAY * 2 * Math.pow(2, this.cloudPullRetryCount - 1);
      if (this.cloudPullTimer) clearTimeout(this.cloudPullTimer);
      this.cloudPullTimer = setTimeout(() => {
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
      const routineTasks = await withTimeout(
        this.syncService.listRoutineTasks(userId),
        { timeout: TIMEOUT_CONFIG.QUICK, timeoutMessage: 'listRoutineTasks 超时' },
      );
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
    } catch (error) {
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

  cancelTimers(): void {
    if (this.cloudPushTimer) {
      clearTimeout(this.cloudPushTimer);
      this.cloudPushTimer = null;
    }
    if (this.cloudPullTimer) {
      clearTimeout(this.cloudPullTimer);
      this.cloudPullTimer = null;
    }
  }
}
