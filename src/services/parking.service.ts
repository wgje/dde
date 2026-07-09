import { Injectable, Injector, inject, signal, computed, OnDestroy } from '@angular/core';
import { TaskStore, ProjectStore } from '../app/core/state/stores';
import {
  Task,
  TaskParkingMeta,
  EvictionToken,
  ParkingNotice,
  ParkingNoticeEvictionItem,
} from '../models';
import { PARKING_CONFIG } from '../config/parking.config';
import { SYNC_CONFIG } from '../config/sync.config';
import { POLLING_CHECK_DELAY } from '../config/timeout.config';
import { ToastService } from './toast.service';
import { UndoService } from './undo.service';
import { LoggerService } from './logger.service';
import { BeforeUnloadManagerService } from './before-unload-manager.service';
import { StartupTierOrchestratorService } from './startup-tier-orchestrator.service';
import { GateService } from './gate.service';
import { ContextRestoreService } from './context-restore.service';
import { AuthService } from './auth.service';
import { TaskOperationAdapterService } from './task-operation-adapter.service';
import { isLocalModeEnabled } from './guards/auth.guard';
import { ProjectDataService, type ParkedTaskRemoval } from '../core-bridge';
import {
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedWindow,
} from '../utils/browser-network-suspension';
import {
  buildParkedTaskCacheEntries,
  mergeRemoteParkedTask,
  shouldApplyRemoteParkedTask,
} from './parking-task-cache.helpers';
import {
  findParkingProjectId,
} from './parking-note.helpers';
import { ParkingNoticeController } from './parking-notice.controller';
import { ParkingEvictionController } from './parking-eviction.controller';
import { ParkingSnapshotPersistenceController } from './parking-snapshot-persistence.controller';
import { ParkingMetaWriterController } from './parking-meta-writer.controller';
import {
  cleanupParkingFirstInteractionListeners,
  cleanupParkingLifecycleHandles,
  setupParkingFirstInteractionListeners,
} from './parking-lifecycle-cleanup.helpers';
import { ParkingTaskLifecycleController } from './parking-task-lifecycle.controller';
import { initializeParkingStartupLifecycle } from './parking-startup-lifecycle.controller';
import { buildParkingStartWorkUpdates } from './parking-start-work.helpers';
import { ParkingUndoRecorderController } from './parking-undo-recorder.controller';
import {
  findFocusedParkingTask,
  getActiveParkingProjectIds,
  hasUpcomingParkingReminder,
  isParkingOverSoftLimit,
} from './parking-derived-state.helpers';
import { selectStaleParkingEvictionCandidates } from './parking-eviction-schedule.helpers';

@Injectable({
  providedIn: 'root'
})
export class ParkingService implements OnDestroy {
  // ─── 依赖注入 ───
  private readonly injector = inject(Injector);
  private readonly taskStore = inject(TaskStore);
  private readonly projectStore = inject(ProjectStore);
  private readonly toastService = inject(ToastService);
  private readonly undoService = inject(UndoService);
  private readonly logger = inject(LoggerService);
  private readonly beforeUnloadManager = inject(BeforeUnloadManagerService);
  private readonly startupOrchestrator = inject(StartupTierOrchestratorService);
  private readonly gateService = inject(GateService);
  private readonly contextRestoreService = inject(ContextRestoreService);
  private readonly projectDataService = inject(ProjectDataService);
  private readonly authService = inject(AuthService);

  private get taskOpsAdapter(): TaskOperationAdapterService {
    return this.injector.get(TaskOperationAdapterService);
  }

  // ─── 内部状态 ───
  private readonly noticeController = new ParkingNoticeController({
    reminderBadgeThreshold: PARKING_CONFIG.REMINDER_BADGE_THRESHOLD,
  });
  private readonly evictionController = new ParkingEvictionController({
    undoTimeoutMs: PARKING_CONFIG.EVICTION_UNDO_TIMEOUT_MS,
    noticeMinVisibleMs: PARKING_CONFIG.NOTICE_MIN_VISIBLE_MS,
    noticeFallbackTimeoutMs: PARKING_CONFIG.NOTICE_FALLBACK_TIMEOUT_MS,
  });
  private readonly metaWriter = new ParkingMetaWriterController({
    taskById: (taskId) => this.taskStore.getTask(taskId),
    findProjectId: (taskId) => this.findProjectId(taskId),
    setTask: (task) => this.taskOpsAdapter.updateTaskParkingMeta(task.id, task.parkingMeta),
  });
  private readonly snapshotPersistenceController = new ParkingSnapshotPersistenceController({
    draftKey: PARKING_CONFIG.SNAPSHOT_DRAFT_KEY,
    focusedTask: () => this.focusedTask(),
    parkedTasks: () => this.taskStore.parkedTasks(),
    taskById: (taskId) => this.taskStore.getTask(taskId),
    findProjectId: (taskId) => this.findProjectId(taskId),
    updateParkingMeta: (taskId, meta) => this.metaWriter.update(taskId, meta),
    saveFullSnapshot: (taskId) => this.contextRestoreService.saveSnapshot(taskId),
    saveParkedTasksCache: (snapshot) => this.projectDataService.saveParkedTasksCache(snapshot),
    parkedCursor: () => this.parkedCursor,
  });
  private readonly taskLifecycleController = new ParkingTaskLifecycleController({
    taskById: (taskId) => this.taskStore.getTask(taskId),
    findProjectId: (taskId) => this.findProjectId(taskId),
    clearParkingMeta: (taskId) => this.metaWriter.clear(taskId),
    updateParkingMeta: (taskId, meta) => this.metaWriter.update(taskId, meta),
    updateTaskContent: (taskId, content) => this.taskOpsAdapter.updateTaskContent(taskId, content),
    setTask: (task, projectId) => this.taskStore.setTask(task, projectId),
    previewingTaskId: () => this.previewingTaskId(),
    setPreviewingTaskId: (taskId) => this.previewingTaskId.set(taskId),
    showInfo: (message) => this.toastService.info(message),
  });
  private readonly undoRecorder = new ParkingUndoRecorderController({
    findProjectId: (taskId) => this.findProjectId(taskId),
    getProject: (projectId) => this.projectStore.getProject(projectId),
    createProjectSnapshot: (project) => this.undoService.createProjectSnapshot(project),
    recordAction: (action) => this.undoService.recordAction(action),
  });
  readonly pendingNotices = this.noticeController.pendingNotices;

  /** 当前预览中的任务 ID */
  readonly previewingTaskId = signal<string | null>(null);

  /** 衰老清理是否已初始化*/
  private evictionInitialized = false;
  /** 停泊轻量数据初始化 Promise（防并发：多次调用返回同一 Promise） */
  private parkedLightweightInitPromise: Promise<void> | null = null;
  /** 衰老检查轮询定时器 */
  private evictionIntervalTimer: ReturnType<typeof setInterval> | null = null;
  /** 停泊轻量增量拉取定时器 */
  private parkedDeltaTimer: ReturnType<typeof setInterval> | null = null;
  /** 启动延迟执行 timer */
  private startupEvictionTimer: ReturnType<typeof setTimeout> | null = null;
  /** 挂起恢复后的停泊增量补拉 timer */
  private parkedDeltaRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  /** M-13: initEviction 递归 ready-check 定时器 */
  private evictionReadyCheckTimer: ReturnType<typeof setTimeout> | null = null;
  /** 在线事件监听器 */
  private onlineListener: (() => void) | null = null;
  private parkedSyncOnlineListener: (() => void) | null = null;
  private visibilityChangeHandler: (() => void) | null = null;
  /** 首次交互监听器 */
  private firstInteractionHandler: (() => void) | null = null;
  private isDestroyed = false;
  private parkedDeltaGeneration = 0;
  /** 停泊轻量同步游标 */
  private parkedCursor: string | null = null;
  /** 最近一次停泊增量同步的 owner，账号切换时用于复位游标 */
  private lastParkedSyncOwnerUserId: string | null = null;
  /** 衰老清理固定巡检周期 */
  private static readonly EVICTION_CHECK_INTERVAL_MS = 60_000;
  /**
   * 停泊任务增量拉取周期：对齐主轮询活跃间隔（120s）。
   * 之前复用 60s 衰老巡检周期作为网络节拍，空闲时每小时 ~180 个请求，
   * 约为主轮询流量的 30 倍；可见性/在线事件驱动的 scheduleParkedDeltaRefresh
   * 负责状态变化时的即时补拉，周期拉取只是兜底。
   */
  private static readonly PARKED_DELTA_SYNC_INTERVAL_MS = SYNC_CONFIG.POLLING_ACTIVE_INTERVAL;

  readonly badgedTaskIds = this.noticeController.badgedTaskIds;

  // ─── 派生状态 ───

  /** 当前 focused 任务（同一时刻最多 1 个，A4 不变量） */
  readonly focusedTask = computed(() => findFocusedParkingTask(this.taskStore.parkedTasks()));

  /** 停泊任务数量 */
  readonly parkedCount = computed(() => this.taskStore.parkedTaskIds().size);

  /** 是否有即将到期的提醒（< 1h） */
  readonly hasUpcomingReminder = computed(() =>
    hasUpcomingParkingReminder(this.taskStore.parkedTasks(), Date.now(), 60 * 60 * 1000));

  constructor() {
    const handles = initializeParkingStartupLifecycle({
      beforeUnloadPriority: PARKING_CONFIG.BEFORE_UNLOAD_PRIORITY,
      registerBeforeUnload: (key, callback, priority) =>
        this.beforeUnloadManager.register(key, callback, priority),
      saveSnapshotToLocalStorage: () =>
        this.snapshotPersistenceController.saveSnapshotToLocalStorage(),
      saveSnapshotToIndexedDB: () =>
        this.snapshotPersistenceController.saveSnapshotToIndexedDB(),
      scheduleParkedDeltaRefresh: (reason) =>
        this.scheduleParkedDeltaRefresh(reason),
      initEviction: () => this.initEviction(),
      initParkedLightweightSync: () => this.initParkedLightweightSync(),
    });
    this.visibilityChangeHandler = handles.visibilityChangeHandler;
    this.parkedSyncOnlineListener = handles.parkedSyncOnlineListener;
  }

  /**
   * 【修复 P1-08】清理所有定时器和事件监听器，防止内存泄漏
   */
  ngOnDestroy(): void {
    this.isDestroyed = true;
    const cleaned = cleanupParkingLifecycleHandles({
      evictionIntervalTimer: this.evictionIntervalTimer,
      parkedDeltaTimer: this.parkedDeltaTimer,
      startupEvictionTimer: this.startupEvictionTimer,
      parkedDeltaRecoveryTimer: this.parkedDeltaRecoveryTimer,
      evictionReadyCheckTimer: this.evictionReadyCheckTimer,
      onlineListener: this.onlineListener,
      parkedSyncOnlineListener: this.parkedSyncOnlineListener,
      visibilityChangeHandler: this.visibilityChangeHandler,
      firstInteractionHandler: this.firstInteractionHandler,
    });
    Object.assign(this, cleaned);
  }

  // ─── 对外 API（A5.1 契约）───

  /**
   * 预览任务——不切换 Focus，仅打开详情
   * 刷新 lastVisitedAt 防止衰老清理（A6.1b.5）   */
  async previewTask(taskId: string): Promise<boolean> {
    const task = this.taskStore.getTask(taskId);
    if (!task?.parkingMeta) return false;

    // 刷新 lastVisitedAt
    const persisted = await this.metaWriter.update(taskId, {
      ...task.parkingMeta,
      lastVisitedAt: new Date().toISOString(),
    });
    if (!persisted) return false;

    // At any moment only one previewing task.
    this.previewingTaskId.set(taskId);
    return true;
  }

  /**
   * 切换到目标任务——保存当前→切换→恢复上下文   * 对外唯一切换入口（A5.1.2）   */
  async startWork(taskId: string): Promise<boolean> {
    const targetTask = this.taskStore.getTask(taskId);
    if (!targetTask) {
      this.logger.warn('ParkingService', 'startWork: target task not found', { taskId });
      return false;
    }

    // 目标必须是 active 状态（A4 不变量）
    if (targetTask.status !== 'active') {
      this.logger.warn('ParkingService', 'startWork: 只能对 active 任务执行', { taskId, status: targetTask.status });
      return false;
    }

    const currentFocused = this.focusedTask();
    const undoSnapshots = this.undoRecorder.captureSnapshots([taskId, currentFocused?.id ?? null]);
    const now = new Date().toISOString();
    const updates = buildParkingStartWorkUpdates({ targetTask, currentFocused, now });

    const persisted = await this.taskOpsAdapter.updateTaskParkingMetaBatch(updates);
    if (!persisted) return false;

    if (currentFocused && currentFocused.id !== taskId) {
      void this.contextRestoreService.saveSnapshot(currentFocused.id);
    }

    // 3) Restore context snapshot for target task when available.
    if (targetTask.parkingMeta?.contextSnapshot) {
      this.contextRestoreService.restore(taskId, targetTask.parkingMeta.contextSnapshot);
    }

    // 4. 关闭预览
    this.previewingTaskId.set(null);

    // 5) Record undo action.
    this.undoRecorder.recordAction(undoSnapshots);
    return true;
  }

  /**
   * 从停泊列表移除——移回普通任务列表   * 5s 可撤回（A6.2b）   */
  async removeParkedTask(taskId: string): Promise<boolean> {
    const task = this.taskStore.getTask(taskId);
    if (!task?.parkingMeta) return false;

    const previousMeta = { ...task.parkingMeta };

    // 清除 parkingMeta
    const persisted = await this.metaWriter.clear(taskId);
    if (!persisted) return false;

    // Close preview if we were previewing this task.
    if (this.previewingTaskId() === taskId) {
      this.previewingTaskId.set(null);
    }

    // 5s 可撤回 Snackbar
    this.toastService.info(
      `「${task.title}」已移回任务列表`,
      undefined,
      {
        duration: PARKING_CONFIG.REMOVE_UNDO_TIMEOUT_MS,
        action: {
          label: '撤回',
          onClick: () => { void this.metaWriter.restore(taskId, previousMeta); },
        },
      }
    );
    return true;
  }

  /**
   * 撤回衰老清理（A5.1.4）   */
  async undoEviction(tokenId: string): Promise<boolean> {
    const token = this.evictionController.getToken(tokenId);
    if (!token) {
      this.logger.warn('ParkingService', 'undoEviction: token not found or expired', { tokenId });
      return false;
    }
    if (token.usedAt !== null) {
      this.logger.warn('ParkingService', 'undoEviction: token already used', { tokenId });
      return false;
    }

    const persisted = await this.metaWriter.restore(token.taskId, token.previousParkingMeta);
    if (!persisted) return false;

    this.evictionController.consumeToken(tokenId);
    return true;
  }

  /**
   * 停泊当前任务——用户主动将任务放入「稍后处理」
   */
  async parkTask(taskId: string): Promise<boolean> {
    const task = this.taskStore.getTask(taskId);
    if (!task || task.status !== 'active') return false;

    const now = new Date().toISOString();
    const meta: TaskParkingMeta = task.parkingMeta
      ? { ...task.parkingMeta, state: 'parked', parkedAt: now, lastVisitedAt: now }
      : {
        state: 'parked',
        parkedAt: now,
        lastVisitedAt: now,
        contextSnapshot: null,
        reminder: null,
        pinned: false,
      };

    const persisted = await this.metaWriter.update(taskId, meta);
    if (!persisted) {
      this.toastService.error('停泊失败', '任务停泊状态未能写入本地持久化队列，请释放浏览器存储空间后重试');
      return false;
    }

    // 停泊状态已持久化后再保存上下文快照和显示成功反馈。
    void this.contextRestoreService.saveSnapshot(taskId);
    // 全局统一视觉反馈
    this.toastService.success('已停泊', `「${task.title || '未命名任务'}」已移至稍后处理`);
    return true;
  }

  /**
   * 切换 pinned 状态（A6.4.7）
   */
  async togglePinned(taskId: string): Promise<boolean> {
    const task = this.taskStore.getTask(taskId);
    if (!task?.parkingMeta) return false;

    return await this.metaWriter.update(taskId, {
      ...task.parkingMeta,
      pinned: !task.parkingMeta.pinned,
    });
  }

  /**
   * 快速回切——切回最近停泊任务，跳过预览（A6.1.4）
   */
  quickSwitch(): Promise<boolean> {
    const parked = this.taskStore.parkedTasks();
    const mostRecent = parked.find(t => t.parkingMeta?.state === 'parked');
    if (mostRecent) {
      return this.startWork(mostRecent.id);
    }
    return Promise.resolve(false);
  }

  // ─── 停泊轻量增量同步（A3.4）───

  private async initParkedLightweightSync(): Promise<void> {
    if (this.parkedLightweightInitPromise) return this.parkedLightweightInitPromise;
    this.parkedLightweightInitPromise = this.doInitParkedLightweightSync();
    return this.parkedLightweightInitPromise;
  }

  private async doInitParkedLightweightSync(): Promise<void> {
    try {
      // 1) 先读缓存（冷启动快速可见）
      const cached = await this.projectDataService.loadParkedTasksCache();
      if (this.isDestroyed) return;
      this.parkedCursor = cached.cursor;
      for (const entry of cached.entries) {
        this.applyRemoteParkedEntry(entry.task, entry.projectId);
      }

      // 2) Pull one incremental delta in background.
      await this.syncParkedDelta();
      if (this.isDestroyed) return;

      // 3) 启动恢复时：优先使用 IDB 已恢复快照，降级读取草稿并清理草稿键
      this.snapshotPersistenceController.restoreSnapshotDraftFromLocalStorage();

      // 4) Start periodic incremental refresh.
      this.parkedDeltaTimer = setInterval(() => {
        this.syncParkedDeltaInBackground();
      }, ParkingService.PARKED_DELTA_SYNC_INTERVAL_MS);
    } catch (error: unknown) {
      // H-5 fix: 初始化失败时清除缓存的 Promise，允许后续重试
      this.parkedLightweightInitPromise = null;
      this.logger.warn('ParkingService', 'doInitParkedLightweightSync failed, will allow retry', error);
    }
  }

  private async syncParkedDelta(): Promise<void> {
    // M-24 fix: 离线时跳过增量拉取，避免不必要的网络错误
    if (this.isDestroyed) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    const ownerUserId = this.authService.currentUserId();
    if (!ownerUserId || isLocalModeEnabled()) return;
    this.resetParkedCursorOnOwnerChange(ownerUserId);
    if (isBrowserNetworkSuspendedWindow()) {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        this.scheduleParkedDeltaRefresh('network-suspended');
      }
      return;
    }
    // 后台标签页跳过周期拉取（与主轮询 paused 语义一致）：
    // 切回前台时 visibility 事件驱动的 scheduleParkedDeltaRefresh 会立即补拉。
    // 必须放在挂起窗口检查之后：isBrowserNetworkSuspendedWindow() 在隐藏期
    // 有惰性 arming 副作用，绕过它会让恢复补拉的宽限窗计算失真
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;

    const knownParkedTaskIds = Array.from(this.taskStore.parkedTaskIds());
    const knownProjectIds = this.getProjectIdsForParkedSync();
    if (knownProjectIds.length === 0) {
      this.logger.debug('ParkingService', '项目列表未就绪，跳过停泊任务增量同步');
      this.scheduleParkedDeltaProjectRetry();
      return;
    }

    const generation = ++this.parkedDeltaGeneration;
    const delta = await this.projectDataService.pullParkedTasksDelta(
      this.parkedCursor,
      knownParkedTaskIds,
      knownProjectIds,
    );

    if (
      this.isDestroyed ||
      generation !== this.parkedDeltaGeneration ||
      this.authService.currentUserId() !== ownerUserId
    ) {
      return;
    }

    if (delta.entries.length === 0 && delta.removedTaskIds.length === 0) {
      this.parkedCursor = delta.nextCursor ?? this.parkedCursor;
      return;
    }

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

    this.parkedCursor = delta.nextCursor ?? this.parkedCursor;

    await this.saveParkedDeltaCacheSnapshot();
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
      this.parkedCursor = null;
    }
    this.lastParkedSyncOwnerUserId = ownerUserId;
  }

  private async saveParkedDeltaCacheSnapshot(): Promise<void> {
    // 增量结果回写缓存（覆盖式，数据量小）
    const entries = buildParkedTaskCacheEntries(
      this.taskStore.parkedTasks(),
      (taskId) => this.findProjectId(taskId)
    );

    await this.projectDataService.saveParkedTasksCache({
      entries,
      cursor: this.parkedCursor,
    });
  }

  private getProjectIdsForParkedSync(): string[] {
    return getActiveParkingProjectIds(this.projectStore.projects());
  }

  private scheduleParkedDeltaRefresh(reason: 'visible' | 'online' | 'network-suspended'): void {
    if (this.parkedDeltaRecoveryTimer !== null) return;
    if (!this.canRunParkedDeltaRecovery()) return;

    const delayMs = Math.max(100, getRemainingBrowserNetworkResumeDelayMs() + 50);
    this.parkedDeltaRecoveryTimer = setTimeout(() => {
      this.parkedDeltaRecoveryTimer = null;
      if (!this.canRunParkedDeltaRecovery()) return;
      this.syncParkedDeltaInBackground();
    }, delayMs);

    this.logger.debug('ParkingService', '延后停泊任务增量同步以避开浏览器网络挂起窗口', {
      reason,
      delayMs,
    });
  }

  private scheduleParkedDeltaProjectRetry(): void {
    if (this.parkedDeltaRecoveryTimer !== null) return;
    if (!this.canRunParkedDeltaRecovery()) return;

    this.parkedDeltaRecoveryTimer = setTimeout(() => {
      this.parkedDeltaRecoveryTimer = null;
      if (!this.canRunParkedDeltaRecovery()) return;
      this.syncParkedDeltaInBackground();
    }, POLLING_CHECK_DELAY.CONDITION_READY);

    this.logger.debug('ParkingService', '项目列表未就绪，延后重试停泊任务增量同步', {
      delayMs: POLLING_CHECK_DELAY.CONDITION_READY,
    });
  }

  private canRunParkedDeltaRecovery(): boolean {
    if (this.isDestroyed) return false;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return false;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return false;
    return !!this.authService.currentUserId() && !isLocalModeEnabled();
  }

  private syncParkedDeltaInBackground(): void {
    void this.syncParkedDelta().catch((error: unknown) => {
      this.logger.warn(
        'ParkingService',
        'background parked delta sync failed',
        error,
      );
    });
  }

  private applyRemoteParkedEntry(task: Task, projectId: string): void {
    const local = this.taskStore.getTask(task.id);
    // C-3 fix: LWW 检查 — 本地版本更新时跳过远端覆盖
    if (!shouldApplyRemoteParkedTask(local, task)) {
      return;
    }

    this.taskStore.setTask(mergeRemoteParkedTask(local, task), projectId);
  }

  private applyRemoteParkingRemoval(removal: ParkedTaskRemoval): void {
    const task = this.taskStore.getTask(removal.taskId);
    if (!task?.parkingMeta) return;
    if (
      task.updatedAt &&
      removal.updatedAt &&
      task.updatedAt > removal.updatedAt
    ) {
      return;
    }

    const projectId = this.findProjectId(removal.taskId);
    if (!projectId) return;
    this.taskStore.setTask({ ...task, parkingMeta: undefined }, projectId);
  }

  // ─── 衰老清理（A6.4）───

  /**
   * 初始化衰老清理——延迟到 p1 就绪 + 首次交互后 3s（A5.1.6 / A6.4.5）   */
  initEviction(): void {
    if (this.evictionInitialized) return;
    this.evictionInitialized = true;

    const maxReadyChecks = 120;
    let readyChecks = 0;

    const checkReady = () => {
      readyChecks += 1;
      const tierReady = this.startupOrchestrator.isTierReady('p1');
      if (tierReady || readyChecks >= maxReadyChecks) {
        this.evictionReadyCheckTimer = null;
        this.armFirstInteractionForEviction();
      } else {
        this.evictionReadyCheckTimer = setTimeout(checkReady, POLLING_CHECK_DELAY.CONDITION_READY);
      }
    };
    checkReady();
  }
  private armFirstInteractionForEviction(): void {
    if (typeof document === 'undefined') return;
    if (this.firstInteractionHandler) return;

    this.firstInteractionHandler = () => {
      const firstInteractionHandler = this.firstInteractionHandler;
      if (!firstInteractionHandler) return;
      const listenersRemoved = cleanupParkingFirstInteractionListeners(
        firstInteractionHandler,
        {
          warn: (message, error) => this.logger.warn('ParkingService', message, error),
        },
      );
      if (listenersRemoved) {
        this.firstInteractionHandler = null;
      }

      this.scheduleEvictionStartup();
    };

    const listenersRegistered = setupParkingFirstInteractionListeners(
      this.firstInteractionHandler,
      {
        warn: (message, error) => this.logger.warn('ParkingService', message, error),
      },
    );
    if (!listenersRegistered) {
      this.firstInteractionHandler = null;
    }

    this.registerOnlineEvictionListener();

    // 首次交互监听器可能在用户早已完成首轮操作后才挂上；兜底启动避免整条清理链永远不上电。
    this.scheduleEvictionStartup();
  }

  private registerOnlineEvictionListener(): void {
    if (typeof window === 'undefined' || this.onlineListener) return;

    const onlineListener = () => { void this.runEvictionCheck(); };
    try {
      window.addEventListener('online', onlineListener);
      this.onlineListener = onlineListener;
    } catch (error: unknown) {
      this.warnLifecycleSetupFailure('online listener registration failed', error);
    }
  }

  private warnLifecycleSetupFailure(message: string, error: unknown): void {
    try {
      this.logger.warn('ParkingService', message, error);
    } catch {
      // Startup lifecycle diagnostics must not block eviction fallback scheduling.
    }
  }

  private scheduleEvictionStartup(): void {
    if (this.startupEvictionTimer !== null) return;
    this.startupEvictionTimer = setTimeout(() => {
      void this.runEvictionCheck();
      // After startup, switch to fixed interval checks.
      if (this.evictionIntervalTimer === null) {
        this.evictionIntervalTimer = setInterval(
          () => { void this.runEvictionCheck(); },
          ParkingService.EVICTION_CHECK_INTERVAL_MS
        );
      }
      this.startupEvictionTimer = null;
    }, PARKING_CONFIG.EVICTION_STARTUP_DELAY_MS);
  }

  /**
   * 执行衰老清理检查   */
  private async runEvictionCheck(): Promise<void> {
    if (!this.canRunEvictionNow()) return;

    this.evictionController.pruneExpiredTokens();

    const now = Date.now();
    const evictedItems: ParkingNoticeEvictionItem[] = [];

    for (const task of selectStaleParkingEvictionCandidates(
      this.taskStore.parkedTasks(),
      now,
      PARKING_CONFIG.PARKED_TASK_STALE_THRESHOLD,
    )) {
      const token = await this.evictTask(task);
      if (token) {
        evictedItems.push({
          taskId: token.taskId,
          taskTitle: token.taskTitle,
          evictionTokenId: token.tokenId,
        });
      }
    }

    if (evictedItems.length === 0) return;
    this.showNotice(this.evictionController.createNotice(evictedItems));
  }

  private canRunEvictionNow(): boolean {
    if (typeof navigator === 'undefined') return true;
    return navigator.onLine;
  }

  private async evictTask(task: Task): Promise<EvictionToken | null> {
    const previousParkingMeta = task.parkingMeta;
    if (!previousParkingMeta) return null;

    const persisted = await this.metaWriter.clear(task.id);
    if (!persisted) return null;

    return this.evictionController.createToken(task, previousParkingMeta);
  }

  /**
   * 获取单个清理 token（用于组件判断按钮状态）
   */
  getEvictionToken(tokenId: string): EvictionToken | null {
    return this.evictionController.getToken(tokenId);
  }

  /**
   * Gate 激活时驱逐通知延迟入队；关闭后由组件消费展示
   */
  showNotice(notice: ParkingNotice): void {
    this.noticeController.showNotice(notice, this.gateService.isActive());
  }

  /** H-6: Gate 关闭后刷出延迟的驱逐通知 */
  flushDeferredNotices(): void {
    this.noticeController.flushDeferredNotices();
  }

  // ─── 停泊任务被软删除联动（A5.1.5）───

  /**
   * 处理任务被软删除——从停泊列表移除
   * 由 TaskTrashService 在 deleteTask 内调用   */
  handleTaskSoftDelete(taskId: string): void {
    this.taskLifecycleController.handleTaskSoftDelete(taskId);
  }

  /**
   * 处理任务标记完成/归档——清除 parkingMeta（A3.9）   */
  handleTaskStatusChange(taskId: string, newStatus: string): void {
    this.taskLifecycleController.handleTaskStatusChange(taskId, newStatus);
  }

  // ─── 提醒红点（A5.3.5）───

  /**
   * 记录提醒通知被从底部淡出   */
  recordReminderFadeout(taskId: string): void {
    this.noticeController.recordReminderFadeout(taskId);
  }

  /**
   * 清除提醒红点
   */
  clearBadge(taskId: string): void {
    this.noticeController.clearBadge(taskId);
  }

  // ─── 轻量编辑（A6.1b.3）───

  /**
   * 在预览状态追加备注   * 以「\n---\n> 备注（停泊时）: {content}」格式追加到 content 末尾
   */
  addNote(taskId: string, noteContent: string): Promise<boolean> {
    return this.taskLifecycleController.addNote(taskId, noteContent);
  }

  // ─── SOFT_LIMIT 警告（A2.4 / P-21）───

  /** 是否超过软上限 */
  readonly isOverSoftLimit = computed(() =>
    isParkingOverSoftLimit(this.parkedCount(), PARKING_CONFIG.PARKED_TASK_SOFT_LIMIT)
  );

  // ─── 内部辅助 ───

  /**
   * 查找任务所属项目 ID
   */
  private findProjectId(taskId: string): string | null {
    return findParkingProjectId(
      taskId,
      (id) => this.taskStore.getTaskProjectId(id),
      () => this.projectStore.activeProjectId()
    );
  }

  /**
   * 消费并移除队首通知
   */
  consumeNotice(noticeId: string): void {
    this.noticeController.consumeNotice(noticeId);
  }

  /**
   * 保留停泊任务——重置 lastVisitedAt，清除即将清理状态（A6.4.2）   */
  keepParked(taskId: string): Promise<boolean> {
    return this.taskLifecycleController.keepParked(taskId);
  }

}
