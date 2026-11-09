import type { Task } from '../models';
import type {
  ParkedTaskCacheSaveOptions,
  ParkedTaskDeltaResult,
  ParkedTaskRemoval,
} from '../core-bridge';
import { POLLING_CHECK_DELAY } from '../config/timeout.config';
import { isLocalModeEnabled } from './guards/auth.guard';
import {
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedWindow,
} from '../utils/browser-network-suspension';
import {
  buildParkedTaskCacheEntries,
  mergeRemoteParkedTask,
  shouldApplyRemoteParkedTask,
} from './parking-task-cache.helpers';

interface ParkingDeltaSyncLogger {
  debug(source: string, message: string, data?: unknown): void;
  warn(source: string, message: string, data?: unknown): void;
}

export interface ParkingDeltaSyncControllerOptions {
  logger: ParkingDeltaSyncLogger;
  isDestroyed: () => boolean;
  currentUserId: () => string | null;
  knownParkedTaskIds: () => string[];
  activeProjectIds: () => string[];
  pullParkedTasksDelta: (
    cursor: string | null,
    knownParkedTaskIds: string[],
    knownProjectIds: string[],
  ) => Promise<ParkedTaskDeltaResult>;
  getTask: (taskId: string) => Task | undefined;
  setTask: (task: Task, projectId: string) => void;
  parkedTasks: () => Task[];
  findProjectId: (taskId: string) => string | null;
  saveParkedTasksCache: (ownerUserId: string, snapshot: {
    entries: Array<{ task: Task; projectId: string }>;
    cursor: string | null;
  }, options?: ParkedTaskCacheSaveOptions) => Promise<void>;
  getParkedCursor: () => string | null;
  setParkedCursor: (cursor: string | null) => void;
  getRecoveryTimer: () => ReturnType<typeof setTimeout> | null;
  setRecoveryTimer: (timer: ReturnType<typeof setTimeout> | null) => void;
}

/**
 * 停泊任务轻量增量同步控制器（A3.4）— 从 ParkingService 拆分
 *
 * 职责：增量拉取停泊任务 delta（含 LWW 合并与 removal 应用）、
 * 账号切换游标复位、挂起/隐藏/项目未就绪场景下的恢复补拉调度。
 * 游标与恢复 timer 字段仍归属 ParkingService（快照持久化与
 * ngOnDestroy 清理链依赖它们），通过 get/set 闭包读写。
 * 非 DI 协作类：行为由 parking.service.spec.ts 的轻量同步用例覆盖。
 */
export class ParkingDeltaSyncController {
  private parkedDeltaGeneration = 0;
  /** 最近一次停泊增量同步的 owner，账号切换时用于复位游标 */
  private lastParkedSyncOwnerUserId: string | null = null;

  constructor(private readonly options: ParkingDeltaSyncControllerOptions) {}

  resetSession(): void {
    this.parkedDeltaGeneration += 1;
    this.lastParkedSyncOwnerUserId = null;
  }

  async syncParkedDelta(): Promise<void> {
    // M-24 fix: 离线时跳过增量拉取，避免不必要的网络错误
    if (this.options.isDestroyed()) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    const ownerUserId = this.options.currentUserId();
    if (!ownerUserId || isLocalModeEnabled()) return;
    this.resetParkedCursorOnOwnerChange(ownerUserId);
    if (!this.passesParkedDeltaVisibilityGate()) return;

    const knownParkedTaskIds = this.options.knownParkedTaskIds();
    const knownProjectIds = this.options.activeProjectIds();
    if (knownProjectIds.length === 0) {
      this.options.logger.debug('ParkingService', '项目列表未就绪，跳过停泊任务增量同步');
      this.scheduleParkedDeltaProjectRetry();
      return;
    }

    const generation = ++this.parkedDeltaGeneration;
    const since = this.options.getParkedCursor();
    const delta = await this.options.pullParkedTasksDelta(
      since,
      knownParkedTaskIds,
      knownProjectIds,
    );

    if (this.isParkedDeltaStale(generation, ownerUserId)) {
      return;
    }

    await this.applyParkedDelta(
      delta,
      ownerUserId,
      since === null && delta.isComplete,
    );
  }

  /**
   * 挂起窗口与后台标签页守卫：
   * - 挂起窗口内跳过拉取，可见时排队恢复补拉；
   * - 后台标签页跳过周期拉取（与主轮询 paused 语义一致）：
   *   切回前台时 visibility 事件驱动的 scheduleParkedDeltaRefresh 会立即补拉。
   *   必须放在挂起窗口检查之后：isBrowserNetworkSuspendedWindow() 在隐藏期
   *   有惰性 arming 副作用，绕过它会让恢复补拉的宽限窗计算失真
   */
  private passesParkedDeltaVisibilityGate(): boolean {
    if (isBrowserNetworkSuspendedWindow()) {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        this.scheduleParkedDeltaRefresh('network-suspended');
      }
      return false;
    }
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return false;
    return true;
  }

  /** 拉取期间销毁/并发新 generation/账号切换时，旧结果一律丢弃 */
  private isParkedDeltaStale(generation: number, ownerUserId: string): boolean {
    return (
      this.options.isDestroyed() ||
      generation !== this.parkedDeltaGeneration ||
      this.options.currentUserId() !== ownerUserId
    );
  }

  private async applyParkedDelta(
    delta: ParkedTaskDeltaResult,
    ownerUserId: string,
    retireLegacyOwnerlessCache: boolean,
  ): Promise<void> {
    const hasChanges = delta.entries.length > 0 || delta.removedTaskIds.length > 0;

    if (hasChanges) {
      for (const entry of delta.entries) {
        this.applyRemoteParkedEntry(entry.task, entry.projectId);
      }

      const removals = delta.removedTasks ?? delta.removedTaskIds.map((taskId) => ({
        taskId,
        updatedAt: null,
      }));
      for (const removal of removals) {
        this.applyRemoteParkingRemoval(removal);
      }
    }

    this.options.setParkedCursor(delta.nextCursor ?? this.options.getParkedCursor());

    if (!hasChanges && !retireLegacyOwnerlessCache) {
      return;
    }

    await this.saveParkedDeltaCacheSnapshot(ownerUserId, retireLegacyOwnerlessCache);
  }

  private async saveParkedDeltaCacheSnapshot(
    ownerUserId: string,
    retireLegacyOwnerlessCache: boolean,
  ): Promise<void> {
    // 增量结果回写缓存（覆盖式，数据量小）
    const entries = buildParkedTaskCacheEntries(
      this.options.parkedTasks(),
      (taskId) => this.options.findProjectId(taskId)
    );

    const snapshot = {
      entries,
      cursor: this.options.getParkedCursor(),
    };
    if (retireLegacyOwnerlessCache) {
      await this.options.saveParkedTasksCache(ownerUserId, snapshot, {
        retireLegacyOwnerlessCache: true,
      });
      return;
    }

    await this.options.saveParkedTasksCache(ownerUserId, snapshot);
  }

  /**
   * 账号切换后（登出→登录，无整页刷新）残留的旧 owner 游标会让新账号的
   * `updated_at > cursor` 增量查询漏掉早于该游标的停泊任务，并被缓存快照持久化，必须先复位
   */
  private resetParkedCursorOnOwnerChange(ownerUserId: string): void {
    if (this.lastParkedSyncOwnerUserId === ownerUserId) {
      return;
    }

    if (this.lastParkedSyncOwnerUserId !== null) {
      this.options.setParkedCursor(null);
    }
    this.lastParkedSyncOwnerUserId = ownerUserId;
  }

  restoreOwnerScopedCursor(ownerUserId: string, cursor: string | null): void {
    this.lastParkedSyncOwnerUserId = ownerUserId;
    this.options.setParkedCursor(cursor);
  }

  scheduleParkedDeltaRefresh(reason: 'visible' | 'online' | 'network-suspended'): void {
    if (this.options.getRecoveryTimer() !== null) return;
    if (!this.canRunParkedDeltaRecovery()) return;

    const delayMs = Math.max(100, getRemainingBrowserNetworkResumeDelayMs() + 50);
    this.options.setRecoveryTimer(setTimeout(() => {
      this.options.setRecoveryTimer(null);
      if (!this.canRunParkedDeltaRecovery()) return;
      this.syncParkedDeltaInBackground();
    }, delayMs));

    this.options.logger.debug('ParkingService', '延后停泊任务增量同步以避开浏览器网络挂起窗口', {
      reason,
      delayMs,
    });
  }

  scheduleParkedDeltaProjectRetry(): void {
    if (this.options.getRecoveryTimer() !== null) return;
    if (!this.canRunParkedDeltaRecovery()) return;

    this.options.setRecoveryTimer(setTimeout(() => {
      this.options.setRecoveryTimer(null);
      if (!this.canRunParkedDeltaRecovery()) return;
      this.syncParkedDeltaInBackground();
    }, POLLING_CHECK_DELAY.CONDITION_READY));

    this.options.logger.debug('ParkingService', '项目列表未就绪，延后重试停泊任务增量同步', {
      delayMs: POLLING_CHECK_DELAY.CONDITION_READY,
    });
  }

  private canRunParkedDeltaRecovery(): boolean {
    if (this.options.isDestroyed()) return false;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return false;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return false;
    return !!this.options.currentUserId() && !isLocalModeEnabled();
  }

  syncParkedDeltaInBackground(): void {
    void this.syncParkedDelta().catch((error: unknown) => {
      this.options.logger.warn(
        'ParkingService',
        'background parked delta sync failed',
        error,
      );
    });
  }

  applyRemoteParkedEntry(task: Task, projectId: string): void {
    const local = this.options.getTask(task.id);
    // C-3 fix: LWW 检查 — 本地版本更新时跳过远端覆盖
    if (!shouldApplyRemoteParkedTask(local, task)) {
      return;
    }

    this.options.setTask(mergeRemoteParkedTask(local, task), projectId);
  }

  private applyRemoteParkingRemoval(removal: ParkedTaskRemoval): void {
    const task = this.options.getTask(removal.taskId);
    if (!task?.parkingMeta) return;
    if (
      task.updatedAt &&
      removal.updatedAt &&
      task.updatedAt > removal.updatedAt
    ) {
      return;
    }

    const projectId = this.options.findProjectId(removal.taskId);
    if (!projectId) return;
    this.options.setTask({ ...task, parkingMeta: undefined }, projectId);
  }
}
