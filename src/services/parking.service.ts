import { Injectable, Injector, inject, signal, computed, OnDestroy } from '@angular/core';
import { TaskStore, ProjectStore } from '../app/core/state/stores';
import {
  Task,
  Project,
  TaskParkingMeta,
  EvictionToken,
  ParkingNotice,
  ParkingNoticeEvictionItem,
} from '../models';
import { PARKING_CONFIG } from '../config/parking.config';
import { AUTH_CONFIG } from '../config/auth.config';
import { SYNC_CONFIG } from '../config/sync.config';
import { POLLING_CHECK_DELAY } from '../config/timeout.config';
import { ToastService } from './toast.service';
import { UndoService } from './undo.service';
import { LoggerService } from './logger.service';
import { SessionRuntimeResetRegistry } from './session-runtime-reset.service';
import { BeforeUnloadManagerService } from './before-unload-manager.service';
import { StartupTierOrchestratorService } from './startup-tier-orchestrator.service';
import { GateService } from './gate.service';
import { ContextRestoreService } from './context-restore.service';
import { AuthService } from './auth.service';
import { TaskOperationAdapterService } from './task-operation-adapter.service';
import { ProjectDataService } from '../core-bridge';
import {
  findParkingProjectId,
} from './parking-note.helpers';
import { ParkingNoticeController } from './parking-notice.controller';
import { ParkingEvictionController } from './parking-eviction.controller';
import { ParkingSnapshotPersistenceController } from './parking-snapshot-persistence.controller';
import { ParkingMetaWriterController } from './parking-meta-writer.controller';
import { ParkingDeltaSyncController } from './parking-delta-sync.controller';
import {
  cleanupParkingFirstInteractionListeners,
  cleanupParkingLifecycleHandles,
  setupParkingFirstInteractionListeners,
} from './parking-lifecycle-cleanup.helpers';
import { ParkingTaskLifecycleController } from './parking-task-lifecycle.controller';
import { initializeParkingStartupLifecycle } from './parking-startup-lifecycle.controller';
import { buildParkingStartWorkUpdates } from './parking-start-work.helpers';
import { ParkingUndoRecorderController } from './parking-undo-recorder.controller';
import { isLocalModeEnabled } from './guards/auth.guard';
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
  private readonly sessionRuntimeReset = inject(SessionRuntimeResetRegistry);

  private get taskOpsAdapter(): TaskOperationAdapterService {
    return this.injector.get(TaskOperationAdapterService);
  }

  private readonly noticeController = new ParkingNoticeController({
    reminderBadgeThreshold: PARKING_CONFIG.REMINDER_BADGE_THRESHOLD,
  });
  private readonly evictionController = new ParkingEvictionController({
    undoTimeoutMs: PARKING_CONFIG.EVICTION_UNDO_TIMEOUT_MS,
    noticeMinVisibleMs: PARKING_CONFIG.NOTICE_MIN_VISIBLE_MS,
    noticeFallbackTimeoutMs: PARKING_CONFIG.NOTICE_FALLBACK_TIMEOUT_MS,
  });
  private readonly evictionUndoInFlight = new Map<string, Promise<boolean>>();
  private evictionCheckInFlight: Promise<void> | null = null;
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
    currentOwnerUserId: () => this.getParkedCacheOwnerUserId(),
    saveParkedTasksCache: (ownerUserId, snapshot) =>
      this.projectDataService.saveParkedTasksCache(ownerUserId, snapshot),
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
  /** 停泊轻量增量同步（A3.4）委托给非 DI 控制器；游标与恢复 timer 字段仍在本服务 */
  private readonly deltaSyncController = new ParkingDeltaSyncController({
    logger: this.logger,
    isDestroyed: () => this.isDestroyed,
    currentUserId: () => this.authService.currentUserId(),
    knownParkedTaskIds: () => Array.from(this.taskStore.parkedTaskIds()),
    activeProjectIds: () => this.getProjectIdsForParkedSync(),
    pullParkedTasksDelta: (cursor, knownParkedTaskIds, knownProjectIds) =>
      this.projectDataService.pullParkedTasksDelta(cursor, knownParkedTaskIds, knownProjectIds),
    getTask: (taskId) => this.taskStore.getTask(taskId),
    setTask: (task, projectId) => this.taskStore.setTask(task, projectId),
    parkedTasks: () => this.taskStore.parkedTasks(),
    findProjectId: (taskId) => this.findProjectId(taskId),
    saveParkedTasksCache: (ownerUserId, snapshot, options) =>
      this.projectDataService.saveParkedTasksCache(ownerUserId, snapshot, options),
    getParkedCursor: () => this.parkedCursor,
    setParkedCursor: (cursor) => { this.parkedCursor = cursor; },
    getRecoveryTimer: () => this.parkedDeltaRecoveryTimer,
    setRecoveryTimer: (timer) => { this.parkedDeltaRecoveryTimer = timer; },
  });
  readonly pendingNotices = this.noticeController.pendingNotices;

  readonly previewingTaskId = signal<string | null>(null);

  private evictionInitialized = false;
  private parkedLightweightInitPromise: Promise<void> | null = null;
  private evictionIntervalTimer: ReturnType<typeof setInterval> | null = null;
  private parkedDeltaTimer: ReturnType<typeof setInterval> | null = null;
  private startupEvictionTimer: ReturnType<typeof setTimeout> | null = null;
  private parkedDeltaRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private evictionReadyCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private onlineListener: (() => void) | null = null;
  private parkedSyncOnlineListener: (() => void) | null = null;
  private visibilityChangeHandler: (() => void) | null = null;
  private firstInteractionHandler: (() => void) | null = null;
  private isDestroyed = false;
  private sessionGeneration = 0;
  private readonly unregisterSessionRuntimeReset: () => void;
  private parkedCursor: string | null = null;
  private static readonly EVICTION_CHECK_INTERVAL_MS = 60_000;
  /**
   * 停泊任务增量拉取周期：对齐主轮询活跃间隔（120s）。
   * 之前复用 60s 衰老巡检周期作为网络节拍，空闲时每小时 ~180 个请求，
   * 约为主轮询流量的 30 倍；可见性/在线事件驱动的 scheduleParkedDeltaRefresh
   * 负责状态变化时的即时补拉，周期拉取只是兜底。
   */
  private static readonly PARKED_DELTA_SYNC_INTERVAL_MS = SYNC_CONFIG.POLLING_ACTIVE_INTERVAL;

  readonly badgedTaskIds = this.noticeController.badgedTaskIds;

  /** 当前 focused 任务（同一时刻最多 1 个，A4 不变量） */
  readonly focusedTask = computed(() => findFocusedParkingTask(this.taskStore.parkedTasks()));

  /** 停泊任务数量 */
  readonly parkedCount = computed(() => this.taskStore.parkedTaskIds().size);

  /** 是否有即将到期的提醒（< 1h） */
  readonly hasUpcomingReminder = computed(() =>
    hasUpcomingParkingReminder(this.taskStore.parkedTasks(), Date.now(), 60 * 60 * 1000));

  constructor() {
    this.unregisterSessionRuntimeReset = this.sessionRuntimeReset.register(
      'ParkingService',
      () => this.resetSessionRuntime(),
    );

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
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    this.unregisterSessionRuntimeReset();
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

  /**
   * 预览任务——不切换 Focus，仅打开详情
   * 刷新 lastVisitedAt 防止衰老清理（A6.1b.5）   */
  async previewTask(taskId: string): Promise<boolean> {
    const generation = this.sessionGeneration;
    const task = this.taskStore.getTask(taskId);
    if (!task?.parkingMeta) return false;

    // 刷新 lastVisitedAt
    const persisted = await this.metaWriter.update(taskId, {
      ...task.parkingMeta,
      lastVisitedAt: new Date().toISOString(),
    });
    if (!this.isSessionGenerationCurrent(generation)) return false;
    if (!persisted) return false;

    // At any moment only one previewing task.
    this.previewingTaskId.set(taskId);
    return true;
  }

  /** 切换到目标任务——保存当前→切换→恢复上下文。 */
  startWork(taskId: string): Promise<boolean>;
  startWork(projectId: string, taskId: string): Promise<boolean>;
  async startWork(projectOrTaskId: string, explicitTaskId?: string): Promise<boolean> {
    const generation = this.sessionGeneration;
    const explicit = explicitTaskId !== undefined;
    const taskId = explicitTaskId ?? projectOrTaskId;
    const projectId = explicit ? projectOrTaskId : this.findProjectId(taskId);
    if (!projectId) return false;
    const targetTask = explicit ? this.getProjectTask(projectId, taskId) : this.taskStore.getTask(taskId);
    if (!targetTask) {
      this.logger.warn('ParkingService', 'startWork: target task not found', { taskId });
      return false;
    }
    if (targetTask.status !== 'active') {
      this.logger.warn('ParkingService', 'startWork: 只能对 active 任务执行', { taskId, status: targetTask.status });
      return false;
    }
    const currentFocused = this.focusedTask();
    const focusedProjectId = currentFocused ? this.taskStore.getTaskProjectId(currentFocused.id) ?? null : null;
    const projectIds = new Set([projectId, ...(focusedProjectId ? [focusedProjectId] : [])]);
    const undoSnapshots = explicit ? this.captureProjectSnapshots(projectIds)
      : this.undoRecorder.captureSnapshots([taskId, currentFocused?.id ?? null]);
    const updates = buildParkingStartWorkUpdates({ targetTask, currentFocused, now: new Date().toISOString() });
    const persisted = await this.persistStartWork(
      explicit, projectId, taskId, focusedProjectId, currentFocused, updates, undoSnapshots, generation);
    if (!persisted) return false;
    this.publishStartWorkUi(explicit, projectId, taskId, focusedProjectId, currentFocused, targetTask);
    return true;
  }

  /**
   * 从停泊列表移除——移回普通任务列表   * 5s 可撤回（A6.2b）   */
  async removeParkedTask(taskId: string): Promise<boolean> {
    const generation = this.sessionGeneration;
    const task = this.taskStore.getTask(taskId);
    if (!task?.parkingMeta) return false;

    const previousMeta = { ...task.parkingMeta };

    // 清除 parkingMeta
    const persisted = await this.metaWriter.clear(taskId);
    if (!this.isSessionGenerationCurrent(generation)) return false;
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
    const existingUndo = this.evictionUndoInFlight.get(tokenId);
    if (existingUndo) return existingUndo;

    const undoPromise = this.performUndoEviction(tokenId);
    this.evictionUndoInFlight.set(tokenId, undoPromise);
    try {
      return await undoPromise;
    } finally {
      if (this.evictionUndoInFlight.get(tokenId) === undoPromise) {
        this.evictionUndoInFlight.delete(tokenId);
      }
    }
  }

  private async performUndoEviction(tokenId: string): Promise<boolean> {
    const generation = this.sessionGeneration;
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
    if (!this.isSessionGenerationCurrent(generation)) return false;
    if (!persisted) return false;

    this.evictionController.consumeToken(tokenId);
    return true;
  }

  /**
   * 停泊当前任务——用户主动将任务放入「稍后处理」
   */
  async parkTask(taskId: string): Promise<boolean> {
    const generation = this.sessionGeneration;
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
    if (!this.isSessionGenerationCurrent(generation)) return false;
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
    const generation = this.sessionGeneration;
    const task = this.taskStore.getTask(taskId);
    if (!task?.parkingMeta) return false;

    const persisted = await this.metaWriter.update(taskId, {
      ...task.parkingMeta,
      pinned: !task.parkingMeta.pinned,
    });
    return this.isSessionGenerationCurrent(generation) && persisted;
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

  private async initParkedLightweightSync(): Promise<void> {
    if (this.parkedLightweightInitPromise) return this.parkedLightweightInitPromise;
    const operation = this.doInitParkedLightweightSync().catch((error: unknown) => {
      if (this.parkedLightweightInitPromise === operation) {
        this.parkedLightweightInitPromise = null;
      }
      this.logger.warn('ParkingService', 'doInitParkedLightweightSync failed, will allow retry', error);
    });
    this.parkedLightweightInitPromise = operation;
    return operation;
  }

  private async doInitParkedLightweightSync(): Promise<void> {
    const generation = this.sessionGeneration;
    // 1) 先读缓存（冷启动快速可见）
    const cacheOwnerUserId = this.getParkedCacheOwnerUserId();
    if (cacheOwnerUserId) {
      const cached = await this.projectDataService.loadParkedTasksCache(cacheOwnerUserId);
      if (!this.isSessionGenerationCurrent(generation)) return;
      if (this.getParkedCacheOwnerUserId() === cacheOwnerUserId) {
        this.deltaSyncController.restoreOwnerScopedCursor(cacheOwnerUserId, cached.cursor);
        for (const entry of cached.entries) {
          this.deltaSyncController.applyRemoteParkedEntry(entry.task, entry.projectId);
        }
      }
    }

    // 2) Pull one incremental delta in background.
    await this.syncParkedDelta();
    if (!this.isSessionGenerationCurrent(generation)) return;

    // 3) 启动恢复时：优先使用 IDB 已恢复快照，降级读取草稿并清理草稿键
    this.snapshotPersistenceController.restoreSnapshotDraftFromLocalStorage();

    // 4) Start periodic incremental refresh.
    if (this.parkedDeltaTimer === null) {
      this.parkedDeltaTimer = setInterval(() => {
        this.syncParkedDeltaInBackground();
      }, ParkingService.PARKED_DELTA_SYNC_INTERVAL_MS);
    }
  }

  private getParkedCacheOwnerUserId(): string | null {
    const authenticatedOwnerUserId = this.authService.currentUserId();
    if (authenticatedOwnerUserId) return authenticatedOwnerUserId;
    return isLocalModeEnabled() ? AUTH_CONFIG.LOCAL_MODE_USER_ID : null;
  }

  /** 增量同步逻辑委托给 deltaSyncController；保留同名私有委托兼容既有 spec 直调 */
  private syncParkedDelta(): Promise<void> {
    return this.deltaSyncController.syncParkedDelta();
  }

  private getProjectIdsForParkedSync(): string[] {
    return getActiveParkingProjectIds(this.projectStore.projects());
  }

  private scheduleParkedDeltaRefresh(reason: 'visible' | 'online' | 'network-suspended'): void {
    this.deltaSyncController.scheduleParkedDeltaRefresh(reason);
  }

  private scheduleParkedDeltaProjectRetry(): void {
    this.deltaSyncController.scheduleParkedDeltaProjectRetry();
  }

  private syncParkedDeltaInBackground(): void {
    this.deltaSyncController.syncParkedDeltaInBackground();
  }

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
  private runEvictionCheck(): Promise<void> {
    if (this.evictionCheckInFlight) {
      return this.evictionCheckInFlight;
    }
    if (!this.canRunEvictionNow()) {
      return Promise.resolve();
    }

    const operation = this.performEvictionCheck().finally(() => {
      if (this.evictionCheckInFlight === operation) {
        this.evictionCheckInFlight = null;
      }
    });
    this.evictionCheckInFlight = operation;
    return operation;
  }

  private async performEvictionCheck(): Promise<void> {
    const generation = this.sessionGeneration;
    this.evictionController.pruneExpiredTokens();

    const now = Date.now();
    const evictedItems: ParkingNoticeEvictionItem[] = [];

    for (const task of selectStaleParkingEvictionCandidates(
      this.taskStore.parkedTasks(),
      now,
      PARKING_CONFIG.PARKED_TASK_STALE_THRESHOLD,
    )) {
      if (!this.isSessionGenerationCurrent(generation)) return;
      const token = await this.evictTask(task, generation);
      if (!this.isSessionGenerationCurrent(generation)) return;
      if (token) {
        evictedItems.push({
          taskId: token.taskId,
          taskTitle: token.taskTitle,
          evictionTokenId: token.tokenId,
        });
      }
    }

    if (evictedItems.length === 0 || !this.isSessionGenerationCurrent(generation)) return;
    this.showNotice(this.evictionController.createNotice(evictedItems));
  }

  private canRunEvictionNow(): boolean {
    if (typeof navigator === 'undefined') return true;
    return navigator.onLine;
  }

  private async evictTask(task: Task, generation = this.sessionGeneration): Promise<EvictionToken | null> {
    const previousParkingMeta = task.parkingMeta;
    if (!previousParkingMeta) return null;

    const persisted = await this.metaWriter.clear(task.id);
    if (!this.isSessionGenerationCurrent(generation)) return null;
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

  /**
   * 记录提醒通知被从底部淡出   */
  recordReminderFadeout(taskId: string): void {
    this.noticeController.recordReminderFadeout(taskId);
  }

  /** 清除提醒红点。 */
  clearBadge(taskId: string): void {
    this.noticeController.clearBadge(taskId);
  }
  /** 在预览状态追加备注。 */
  addNote(taskId: string, noteContent: string): Promise<boolean> {
    return this.taskLifecycleController.addNote(taskId, noteContent);
  }
  /** 是否超过软上限 */
  readonly isOverSoftLimit = computed(() =>
    isParkingOverSoftLimit(this.parkedCount(), PARKING_CONFIG.PARKED_TASK_SOFT_LIMIT)
  );
  /** 查找任务所属项目 ID。 */
  private findProjectId(taskId: string): string | null {
    return findParkingProjectId(
      taskId,
      (id) => this.taskStore.getTaskProjectId(id),
      () => this.projectStore.activeProjectId()
    );
  }

  private getProjectTask(projectId: string, taskId: string): Task | undefined {
    return this.projectStore.getProject(projectId)?.tasks.find(task => task.id === taskId);
  }

  private async persistStartWorkGroups(
    projectId: string, taskId: string, focusedProjectId: string | null, currentFocused: Task | null,
    updates: ReturnType<typeof buildParkingStartWorkUpdates>, undoSnapshots: Map<string, Partial<Project>>,
    generation: number,
  ): Promise<boolean> {
    const demotionProjectId = focusedProjectId !== projectId ? focusedProjectId : null;
    if (demotionProjectId && currentFocused?.id === taskId && currentFocused.parkingMeta) {
      const lastVisitedAt = updates[updates.length - 1]!.parkingMeta.lastVisitedAt;
      updates.unshift({ taskId, parkingMeta: {
        ...currentFocused.parkingMeta, state: 'parked', parkedAt: lastVisitedAt, lastVisitedAt,
      } });
    }
    const groups: Array<[string, typeof updates]> = demotionProjectId
      ? [[demotionProjectId, updates.slice(0, -1)], [projectId, updates.slice(-1)]]
      : [[projectId, updates]];
    for (const [groupProjectId, groupUpdates] of groups) {
      const persisted = await this.taskOpsAdapter.updateTaskParkingMetaBatch(groupProjectId, groupUpdates);
      if (!persisted || !this.isSessionGenerationCurrent(generation)) return false;
      if (groupUpdates.some(update => !this.getProjectTask(groupProjectId, update.taskId))) return false;
      const before = undoSnapshots.get(groupProjectId);
      if (before) this.undoRecorder.recordAction(new Map([[groupProjectId, before]]));
    }
    return true;
  }

  private async persistStartWork(
    explicit: boolean, projectId: string, taskId: string, focusedProjectId: string | null, currentFocused: Task | null,
    updates: ReturnType<typeof buildParkingStartWorkUpdates>, undoSnapshots: Map<string, Partial<Project>>, generation: number,
  ): Promise<boolean> {
    if (explicit) return this.persistStartWorkGroups(
      projectId, taskId, focusedProjectId, currentFocused, updates, undoSnapshots, generation);
    const persisted = await this.taskOpsAdapter.updateTaskParkingMetaBatch(updates);
    if (!persisted || !this.isSessionGenerationCurrent(generation)) return false;
    this.undoRecorder.recordAction(undoSnapshots);
    return true;
  }

  private publishStartWorkUi(
    explicit: boolean, projectId: string, taskId: string, focusedProjectId: string | null, currentFocused: Task | null,
    targetTask: Task,
  ): void {
    if (currentFocused && (focusedProjectId !== projectId || currentFocused.id !== taskId)) {
      if (explicit && focusedProjectId) void this.contextRestoreService.saveSnapshot(focusedProjectId, currentFocused.id);
      else void this.contextRestoreService.saveSnapshot(currentFocused.id);
    }
    const snapshot = targetTask.parkingMeta?.contextSnapshot;
    if (snapshot && explicit) this.contextRestoreService.restore(projectId, taskId, snapshot);
    else if (snapshot) this.contextRestoreService.restore(taskId, snapshot);
    this.previewingTaskId.set(null);
  }

  private captureProjectSnapshots(projectIds: ReadonlySet<string>): Map<string, Partial<Project>> {
    const snapshots = new Map<string, Partial<Project>>();
    for (const projectId of projectIds) {
      const project = this.projectStore.getProject(projectId);
      if (project) snapshots.set(projectId, this.undoService.createProjectSnapshot(project));
    }
    return snapshots;
  }

  /** 消费并移除队首通知。 */
  consumeNotice(noticeId: string): void {
    this.noticeController.consumeNotice(noticeId);
  }

  /** 保留停泊任务，刷新 lastVisitedAt。 */
  keepParked(taskId: string): Promise<boolean> {
    return this.taskLifecycleController.keepParked(taskId);
  }

  private resetSessionRuntime(): void {
    this.sessionGeneration += 1;
    this.previewingTaskId.set(null);
    this.noticeController.resetSession();
    this.evictionController.resetSession();
    this.evictionUndoInFlight.clear();
    this.evictionCheckInFlight = null;
    this.deltaSyncController.resetSession();
    this.parkedCursor = null;
    this.parkedLightweightInitPromise = null;
    this.snapshotPersistenceController.discardSnapshotDraft();

    if (this.parkedDeltaTimer !== null) {
      clearInterval(this.parkedDeltaTimer);
      this.parkedDeltaTimer = null;
    }
    if (this.parkedDeltaRecoveryTimer !== null) {
      clearTimeout(this.parkedDeltaRecoveryTimer);
      this.parkedDeltaRecoveryTimer = null;
    }

    const generation = this.sessionGeneration;
    Promise.resolve().then(() => {
      if (!this.isSessionGenerationCurrent(generation)) return;
      void this.initParkedLightweightSync();
    });
  }

  private isSessionGenerationCurrent(generation: number): boolean {
    return !this.isDestroyed && generation === this.sessionGeneration;
  }

}
