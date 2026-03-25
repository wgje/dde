import { Component, ChangeDetectionStrategy, inject, signal, HostListener, computed, OnInit, OnDestroy, DestroyRef, effect, Type, Injector, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, NavigationEnd, RouterOutlet } from '@angular/router';
import { UiStateService } from './services/ui-state.service';
import { ProjectStateService } from './services/project-state.service';
import { TaskOperationAdapterService } from './services/task-operation-adapter.service';
import { PreferenceService } from './services/preference.service';
import { UserSessionService } from './services/user-session.service';
import { ProjectOperationService } from './services/project-operation.service';
import { UndoService } from './services/undo.service';
import { ToastService } from './services/toast.service';
import { ActionQueueService } from './services/action-queue.service';
import { LoggerService } from './services/logger.service';
import { GlobalErrorHandler } from './services/global-error-handler.service';
import { ModalService, type DeleteProjectData, type LoginData } from './services/modal.service';
import { WorkspaceModalCoordinatorService } from './services/workspace-modal-coordinator.service';
import { SyncCoordinatorService } from './services/sync-coordinator.service';
import { SupabaseClientService } from './services/supabase-client.service';
import { SimpleSyncService } from './app/core/services/simple-sync.service';
import { SearchService } from './services/search.service';
import { ParkingService } from './services/parking.service';
import { BlackBoxService } from './services/black-box.service';
import { FocusPreferenceService } from './services/focus-preference.service';
import { BeforeUnloadManagerService } from './services/before-unload-manager.service';
import { BeforeUnloadGuardService } from './services/guards';
import { AppAuthCoordinatorService } from './app/core/services/app-auth-coordinator.service';
import { AppProjectCoordinatorService } from './app/core/services/app-project-coordinator.service';
import { ToastContainerComponent } from './app/shared/components/toast-container.component';
import { SyncStatusComponent } from './app/shared/components/sync-status.component';
import { OfflineBannerComponent } from './app/shared/components/offline-banner.component';
import { DemoBannerComponent } from './app/shared/components/demo-banner.component';
import { WorkspaceShellCoreComponent } from './app/core/shell/workspace-shell-core.component';
import { WorkspaceSidebarComponent } from './app/core/shell/workspace-sidebar.component';
import { WorkspaceOverlaysComponent } from './app/core/shell/workspace-overlays.component';
import type { StorageEscapeData } from './app/shared/modals';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs/operators';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ThemeType, Project } from './models';
import { UI_CONFIG } from './config/ui.config';
import { FEATURE_FLAGS, validateCriticalFlags } from './config/feature-flags.config';
import { FocusModeComponent } from './app/features/focus/focus-mode.component';
import { showBlackBoxPanel, gateState } from './state/focus-stores';
import { SpotlightService } from './services/spotlight.service';
import { shouldAutoCloseSidebarOnViewportChange } from './utils/layout-stability';
import { ExportService } from './services/export.service';
import { AppLifecycleOrchestratorService } from './services/app-lifecycle-orchestrator.service';
import { PwaInstallPromptService } from './services/pwa-install-prompt.service';
import { FocusStartupProbeService } from './services/focus-startup-probe.service';
import { SentryLazyLoaderService } from './services/sentry-lazy-loader.service';
import { StartupTierOrchestratorService } from './services/startup-tier-orchestrator.service';
import { BootStageService } from './services/boot-stage.service';
import { LaunchSnapshotService } from './services/launch-snapshot.service';
import { TaskStore } from './services/stores';
import { DockEngineService } from './services/dock-engine.service';
import { reloadViaForceClearCache } from './utils/force-clear-cache';
import {
  resolveDockFocusChromeLayoutLocked,
  type DockFocusChromePhase,
} from './utils/dock-focus-phase';

function readTextInputValue(event: Event | string): string {
  if (typeof event === 'string') return event;
  const target = event.target as { value?: unknown } | null;
  return typeof target?.value === 'string' ? target.value : '';
}

type RemoteChangeHandlerLike = {
  setupCallbacks: (callbacks: {
    onLoadProjects?: () => Promise<void>;
    onRefreshActiveProject?: (reason: string) => Promise<void>;
  }) => void;
};

type EventDrivenSyncPulseLike = {
  initialize: () => void;
  destroy: () => void;
  triggerNow: (reason: 'focus-entry' | 'manual' | 'focus' | 'visible' | 'pageshow' | 'online' | 'heartbeat') => Promise<void>;
};

type StartupDiagnosticsLike = {
  initialize: () => Promise<void> | void;
};

/**
 * 应用根组件
 * 
 * 认证逻辑委托到 AppAuthCoordinatorService
 */
@Component({
  selector: 'app-workspace-shell',
  standalone: true,
  imports: [
    CommonModule,
    RouterOutlet,
    ToastContainerComponent,
    SyncStatusComponent,
    OfflineBannerComponent,
    DemoBannerComponent,
    WorkspaceShellCoreComponent,
    WorkspaceSidebarComponent,
    WorkspaceOverlaysComponent,
    // Focus 覆盖层仍走模板 defer
    FocusModeComponent,
  ],
  templateUrl: './workspace-shell.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})

export class WorkspaceShellComponent implements OnInit, OnDestroy, AfterViewInit {
  
  public throwTestError(): void {
    throw new Error("Sentry Test Error");
  }

  private readonly logger = inject(LoggerService).category('App');
  private readonly injector = inject(Injector);
  private readonly uiState = inject(UiStateService);

  private readonly projectState = inject(ProjectStateService);
  private readonly taskStore = inject(TaskStore);
  private readonly taskOpsAdapter = inject(TaskOperationAdapterService);
  private readonly preferenceService = inject(PreferenceService);
  private readonly userSession = inject(UserSessionService);
  private readonly projectOps = inject(ProjectOperationService);
  private readonly spotlightService = inject(SpotlightService);

  // ========== 延迟注入服务（P0-3 性能优化 2026-03-24）==========
  // 以下服务不在首屏渲染路径上，改为按需获取以减少 DI 树展开耗时
  private _searchService?: SearchService;
  private get searchService(): SearchService {
    return (this._searchService ??= this.injector.get(SearchService));
  }
  private _parkingService?: ParkingService;
  private get parkingService(): ParkingService {
    return (this._parkingService ??= this.injector.get(ParkingService));
  }
  private _blackBoxService?: BlackBoxService;
  private get blackBoxService(): BlackBoxService {
    return (this._blackBoxService ??= this.injector.get(BlackBoxService));
  }
  private _exportService?: ExportService;
  private get exportService(): ExportService {
    return (this._exportService ??= this.injector.get(ExportService));
  }
  private _focusStartupProbe?: FocusStartupProbeService;
  private get focusStartupProbe(): FocusStartupProbeService {
    return (this._focusStartupProbe ??= this.injector.get(FocusStartupProbeService));
  }
  private _simpleSync?: SimpleSyncService;
  private get simpleSync(): SimpleSyncService {
    return (this._simpleSync ??= this.injector.get(SimpleSyncService));
  }
  readonly focusPrefs = inject(FocusPreferenceService);
  readonly pwaInstall = inject(PwaInstallPromptService);

  /** 认证协调器 — 管理所有认证相关状态和操作 */
  readonly authCoord = inject(AppAuthCoordinatorService);
  /** 项目 UI 协调器 — 管理项目列表 UI 状态和操作 */
  readonly projectCoord = inject(AppProjectCoordinatorService);

  // ========== 模板所需的公共 getter（暴露给 HTML 模板）==========
  
  /** UI 状态 */
  get isMobile() { return this.uiState.isMobile; }
  get sidebarWidth() { return this.uiState.sidebarWidth; }
  
  /** 项目/任务数据 */
  get projects() { return this.projectState.projects; }
  get activeProject() { return this.projectState.activeProject; }
  // 直接暴露 signal，而不是 getter - 模板中需要调用 activeProjectId()
  readonly activeProjectId = this.projectState.activeProjectId;
  get deletedTasks() { return this.projectState.deletedTasks; }
  get currentUserId() { return this.userSession.currentUserId; }
  
  /** 同步状态 */
  get offlineMode() { return this.syncCoordinator.offlineMode; }
  get sessionExpired() { return this.syncCoordinator.sessionExpired; }
  
  /** 搜索结果 */
  get searchResults() { return this.searchService.searchResults; }
  get filteredProjects() { return this.searchService.filteredProjects; }
  
  /** 辅助方法 */
  compressDisplayId(displayId: string): string {
    return this.projectState.compressDisplayId(displayId);
  }
  
  setActiveProjectId(id: string | null): void {
    this.projectState.setActiveProjectId(id);
  }
  private readonly undoService = inject(UndoService);
  private readonly swUpdate = inject(SwUpdate);
  private readonly toast = inject(ToastService);
  private readonly actionQueue = inject(ActionQueueService);
  private readonly errorHandler = inject(GlobalErrorHandler);
  private readonly modal = inject(ModalService);
  readonly modalCoord = inject(WorkspaceModalCoordinatorService);
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  readonly supabaseClient = inject(SupabaseClientService);
  private readonly beforeUnloadManager = inject(BeforeUnloadManagerService);
  private readonly beforeUnloadGuard = inject(BeforeUnloadGuardService);
  
  /** 数据保护服务（延迟注入，见上方 getter） */
  private readonly appLifecycle = inject(AppLifecycleOrchestratorService);
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly startupTier = inject(StartupTierOrchestratorService);
  readonly bootStage = inject(BootStageService);
  private readonly launchSnapshot = inject(LaunchSnapshotService);
  
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  /** 代理 UiStateService.sidebarOpen，所有 .set()/.update() 调用均作用于服务层信号 */
  get isSidebarOpen() { return this.uiState.sidebarOpen; }
  isFilterOpen = signal(false);
  readonly spotlightTriggerComponent = signal<Type<unknown> | null>(null);
  readonly blackBoxRecorderComponent = signal<Type<unknown> | null>(null);
  readonly blackBoxRecorderOutletInputs = {
    appearance: 'obsidian' as const,
    onTranscribed: (text: string) => this.onSidebarVoiceTranscribed(text),
  };

  private spotlightTriggerLoadPromise: Promise<Type<unknown> | null> | null = null;
  private blackBoxRecorderLoadPromise: Promise<Type<unknown> | null> | null = null;
  private focusModePreloadPromise: Promise<void> | null = null;
  private startupFontSchedulerInitPromise: Promise<void> | null = null;
  private focusModePreloadScheduled = false;

  /**
   * 核心数据是否已加载完毕
   *
   * 【性能优化 2026-02-14】用于 FocusMode @defer 条件守卫
   * 首屏核心数据加载完成后才触发 FocusMode 及其 BlackBox 同步
   * 避免登录后前 5-10s 并发请求峰值
   */
  readonly coreDataLoaded = computed(() => {
    // 会话检查完成（无论成功或失败）
    const sessionCheckDone = !this.authCoord.isCheckingSession();
    // 用户已认证（有 userId）
    const hasUser = !!this.currentUserId();
    // 不在认证加载中
    const notAuthLoading = !this.authCoord.isAuthLoading();
    return sessionCheckDone && hasUser && notAuthLoading;
  });

  private readonly dockEngine = inject(DockEngineService);
  /** 专注虚化激活：专注模式开启且虚化开关打开时，对背景内容施加模糊 */
  readonly focusBlurActive = computed(
    () => this.dockEngine.focusMode() && this.dockEngine.focusScrimOn(),
  );
  /**
   * 专注接管激活：进入/退出专注的整个接管窗口内，
   * 工作区外层 chrome（侧边栏、分隔条）统一退场。
   *
   * 根因：
   * - 左侧项目栏曾单独做 filter blur，右侧项目内容又走另一套 blur；
   * - 两个 stacking context 叠在一起，导致左侧虚影类型、透明度、高度都与右侧不一致；
   * - HUD 拖到左侧时，会被更外层的 sidebar blur 面盖住。
   *
   * 处理：外层 chrome 不再单独 blur，而是在接管期直接收起并禁用交互，
   * 让右侧 ProjectShell 的统一 focus content effect 成为唯一背景层。
   */
  readonly focusWorkspaceTakeoverActive = computed(() => this.resolveFocusWorkspaceTakeoverActive());
  readonly focusWorkspaceTakeoverPhase = computed(() => this.resolveFocusWorkspaceTakeoverPhase());
  readonly workspaceSidebarWidthPx = computed(() => this.resolveWorkspaceSidebarWidth());
  readonly mobileSidebarBackdropVisible = computed(
    () => this.uiState.isMobile() && this.uiState.sidebarOpen() && !this.focusWorkspaceTakeoverActive(),
  );
  readonly workspaceSidebarOpacity = computed(() => this.resolveWorkspaceSidebarOpacity());
  readonly workspaceSidebarTransform = computed(() => this.resolveWorkspaceSidebarTransform());
  readonly workspaceSidebarPointerEvents = computed(() => this.resolveWorkspaceSidebarPointerEvents());
  readonly workspaceSidebarTransition = computed(() => this.resolveWorkspaceSidebarTransition());
  readonly workspaceSidebarContentOpacity = computed(() => this.resolveWorkspaceSidebarContentOpacity());
  readonly workspaceSidebarContentTransform = computed(() => this.resolveWorkspaceSidebarContentTransform());
  readonly workspaceSidebarContentTransition = computed(() => this.resolveWorkspaceSidebarContentTransition());

  private resolveFocusWorkspaceTakeoverActive(): boolean {
    return this.resolveFocusWorkspaceTakeoverPhase() !== 'idle';
  }

  private resolveFocusWorkspaceTakeoverPhase(): DockFocusChromePhase {
    return this.dockEngine.focusChromePhase();
  }

  private resolveWorkspaceSidebarWidth(): number {
    if (this.uiState.isMobile()) return 240;
    if (!this.uiState.sidebarOpen()) return 0;
    return this.uiState.sidebarWidth();
  }

  private resolveWorkspaceSidebarOpacity(): string {
    const phase = this.resolveFocusWorkspaceTakeoverPhase();
    if (phase === 'entering' || phase === 'focused') return '0';
    if (phase === 'exiting') return this.uiState.isMobile() ? '0' : '1';
    return '1';
  }

  private resolveWorkspaceSidebarTransform(): string {
    const isMobile = this.uiState.isMobile();
    const phase = this.resolveFocusWorkspaceTakeoverPhase();
    if (resolveDockFocusChromeLayoutLocked(phase)) {
      if (phase === 'restoring') {
        return isMobile ? 'translateX(calc(-100% - 12px))' : 'translateX(0) scale(1)';
      }
      if (phase === 'exiting') {
        return isMobile ? 'translateX(calc(-100% - 12px))' : 'translateX(0) scale(1)';
      }
      return isMobile ? 'translateX(calc(-100% - 12px))' : 'translateX(-8px) scale(0.992)';
    }
    if (isMobile) {
      return this.uiState.sidebarOpen() ? 'translateX(0)' : 'translateX(calc(-100% - 12px))';
    }
    return 'translateX(0) scale(1)';
  }

  private resolveWorkspaceSidebarPointerEvents(): 'none' | 'auto' {
    if (this.resolveFocusWorkspaceTakeoverPhase() !== 'idle') return 'none';
    if (this.uiState.isMobile() && !this.uiState.sidebarOpen()) return 'none';
    return 'auto';
  }

  private resolveWorkspaceSidebarTransition(): string {
    const phase = this.resolveFocusWorkspaceTakeoverPhase();
    if (this.uiState.isMobile()) {
      // 移动端：使用完整的 smooth-restore 时长
      return 'opacity var(--pk-shell-smooth-restore) var(--pk-ease-standard),'
        + ' transform var(--pk-shell-smooth-restore) var(--pk-ease-restore)';
    }
    if (phase === 'restoring') {
      // 恢复阶段：宽度先恢复（使用 snappy 曲线防止弹出感），opacity/transform 跟随
      // 宽度用稍短时长+ snappy 曲线，避免「慢慢打开」的疲惫感
      return 'width var(--pk-shell-smooth-restore) var(--pk-ease-restore-snappy),'
        + ' opacity var(--pk-shell-smooth-restore) var(--pk-ease-restore),'
        + ' transform var(--pk-shell-smooth-restore) var(--pk-ease-restore)';
    }
    if (phase === 'exiting') {
      // 退出阶段：快速收起（入场时长但用 standard 曲线，感觉更利落）
      return 'width var(--pk-shell-enter) var(--pk-ease-standard),'
        + ' opacity var(--pk-shell-enter) var(--pk-ease-standard),'
        + ' transform var(--pk-shell-enter) var(--pk-ease-standard)';
    }
    // entering / focused / idle：入场时快速隐藏侧边栏，exit 时用 overlay-exit 给予短促退场感
    return 'width var(--pk-shell-enter) var(--pk-ease-standard),'
      + ' opacity var(--pk-overlay-exit) var(--pk-ease-exit),'
      + ' transform var(--pk-shell-enter) var(--pk-ease-enter)';
  }

  private resolveWorkspaceSidebarContentOpacity(): string {
    const phase = this.resolveFocusWorkspaceTakeoverPhase();
    if (phase === 'entering' || phase === 'focused') return '0';
    if (phase === 'exiting') return this.uiState.isMobile() ? '0' : '1';
    return '1';
  }

  private resolveWorkspaceSidebarContentTransform(): string {
    const phase = this.resolveFocusWorkspaceTakeoverPhase();
    if (phase === 'entering' || phase === 'focused') {
      return this.uiState.isMobile() ? 'translateX(-8px)' : 'translateX(-8px)';
    }
    if (phase === 'exiting') {
      return this.uiState.isMobile() ? 'translateX(-4px)' : 'translateX(0)';
    }
    if (phase === 'restoring') {
      return 'translateX(0)';
    }
    return 'translateX(0)';
  }

  private resolveWorkspaceSidebarContentTransition(): string {
    if (this.uiState.isMobile()) {
      return 'opacity var(--pk-shell-smooth-restore) var(--pk-ease-restore),'
        + ' transform var(--pk-shell-smooth-restore) var(--pk-ease-restore)';
    }

    const phase = this.resolveFocusWorkspaceTakeoverPhase();
    if (phase === 'restoring') {
      // content 延迟 120ms 显示：让侧边栏宽度先展开，再显示文字内容，避免文字在窄宽度下挤压
      return 'opacity var(--pk-shell-smooth-restore) var(--pk-ease-restore) 120ms,'
        + ' transform var(--pk-shell-smooth-restore) var(--pk-ease-restore)';
    }

    return 'opacity var(--pk-overlay-exit) var(--pk-ease-standard),'
      + ' transform var(--pk-shell-exit) var(--pk-ease-standard)';
  }

  /** FocusMode 用户明确交互信号（点击/按键后激活） */
  readonly focusModeIntentActivated = signal(!FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1);
  /** FocusMode 挂载条件：探针命中待处理 gate 或用户交互 或 dev 强制显示 */
  readonly shouldMountFocusMode = computed(() => {
    // 开发测试强制显示大门时，gateState 会直接设为 'reviewing'，绕过 coreDataLoaded 检查
    if (gateState() === 'reviewing') return true;
    if (!this.coreDataLoaded()) return false;
    if (!FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1) return true;
    return this.focusStartupProbe.hasPendingGateWork() || this.focusModeIntentActivated();
  });
  readonly shouldMountDeferredSyncStatus = computed(() => {
    if (!FEATURE_FLAGS.SYNC_STATUS_DEFERRED_MOUNT_V1) {
      return true;
    }

    // 会话检查完成后直接挂载同步状态（SyncStatusComponent 无副作用，安全挂载）
    const sessionCheckDone = !this.authCoord.isCheckingSession();
    if (sessionCheckDone) {
      return true;
    }

    // 会话检查进行中时，若有同步异常或 p2 层已就绪也提前挂载
    const hasSyncIssue =
      this.syncCoordinator.pendingActionsCount() > 0 ||
      this.syncCoordinator.offlineMode() ||
      !this.syncCoordinator.isOnline() ||
      !!this.syncCoordinator.syncError();

    return this.startupTier.isTierReady('p2') || hasSyncIssue;
  });
  
  /** 模态框加载中状态（委托到 modalCoord） */
  readonly modalLoading = this.modalCoord.modalLoading;

  /** 检查指定类型的模态框是否正在加载 */
  isModalLoading(type: string): boolean {
    return this.modalCoord.isModalLoading(type);
  }

  /** 存储失败逃生数据（委托到 modalCoord） */
  get storageEscapeData() { return this.modalCoord.storageEscapeData; }
  get showStorageEscapeModal() { return this.modalCoord.showStorageEscapeModal; }
  
  // 手机端滑动切换状态
  private touchStartX = 0;
  private touchStartY = 0;
  private isSwiping = false;
  
  // 侧边栏滑动状态
  private sidebarTouchStartX = 0;
  private sidebarTouchStartY = 0;
  private isSidebarSwiping = false;
  
  // 侧边栏滑动手势处理
  onSidebarTouchStart(e: TouchEvent) {
    if (!this.uiState.isMobile()) return;
    if (e.touches.length !== 1) return;
    
    this.sidebarTouchStartX = e.touches[0].clientX;
    this.sidebarTouchStartY = e.touches[0].clientY;
    this.isSidebarSwiping = false;
  }
  
  onSidebarTouchMove(e: TouchEvent) {
    if (!this.uiState.isMobile()) return;
    if (e.touches.length !== 1) return;
    
    const deltaX = e.touches[0].clientX - this.sidebarTouchStartX;
    const deltaY = Math.abs(e.touches[0].clientY - this.sidebarTouchStartY);
    
    // 向左滑动且水平距离大于垂直距离（使用配置常量）
    if (deltaX < -UI_CONFIG.GESTURE_MIN_DISTANCE && Math.abs(deltaX) > deltaY * UI_CONFIG.GESTURE_DIRECTION_RATIO) {
      this.isSidebarSwiping = true;
    }
  }
  
  onSidebarTouchEnd(e: TouchEvent) {
    if (!this.uiState.isMobile()) return;
    if (!this.isSidebarSwiping) return;
    
    const deltaX = e.changedTouches[0].clientX - this.sidebarTouchStartX;
    const threshold = 50; // 滑动阈值（从60减小到50）
    
    // 向左滑动关闭侧边栏
    if (deltaX < -threshold) {
      this.isSidebarOpen.set(false);
    }
    
    this.isSidebarSwiping = false;
  }
  
  // 手机端滑动手势处理
  onMainTouchStart(e: TouchEvent) {
    if (!this.uiState.isMobile()) return;
    if (e.touches.length !== 1) return;
    
    this.touchStartX = e.touches[0].clientX;
    this.touchStartY = e.touches[0].clientY;
    this.isSwiping = false;
  }
  
  onMainTouchMove(e: TouchEvent) {
    if (!this.uiState.isMobile()) return;
    if (e.touches.length !== 1) return;
    
    const deltaX = e.touches[0].clientX - this.touchStartX;
    const deltaY = Math.abs(e.touches[0].clientY - this.touchStartY);
    
    // 只有水平滑动距离大于垂直滑动时才认为是切换手势（使用配置常量）
    if (Math.abs(deltaX) > UI_CONFIG.GESTURE_MIN_DISTANCE && Math.abs(deltaX) > deltaY * UI_CONFIG.GESTURE_DIRECTION_RATIO) {
      this.isSwiping = true;
    }
  }
  
  onMainTouchEnd(e: TouchEvent) {
    if (!this.uiState.isMobile()) return;
    if (!this.isSwiping) return;
    
    const deltaX = e.changedTouches[0].clientX - this.touchStartX;
    const threshold = 50; // 滑动阈值
    
    // 向右滑动打开侧边栏
    // 但在流程图视图中不响应，避免与画布操作冲突
    if (deltaX > threshold && this.uiState.activeView() !== 'flow') {
      this.isSidebarOpen.set(true);
    }
    
    this.isSwiping = false;
  }

  readonly showSettingsAuthForm = this.authCoord.showSettingsAuthForm;
  
  // ========== 模态框状态（代理到 ModalService）==========
  // 使用 ModalService 统一管理，以下为便捷访问器
  
  /** 冲突数据已迁移到 _pendingConflict 字段（命令式模态框方案） */
  
  currentFilterLabel = computed(() => {
    const filterId = this.uiState.filterMode();
    if (filterId === 'all') return '全部任务';
    const task = this.projectState.getTask(filterId);
    if (!task) return '全部任务';
    return task.title || task.displayId || '未命名任务';
  });

  /**
   * 侧边栏录音转写结果写入黑匣子
   */
  onSidebarVoiceTranscribed(text: string): void {
    const content = text.trim();
    if (!content) return;

    const result = this.blackBoxService.create({ content });
    if (!result.ok) {
      this.toast.warning('录音保存失败', result.error.message);
    }
  }

  onSidebarToolsIntent(): void {
    if (!FEATURE_FLAGS.SIDEBAR_TOOLS_DYNAMIC_LOAD_V1) {
      return;
    }
    this.preloadSidebarTools('intent');
  }

  private preloadSidebarTools(reason: 'startup' | 'p1' | 'intent'): void {
    void this.loadSpotlightTriggerComponent();
    void this.preloadFocusModeAssets(reason);

    if (this.focusPrefs.isBlackBoxEnabled()) {
      void this.loadBlackBoxRecorderComponent();
    }

    this.sentryLazyLoader.addBreadcrumb({
      category: 'startup',
      message: 'sidebar.tools.preload',
      level: 'info',
      data: { reason },
    });
  }

  private loadSpotlightTriggerComponent(): Promise<Type<unknown> | null> {
    const current = this.spotlightTriggerComponent();
    if (current) return Promise.resolve(current);
    if (this.spotlightTriggerLoadPromise) return this.spotlightTriggerLoadPromise;

    this.spotlightTriggerLoadPromise = import('./app/features/focus/components/spotlight/spotlight-trigger.component')
      .then((module) => {
        const component = module.SpotlightTriggerComponent as Type<unknown>;
        // 防御性校验：确保动态导入的组件是有效的构造函数
        // 在 SW 缓存不一致时，导入可能成功但导出值为 undefined
        if (typeof component !== 'function') {
          this.logger.warn('SpotlightTriggerComponent 导入值无效（疑似 chunk 版本偏移）', { type: typeof component });
          return null;
        }
        this.spotlightTriggerComponent.set(component);
        return component;
      })
      .catch((error: unknown) => {
        this.logger.warn('SpotlightTriggerComponent 懒加载失败', error);
        return null;
      })
      .finally(() => {
        this.spotlightTriggerLoadPromise = null;
      });

    return this.spotlightTriggerLoadPromise;
  }

  private loadBlackBoxRecorderComponent(): Promise<Type<unknown> | null> {
    const current = this.blackBoxRecorderComponent();
    if (current) return Promise.resolve(current);
    if (this.blackBoxRecorderLoadPromise) return this.blackBoxRecorderLoadPromise;

    this.blackBoxRecorderLoadPromise = import('./app/features/focus/components/black-box/black-box-recorder.component')
      .then((module) => {
        const component = module.BlackBoxRecorderComponent as Type<unknown>;
        // 防御性校验：确保动态导入的组件是有效的构造函数
        // 在 SW 缓存不一致时，导入可能成功但导出值为 undefined
        if (typeof component !== 'function') {
          this.logger.warn('BlackBoxRecorderComponent 导入值无效（疑似 chunk 版本偏移）', { type: typeof component });
          return null;
        }
        this.blackBoxRecorderComponent.set(component);
        return component;
      })
      .catch((error: unknown) => {
        this.logger.warn('BlackBoxRecorderComponent 懒加载失败', error);
        return null;
      })
      .finally(() => {
        this.blackBoxRecorderLoadPromise = null;
      });

    return this.blackBoxRecorderLoadPromise;
  }

  private preloadFocusModeAssets(reason: 'startup' | 'p1' | 'intent'): Promise<void> {
    if (this.focusModePreloadPromise) return this.focusModePreloadPromise;

    this.focusModePreloadPromise = import('./app/features/focus/focus-mode.component')
      .then(async (module) => {
        const focusModeComponent = module.FocusModeComponent;
        if (typeof focusModeComponent?.preloadAssets === 'function') {
          await focusModeComponent.preloadAssets();
        }
        this.sentryLazyLoader.addBreadcrumb({
          category: 'startup',
          message: 'focus-mode.preload',
          level: 'info',
          data: { reason },
        });
      })
      .catch((error: unknown) => {
        this.logger.warn('FocusMode 懒预热失败', error);
      })
      .finally(() => {
        this.focusModePreloadPromise = null;
      });

    return this.focusModePreloadPromise;
  }

  private scheduleFocusModePreload(reason: 'startup' | 'p1'): void {
    if (this.focusModePreloadScheduled) return;
    this.focusModePreloadScheduled = true;

    const runPreload = () => {
      void this.preloadFocusModeAssets(reason);
    };

    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      const requestIdle = (window as Window & {
        requestIdleCallback: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      }).requestIdleCallback;
      requestIdle(() => runPreload(), { timeout: 1800 });
      return;
    }

    setTimeout(runPreload, 1200);
  }

  // 模态框开关状态 - 保留删除项目用（其余已迁移到命令式渲染）
  readonly showDeleteProjectModal = computed(() => this.modal.isOpen('deleteProject'));
  
  readonly showLoginRequired = this.authCoord.showLoginRequired;
  
  /** 删除项目目标 - 从 ModalService 获取 */
  readonly deleteProjectTarget = computed(() => {
    const data = this.modal.getData('deleteProject') as DeleteProjectData | undefined;
    return data ? { id: data.projectId, name: data.projectName } : null;
  });
  
  // 统一搜索查询
  unifiedSearchQuery = signal<string>('');
  /** 记录上一次视口断点状态，避免移动端 resize 抖动触发误收起 */
  private previousViewportIsMobile = this.uiState.isMobile();

  /** PWA 安装提示（仅浏览器模式显示） */
  readonly showInstallPrompt = computed(() =>
    FEATURE_FLAGS.PWA_INSTALL_PROMPT_V1 && this.pwaInstall.canShowInstallPrompt()
  );
  readonly pwaInstallHint = computed(() => this.pwaInstall.installHint());
  
  // 搜索防抖定时器
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly SEARCH_DEBOUNCE_DELAY = 300; // 300ms 搜索防抖
  private focusProbeInitializedForUser: string | null = null;
  private interactionWarmupDone = false;
  private syncHydrationDone = false;
  private remoteCallbacksInitialized = false;
  private remoteCallbacksInitializing = false;
  private subscribedProjectId: string | null = null;
  private remoteChangeHandlerPromise: Promise<RemoteChangeHandlerLike | null> | null = null;
  private eventDrivenSyncPulseRef: EventDrivenSyncPulseLike | null = null;
  private eventDrivenSyncPulsePromise: Promise<EventDrivenSyncPulseLike | null> | null = null;
  private startupDiagnosticsPromise: Promise<StartupDiagnosticsLike[] | null> | null = null;
  private pwaPromptInitScheduled = false;
  private workspaceHandoffSignaled = false;

  constructor() {
    // 启动流程：仅执行必要的同步初始化
    // 关键：bootstrapSession 移到 ngOnInit + setTimeout，避免阻塞 TTFB
    if (this.previousViewportIsMobile) {
      this.isSidebarOpen.set(false);
    }
    this.setupSwUpdateListener();
    // 主题初始化在 StoreService 构造函数中完成
    // 不再在此重复应用主题
    this.setupConflictHandler();
    this.setupSidebarToggleListener();
    this.setupStorageFailureHandler();
    this.setupBeforeUnloadHandler();

    // Wire modal coordinator callbacks so the service can call back into
    // component-level methods without creating a circular dependency.
    this.modalCoord.initCallbacks({
      signOut: () => this.signOut(),
      updateTheme: (theme: ThemeType) => this.updateTheme(theme),
      handleImportComplete: (project: Project) => void this.handleImportComplete(project),
      handleLoginFromModal: (data) => void this.handleLoginFromModal(data),
      handleSignupFromModal: (data) => void this.handleSignupFromModal(data),
      handleResetPasswordFromModal: (email) => void this.handleResetPasswordFromModal(email),
      handleLocalModeFromModal: () => this.handleLocalModeFromModal(),
      confirmCreateProject: (name, desc) => void this.confirmCreateProject(name, desc),
      handleMigrationComplete: () => this.handleMigrationComplete(),
      closeMigrationModal: () => this.closeMigrationModal(),
    });

    // ── Service Initialization Order ──────────────────────────────────────
    // The six startup services are initialized in a strict sequence to
    // respect dependency constraints and avoid competing for resources.
    // See AppLifecycleOrchestratorService.initialize() JSDoc for the full
    // rationale behind each step.
    //
    // Step 1 (here, constructor): AppLifecycleOrchestratorService
    //   - Must be first: resume/recovery listeners must be active before
    //     any async startup work begins.
    // Step 2 (ngOnInit): StartupTierOrchestratorService.initialize()
    // Step 3 (ngOnInit): lazy StartupFontSchedulerService.initialize()
    // Step 4 (signal effect): FocusStartupProbeService.initialize()
    //   - Fires reactively after coreDataLoaded() && authenticated.
    // Step 5 (signal effect): EventDrivenSyncPulseService.initialize()
    //   - Fires reactively after auth + P2 tier readiness.
    // Step 6 (deferred): PwaInstallPromptService.initialize()
    //   - Deferred to first user interaction or requestIdleCallback.
    // ──────────────────────────────────────────────────────────────────────
    this.appLifecycle.initialize();
    
    // effect() 必须在注入上下文中调用（构造函数），否则抛 NG0203
    this.setupSignalEffects();
  }

  /**
   * 全局撤销/重做快捷键（capture 阶段）
   *
   * 背景：某些聚焦组件（如 GoJS Canvas / 第三方控件）会在 bubble 阶段 stopPropagation，
   * 导致 HostListener('document:keydown') 偶发收不到 Ctrl/Cmd+Z，从而表现为“撤回失效”。
   *
   * 解决：在 capture 阶段优先处理快捷键，并在 bubble 阶段用 defaultPrevented 去重。
   */
  private readonly keyboardShortcutCaptureListener = (event: KeyboardEvent) => {
    // 避免重复触发（例如 HMR 或其他监听器已处理）
    if (event.defaultPrevented) return;

    // 防御：某些特殊键盘事件可能没有 key 属性
    if (!event.key) return;

    const key = event.key.toLowerCase();

    // Ctrl+Z / Cmd+Z: 撤销
    if ((event.ctrlKey || event.metaKey) && key === 'z' && !event.shiftKey) {
      event.preventDefault();
      this.taskOpsAdapter.performUndo();
      return;
    }

    // Ctrl+Shift+Z / Cmd+Shift+Z: 重做
    if ((event.ctrlKey || event.metaKey) && key === 'z' && event.shiftKey) {
      event.preventDefault();
      this.taskOpsAdapter.performRedo();
      return;
    }

    // Ctrl+Y / Cmd+Y: 重做（Windows 风格）
    if ((event.ctrlKey || event.metaKey) && key === 'y') {
      event.preventDefault();
      this.taskOpsAdapter.performRedo();
      return;
    }

    // Ctrl+F / Cmd+F: 聚焦全局搜索框（覆盖浏览器默认查找）
    if ((event.ctrlKey || event.metaKey) && key === 'f' && !event.shiftKey) {
      event.preventDefault();
      // 确保侧边栏打开
      this.isSidebarOpen.set(true);
      // 延迟聚焦，等待侧边栏展开动画
      setTimeout(() => {
        const searchInput = document.querySelector<HTMLInputElement>('aside input[aria-label="搜索项目或任务"]');
        searchInput?.focus();
        searchInput?.select();
      }, 50);
      return;
    }

    // Ctrl+B / Cmd+B: 切换黑匣子面板
    if ((event.ctrlKey || event.metaKey) && key === 'b' && !event.shiftKey) {
      event.preventDefault();
      showBlackBoxPanel.update(v => !v);
      return;
    }

    // Ctrl+. / Cmd+.: 进入聚光灯专注模式
    if ((event.ctrlKey || event.metaKey) && key === '.') {
      event.preventDefault();
      this.spotlightService.enter();
      return;
    }
  };

  private readonly focusMountIntentListener = () => {
    if (!FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1) return;
    this.focusModeIntentActivated.set(true);
    if (FEATURE_FLAGS.EVENT_DRIVEN_SYNC_PULSE_V1) {
      this.triggerSyncPulse('focus-entry');
    }
    this.teardownFocusMountIntentListener();
  };

  private readonly flowRestoreBreadcrumbListener = (event: Event) => {
    const detail = (event as CustomEvent<{ mode?: 'applied' | 'degraded'; reason?: string; projectId?: string }>).detail;
    const mode = detail?.mode === 'applied' ? 'applied' : 'degraded';
    this.sentryLazyLoader.addBreadcrumb({
      category: 'startup',
      message: mode === 'applied' ? 'flow.restore.applied' : 'flow.restore.degraded',
      level: 'info',
      data: {
        mode,
        reason: detail?.reason ?? 'unknown',
        projectId: detail?.projectId ?? null,
      },
    });
  };

  private readonly syncPulseBreadcrumbListener = (event: Event) => {
    const detail = (event as CustomEvent<{ status?: string; reason?: string; skipReason?: string }>).detail;
    this.sentryLazyLoader.addBreadcrumb({
      category: 'sync',
      message: 'sync.pulse.reason',
      level: 'info',
      data: {
        status: detail?.status ?? 'unknown',
        reason: detail?.reason ?? 'unknown',
        skipReason: detail?.skipReason ?? null,
      },
    });
  };
  
  ngOnInit() {
    this.setupRouteSync();

    // capture 阶段注册全局快捷键，避免被聚焦组件吞掉
    document.addEventListener('keydown', this.keyboardShortcutCaptureListener, { capture: true });

    // ⚡ 性能优化：延迟会话检查到浏览器空闲时段
    this.authCoord.scheduleSessionBootstrap();
    this.schedulePwaPromptInitialization();
    this.scheduleStartupFontInitialization();
    this.startupTier.initialize();
    this.scheduleFocusModePreload('startup');
    if (!FEATURE_FLAGS.SIDEBAR_TOOLS_DYNAMIC_LOAD_V1) {
      this.preloadSidebarTools('startup');
    }
    this.setupFocusMountIntentListener();
    this.recordStartupPreloadBreadcrumb();
    this.recordModulePreloadModeBreadcrumb();
    this.setupFlowRestoreBreadcrumbListener();
    this.setupSyncPulseBreadcrumbListener();

    if (!FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1) {
      // 旧策略兜底：未开启分层启动时维持原有初始化节奏
      setTimeout(() => this.syncCoordinator.initialize(), 100);
    }
    
    // 🚀 空闲时预加载常用模态框（消除首次点击延迟）
    this.modalCoord.preloadCommonModals();
    
    // 🛡️ 数据保护：延迟初始化存储配额监控和 IndexedDB 健康检查
    setTimeout(() => {
      this.initializeStartupDiagnosticsLazy();
    }, 5000); // 延迟 5 秒，避免阻塞启动
    
    // 🛡️ 安全校验：验证关键 Feature Flags 是否处于安全状态
    this.validateCriticalFeatureFlags();
  }

  ngAfterViewInit(): void {
    this.signalWorkspaceHandoffReady();
  }
  
  /**
   * 启动时校验关键 Feature Flags
   * 
   * 【NEW-8】使用集中式校验函数，覆盖全部关键保护性开关（7 项）
   * 如果数据保护相关的开关被意外关闭，发出 Sentry 警告 + 开发者 Toast
   */
  private validateCriticalFeatureFlags(): void {
    const disabledFlags = validateCriticalFlags();
    
    if (disabledFlags.length > 0) {
      const names = disabledFlags.map(f => f.flag).join('、');
      this.logger.warn('关键安全开关被禁用', { 
        flags: disabledFlags.map(f => f.flag),
        risks: disabledFlags.map(f => f.risk),
      });
      
      // 开发环境显示 Toast 提醒
      const isDev = typeof window !== 'undefined' && window.location?.hostname === 'localhost';
      if (isDev) {
        this.toast.warning(
          '安全开关警告', 
          `${disabledFlags.length} 个关键开关被禁用：${names}`, 
          { duration: 10000 }
        );
      }
    }
  }
  
  /**
   * 信号 effect 集中注册（必须在构造函数中调用以确保注入上下文可用）
   * 
   * 背景：effect() 内部需要 inject(Injector)，若在 ngOnInit 等生命周期钩子中调用
   * 会抛出 NG0203: inject() must be called from an injection context
   */
  private setupSignalEffects(): void {
    this.setupModalEffects();
    this.setupDataProtectionEffect();
    this.setupLaunchSnapshotEffect();
    this.setupFocusProbeEffect();
    this.setupStartupTierEffects();
    this.setupRemoteCallbackEffect();
    this.setupSubscriptionEffect();
    this.setupSyncPulseEffect();
  }

  /** 模态框请求信号监听（可恢复错误 / 登录 / 迁移） */
  private setupModalEffects(): void {
    // 监听可恢复错误信号，命令式打开错误恢复模态框
    effect(() => {
      const error = this.errorHandler.recoverableError();
      if (error) {
        void this.openErrorRecoveryModal({
          title: error.title,
          message: error.message,
          details: error.details,
          options: error.options,
          defaultOptionId: error.defaultOptionId,
          autoSelectIn: error.autoSelectIn,
          resolve: (result: { optionId: string }) => error.resolve(result.optionId)
        });
      }
    });
    
    // 监听登录模态框请求（从 ModalService 的 show('login') 迁移）
    effect(() => {
      const loginRequested = this.modal.isOpen('login');
      if (loginRequested) {
        const loginData = this.modal.getData('login') as LoginData | undefined;
        this.modalCoord.loginReturnUrl = loginData?.returnUrl ?? null;
        this.modal.closeByType('login');
        if (!this.modalCoord.loginModalRef) {
          void this.openLoginModal();
        }
      }
    });
    
    // 监听迁移模态框请求
    effect(() => {
      const migrationRequested = this.modal.isOpen('migration');
      if (migrationRequested) {
        this.modal.closeByType('migration');
        void this.openMigrationModal();
      }
    });
  }

  /** 📦 数据保护：导出提醒（7 天未导出时 Toast 提示） */
  private setupDataProtectionEffect(): void {
    effect(() => {
      const needsReminder = this.exportService.needsExportReminder();
      const userId = this.userSession.currentUserId();
      if (needsReminder && userId) {
        this.toast.info(
          '数据备份提醒',
          '已超过 7 天未导出备份，建议前往设置导出数据。',
          { duration: 10000 }
        );
      }
    });
  }

  /** 启动快照：将最近项目摘要写入轻量快照，供下次冷启动直接显示。 */
  private setupLaunchSnapshotEffect(): void {
    effect(() => {
      const snapshot = this.launchSnapshot.capture(this.projectState.projects(), {
        activeProjectId: this.projectState.activeProjectId(),
        lastActiveView: this.uiState.activeView(),
        theme: this.preferenceService.theme(),
        colorMode: this.readCurrentColorMode(),
      });

      this.launchSnapshot.schedulePersist(snapshot);
    });
  }

  private readCurrentColorMode(): 'light' | 'dark' | 'system' {
    if (typeof document === 'undefined') {
      return 'system';
    }

    const mode = document.documentElement.getAttribute('data-color-mode');
    if (mode === 'light' || mode === 'dark') {
      return mode;
    }
    return 'system';
  }

  private signalWorkspaceHandoffReady(): void {
    if (this.workspaceHandoffSignaled) {
      return;
    }

    this.workspaceHandoffSignaled = true;
    this.bootStage.markWorkspaceHandoffReady();
  }

  /** Focus 启动探针：登录后尽早执行本地 gate 检查 */
  private setupFocusProbeEffect(): void {
    effect(() => {
      if (!FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1) return;

      const userId = this.currentUserId();
      if (!userId) {
        this.focusProbeInitializedForUser = null;
        return;
      }

      if (!this.coreDataLoaded()) return;
      if (this.focusProbeInitializedForUser === userId) return;

      this.focusProbeInitializedForUser = userId;
      this.focusStartupProbe.initialize();
    });
  }

  /** 分层启动补水：auth → p1 warmup → p2 sync */
  private setupStartupTierEffects(): void {
    effect(() => {
      if (!FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1) return;
      if (!this.currentUserId()) return;
      if (!this.coreDataLoaded()) return;

      this.startupTier.markAuthReady();
    });

    effect(() => {
      if (!FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1) return;
      if (!this.startupTier.isTierReady('p1')) return;
      if (this.interactionWarmupDone) return;

      this.interactionWarmupDone = true;
      void this.taskOpsAdapter.warmup();
      if (FEATURE_FLAGS.SIDEBAR_TOOLS_DYNAMIC_LOAD_V1) {
        this.preloadSidebarTools('p1');
      }
    });

    effect(() => {
      if (!FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1) return;
      if (!this.startupTier.isTierReady('p2')) return;
      if (this.syncHydrationDone) return;

      this.syncHydrationDone = true;
      this.syncCoordinator.initialize();
    });
  }

  /** 远程变更回调初始化 */
  private setupRemoteCallbackEffect(): void {
    effect(() => {
      if (!FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1) return;

      const userId = this.currentUserId();
      if (!userId || !this.coreDataLoaded()) {
        return;
      }

      if (FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1 && !this.startupTier.isTierReady('p2')) {
        return;
      }

      if (this.remoteCallbacksInitialized || this.remoteCallbacksInitializing) {
        return;
      }

      this.remoteCallbacksInitializing = true;
      void this.getRemoteChangeHandlerLazy().then((handler) => {
        if (!handler) {
          this.remoteCallbacksInitializing = false;
          return;
        }

        handler.setupCallbacks({
          onRefreshActiveProject: async (reason) => { await this.syncCoordinator.refreshActiveProjectSilent(reason); },
          onLoadProjects: async () => {
            await this.syncCoordinator.refreshActiveProjectSilent('remote:fallback-load-projects');
          }
        });

        this.remoteCallbacksInitialized = true;
        this.remoteCallbacksInitializing = false;
      }).catch((error) => {
        this.logger.warn('恢复回调初始化失败', error);
        this.remoteCallbacksInitializing = false;
      });
    });
  }

  /** 项目订阅管理 */
  private setupSubscriptionEffect(): void {
    effect(() => {
      if (!FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1) return;

      const userId = this.currentUserId();
      const projectId = this.activeProjectId();
      const readyForSubscription = !!userId &&
        this.coreDataLoaded() &&
        (!FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1 || this.startupTier.isTierReady('p2'));

      if (!readyForSubscription || !userId) {
        if (this.subscribedProjectId !== null) {
          this.subscribedProjectId = null;
          void this.simpleSync.unsubscribeFromProject();
        }
        return;
      }

      if (!projectId) {
        if (this.subscribedProjectId !== null) {
          this.subscribedProjectId = null;
          void this.simpleSync.unsubscribeFromProject();
        }
        return;
      }

      if (this.subscribedProjectId === projectId) {
        return;
      }

      this.subscribedProjectId = projectId;
      void this.simpleSync.subscribeToProject(projectId, userId);
    });
  }

  /** 同步心跳管理 */
  private setupSyncPulseEffect(): void {
    effect(() => {
      if (!FEATURE_FLAGS.EVENT_DRIVEN_SYNC_PULSE_V1) {
        this.destroySyncPulse();
        return;
      }

      const userId = this.currentUserId();
      if (!userId || !this.coreDataLoaded()) {
        this.destroySyncPulse();
        return;
      }

      if (FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1 && !this.startupTier.isTierReady('p2')) {
        this.destroySyncPulse();
        return;
      }

      this.initializeSyncPulse();
    });
  }

  ngOnDestroy() {
    // DestroyRef 自动处理取消订阅，无需手动触发
    
    // 确保待处理的撤销操作被保存
    this.undoService.flushPendingAction();
    
    // 释放模态框协调器的回调引用，避免持有过期组件引用
    this.modalCoord.clearCallbacks();
    
    // 移除全局事件监听器
    window.removeEventListener('toggle-sidebar', this.handleToggleSidebar);
    document.removeEventListener('keydown', this.keyboardShortcutCaptureListener, { capture: true } as AddEventListenerOptions);
    this.teardownFocusMountIntentListener();
    this.teardownFlowRestoreBreadcrumbListener();
    this.teardownSyncPulseBreadcrumbListener();
    this.destroySyncPulse();
    this.startupTier.destroy();
    if (FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1) {
      this.subscribedProjectId = null;
      void this.simpleSync.unsubscribeFromProject();
    }
    
    // 取消注册 beforeunload 回调
    // 注意：BeforeUnloadManagerService 是 providedIn: 'root'，不会随组件销毁
    // 但我们仍需取消注册此组件的回调
    this.beforeUnloadManager.unregister('app-core-save');
    this.beforeUnloadGuard.disable();
    
    // 清理搜索防抖定时器
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
    }
    // M-12 fix: 清理窗口 resize 防抖定时器
    if (this.resizeDebounceTimer) {
      clearTimeout(this.resizeDebounceTimer);
      this.resizeDebounceTimer = null;
    }
  }

  private schedulePwaPromptInitialization(): void {
    if (this.pwaPromptInitScheduled) {
      return;
    }
    this.pwaPromptInitScheduled = true;

    if (!FEATURE_FLAGS.PWA_PROMPT_DEFER_V2) {
      this.pwaInstall.initialize();
      return;
    }

    const init = () => this.pwaInstall.initialize();

    if (typeof window !== 'undefined') {
      let initialized = false;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        window.removeEventListener('pointerdown', onFirstIntent);
        window.removeEventListener('keydown', onFirstIntent);
        window.removeEventListener('touchstart', onFirstIntent);
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };
      const initOnce = () => {
        if (initialized) return;
        initialized = true;
        cleanup();
        init();
      };
      const onFirstIntent = () => initOnce();

      window.addEventListener('pointerdown', onFirstIntent, { once: true, passive: true });
      window.addEventListener('keydown', onFirstIntent, { once: true });
      window.addEventListener('touchstart', onFirstIntent, { once: true, passive: true });

      if ('requestIdleCallback' in window) {
        (
          window as Window & {
            requestIdleCallback: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
          }
        ).requestIdleCallback(() => initOnce(), { timeout: 2500 });
      } else {
        idleTimer = setTimeout(initOnce, 1500);
      }
      return;
    }

    init();
  }

  private scheduleStartupFontInitialization(): void {
    if (this.startupFontSchedulerInitPromise) {
      return;
    }

    this.startupFontSchedulerInitPromise = import('./services/startup-font-scheduler.service')
      .then(({ StartupFontSchedulerService }) => {
        this.injector.get(StartupFontSchedulerService).initialize();
      })
      .catch((error: unknown) => {
        this.startupFontSchedulerInitPromise = null;
        this.logger.warn('延迟初始化字体调度器失败', error);
      });
  }

  private async getRemoteChangeHandlerLazy(): Promise<RemoteChangeHandlerLike | null> {
    if (this.remoteChangeHandlerPromise) {
      return this.remoteChangeHandlerPromise;
    }

    this.remoteChangeHandlerPromise = import('./services/remote-change-handler.service')
      .then((module) => this.injector.get(module.RemoteChangeHandlerService))
      .catch((error) => {
        this.logger.warn('RemoteChangeHandlerService 懒加载失败，降级为无回调恢复路径', error);
        return null;
      })
      .finally(() => {
        this.remoteChangeHandlerPromise = null;
      });

    return this.remoteChangeHandlerPromise;
  }

  private async getEventDrivenSyncPulseLazy(): Promise<EventDrivenSyncPulseLike | null> {
    if (this.eventDrivenSyncPulseRef) {
      return this.eventDrivenSyncPulseRef;
    }
    if (this.eventDrivenSyncPulsePromise) {
      return this.eventDrivenSyncPulsePromise;
    }

    this.eventDrivenSyncPulsePromise = import('./services/event-driven-sync-pulse.service')
      .then((module) => {
        const service = this.injector.get(module.EventDrivenSyncPulseService) as EventDrivenSyncPulseLike;
        this.eventDrivenSyncPulseRef = service;
        return service;
      })
      .catch((error) => {
        this.logger.warn('EventDrivenSyncPulseService 懒加载失败，降级关闭 pulse', error);
        return null;
      })
      .finally(() => {
        this.eventDrivenSyncPulsePromise = null;
      });

    return this.eventDrivenSyncPulsePromise;
  }

  private triggerSyncPulse(reason: 'focus-entry' | 'manual' | 'focus' | 'visible' | 'pageshow' | 'online' | 'heartbeat'): void {
    void this.getEventDrivenSyncPulseLazy().then((service) => {
      if (!service) return;
      void service.triggerNow(reason);
    });
  }

  private initializeSyncPulse(): void {
    void this.getEventDrivenSyncPulseLazy().then((service) => service?.initialize());
  }

  private destroySyncPulse(): void {
    if (this.eventDrivenSyncPulseRef) {
      this.eventDrivenSyncPulseRef.destroy();
      return;
    }
    if (this.eventDrivenSyncPulsePromise) {
      void this.eventDrivenSyncPulsePromise.then((service) => service?.destroy());
    }
  }

  private initializeStartupDiagnosticsLazy(): void {
    if (this.startupDiagnosticsPromise) {
      return;
    }

    this.startupDiagnosticsPromise = Promise.all([
      import('./services/storage-quota.service'),
      import('./services/indexeddb-health.service'),
    ]).then(([quotaModule, healthModule]) => {
      const quota = this.injector.get(quotaModule.StorageQuotaService) as StartupDiagnosticsLike;
      const health = this.injector.get(healthModule.IndexedDBHealthService) as unknown as StartupDiagnosticsLike;
      return [quota, health];
    }).catch((error) => {
      this.logger.warn('启动诊断服务懒加载失败，已跳过', error);
      return null;
    });

    void this.startupDiagnosticsPromise.then((services) => {
      if (!services) return;
      for (const service of services) {
        void Promise.resolve(service.initialize());
      }
    });
  }

  private setupFocusMountIntentListener(): void {
    if (typeof window === 'undefined' || !FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1) {
      return;
    }
    window.addEventListener('pointerdown', this.focusMountIntentListener, { once: true, passive: true });
    window.addEventListener('keydown', this.focusMountIntentListener, { once: true });
    window.addEventListener('touchstart', this.focusMountIntentListener, { once: true, passive: true });
  }

  private teardownFocusMountIntentListener(): void {
    if (typeof window === 'undefined') return;
    window.removeEventListener('pointerdown', this.focusMountIntentListener);
    window.removeEventListener('keydown', this.focusMountIntentListener);
    window.removeEventListener('touchstart', this.focusMountIntentListener);
  }

  private setupFlowRestoreBreadcrumbListener(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('nanoflow:flow-restore-status', this.flowRestoreBreadcrumbListener as EventListener);
  }

  private teardownFlowRestoreBreadcrumbListener(): void {
    if (typeof window === 'undefined') return;
    window.removeEventListener('nanoflow:flow-restore-status', this.flowRestoreBreadcrumbListener as EventListener);
  }

  private setupSyncPulseBreadcrumbListener(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('nanoflow:sync-pulse', this.syncPulseBreadcrumbListener as EventListener);
  }

  private teardownSyncPulseBreadcrumbListener(): void {
    if (typeof window === 'undefined') return;
    window.removeEventListener('nanoflow:sync-pulse', this.syncPulseBreadcrumbListener as EventListener);
  }

  private recordStartupPreloadBreadcrumb(): void {
    if (typeof window === 'undefined') return;
    const preloadDisabled = (window as { __NANOFLOW_PRELOAD_DISABLED__?: boolean }).__NANOFLOW_PRELOAD_DISABLED__ !== false;
    this.sentryLazyLoader.addBreadcrumb({
      category: 'startup',
      message: preloadDisabled ? 'startup.preload.disabled' : 'startup.preload.enabled',
      level: 'info',
      data: { preloadDisabled },
    });
  }

  private recordModulePreloadModeBreadcrumb(): void {
    if (typeof window === 'undefined') return;

    const strictModulepreload =
      (window as Window).__NANOFLOW_BOOT_FLAGS__?.STRICT_MODULEPRELOAD_V2 !== false;

    this.sentryLazyLoader.addBreadcrumb({
      category: 'startup',
      message: strictModulepreload
        ? 'startup.modulepreload.strict'
        : 'startup.modulepreload.relaxed',
      level: 'info',
      data: { strictModulepreload },
    });
  }
  
  /** 设置页面卸载前的数据保存处理器 */
  private setupBeforeUnloadHandler(): void {
    if (typeof window === 'undefined') return;
    this.beforeUnloadManager.initialize();
    this.beforeUnloadGuard.enable();
    this.beforeUnloadManager.register('app-core-save', () => {
      this.syncCoordinator.flushPendingPersist();
      this.undoService.flushPendingAction();
      this.simpleSync.flushRetryQueueSync();
      // 【NEW-6 修复】同步刷盘 ActionQueue 待处理操作到 localStorage
      // ActionQueue 内存中的操作若未持久化，页面关闭后将丢失
      this.actionQueue.storage.saveQueueToStorage();
      this.actionQueue.storage.saveDeadLetterToStorage();
      return false;
    }, 1);
  }
  
  /**
   * 监听子组件发出的 toggle-sidebar 事件
   * 箭头函数确保 this 绑定正确
   */
  private handleToggleSidebar = () => {
    this.isSidebarOpen.update(v => !v);
  };
  
  private setupSidebarToggleListener() {
    window.removeEventListener('toggle-sidebar', this.handleToggleSidebar);
    window.addEventListener('toggle-sidebar', this.handleToggleSidebar);
  }
  
  /**
   * 设置存储失败处理器
   * 
   * 当 localStorage 和 IndexedDB 都失败时，显示逃生模态框
   * 让用户手动复制数据进行备份
   */
  private setupStorageFailureHandler(): void {
    this.actionQueue.onStorageFailure((data) => {
      // 构造逃生数据
      const escapeData: StorageEscapeData = {
        queue: data.queue,
        deadLetter: data.deadLetter,
        projects: this.projectState.projects(), // 附加当前项目数据
        timestamp: new Date().toISOString()
      };

      this.modalCoord.storageEscapeData.set(escapeData);
      // 使用命令式方式打开存储逃生模态框
      void this.modalCoord.openStorageEscapeModalImperative();
    });
  }

  /**
   * 关闭存储逃生模态框
   */
  closeStorageEscapeModal(): void {
    this.modalCoord.closeStorageEscapeModal();
  }
  
  /**
   * 设置路由参数与状态的同步
   * 监听 URL 变化并更新 activeProjectId
   */
  private setupRouteSync() {
    // 监听路由参数变化
    this.router.events.pipe(
      filter(event => event instanceof NavigationEnd),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(() => {
      this.syncStateFromRoute();
    });
    
    // 初始同步
    this.syncStateFromRoute();
    
    // 监听 activeProjectId 变化，更新 URL
    // 使用 effect 或手动订阅
  }
  
  /**
   * 从路由参数同步状态
   */
  private syncStateFromRoute() {
    // 获取当前完整路由
    let currentRoute = this.route;
    while (currentRoute.firstChild) {
      currentRoute = currentRoute.firstChild;
    }
    
    const params = currentRoute.snapshot.params;
    const projectId = params['projectId'];
    
    if (projectId && projectId !== this.projectState.activeProjectId()) {
      // 项目列表尚未加载完成时，不要基于空列表做重定向，避免深链接被误判。
      if (this.projectState.projects().length === 0) {
        return;
      }

      // 检查项目是否存在
      const projectExists = this.projectState.projects().some(p => p.id === projectId);
      if (projectExists) {
        this.projectState.setActiveProjectId(projectId);
      } else {
        // 项目不存在，重定向到默认路由
        void this.router.navigate(['/projects']);
      }
    }
    
    // taskId 的定位由 ProjectShellComponent 处理
  }
  
  /**
   * 更新 URL 以反映当前状态（可选调用）
   */
  updateUrlForProject(projectId: string) {
    void this.router.navigate(['/projects', projectId], { 
      replaceUrl: true,
      queryParamsHandling: 'preserve'
    });
  }
  
  private setupConflictHandler() {
    // 订阅冲突事件流 - 使用命令式模态框
    this.syncCoordinator.onConflict$.pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(({ localProject, remoteProject, projectId }) => {
      // 存储冲突数据供解决方法使用
      this.modalCoord.setPendingConflict({ localProject, remoteProject, projectId });
      void this.modalCoord.openConflictModal({ localProject, remoteProject, projectId });
    });
  }

  // 解决冲突：使用本地版本
  async resolveConflictLocal() {
    await this.modalCoord.resolveConflictLocal();
  }

  // 解决冲突：使用远程版本
  async resolveConflictRemote() {
    await this.modalCoord.resolveConflictRemote();
  }

  // 解决冲突：智能合并
  async resolveConflictMerge() {
    await this.modalCoord.resolveConflictMerge();
  }

  // 取消冲突解决（稍后处理）
  cancelConflictResolution() {
    this.modalCoord.cancelConflictResolution();
  }
  
  private setupSwUpdateListener() {
    if (this.swUpdate.isEnabled) {
      this.swUpdate.versionUpdates
        .pipe(
          filter((evt): evt is VersionReadyEvent => evt.type === 'VERSION_READY'),
          takeUntilDestroyed(this.destroyRef)
        )
        .subscribe(() => {
          this.appLifecycle.markVersionReady();
          // 使用 ToastService 显示更新通知，带操作按钮
          this.toast.info(
            '🚀 发现新版本', 
            '软件有更新可用，点击刷新获取最新功能',
            {
              duration: 0, // 不自动关闭
              action: {
                label: '立即刷新',
                onClick: () => reloadViaForceClearCache()
              }
            }
          );
        });
    }
  }

  async installPwaApp(): Promise<void> {
    const installed = await this.pwaInstall.promptInstall();
    if (installed) {
      this.toast.success('安装已开始', '安装完成后可在主屏/桌面直接启动');
      return;
    }

    if (!this.pwaInstall.canInstall()) {
      this.toast.info('安装提示', this.pwaInstall.installHint());
    }
  }

  dismissPwaInstallPrompt(): void {
    this.pwaInstall.dismissPrompt();
  }

  // Resizing State
  isResizingSidebar = false;
  isResizingContent = false;
  /** 模板绑定：是否正在拖拽分栏 */
  get isResizingAny() { return this.isResizingSidebar || this.isResizingContent; }
  private startX = 0;
  private startWidth = 0;
  private startRatio = 0;
  private mainContentWidth = 0;
  private resizeRafId = 0;

  toggleSidebar() {
    this.isSidebarOpen.update(v => !v);
  }

  // --- Resizing Logic ---

  startSidebarResize(e: MouseEvent) {
      e.preventDefault();
      this.isResizingSidebar = true;
      this.uiState.isResizing.set(true);
      this.startX = e.clientX;
      this.startWidth = this.uiState.sidebarWidth();
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
  }

  startContentResize(e: MouseEvent) {
      e.preventDefault();
      this.isResizingContent = true;
      this.startX = e.clientX;
      this.startRatio = this.uiState.textColumnRatio();
      
      // Get current main content width
      const mainEl = document.querySelector('main');
      this.mainContentWidth = mainEl ? mainEl.clientWidth : 1000;
      
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
  }

  @HostListener('document:mousemove', ['$event'])
  onMouseMove(e: MouseEvent) {
      if (!this.isResizingSidebar && !this.isResizingContent) return;
      e.preventDefault();
      // 使用 rAF 节流，避免每个 mousemove 都触发布局计算
      if (this.resizeRafId) return;
      const clientX = e.clientX;
      this.resizeRafId = requestAnimationFrame(() => {
          this.resizeRafId = 0;
          if (this.isResizingSidebar) {
              const delta = clientX - this.startX;
              const newWidth = Math.max(200, Math.min(600, this.startWidth + delta));
              this.uiState.sidebarWidth.set(newWidth);
          } else if (this.isResizingContent) {
              const delta = clientX - this.startX;
              const deltaPercent = (delta / this.mainContentWidth) * 100;
              const newRatio = Math.max(25, Math.min(75, this.startRatio + deltaPercent));
              this.uiState.textColumnRatio.set(newRatio);
          }
      });
  }

  @HostListener('document:mouseup')
  onMouseUp() {
      if (this.isResizingSidebar || this.isResizingContent) {
          if (this.resizeRafId) {
              cancelAnimationFrame(this.resizeRafId);
              this.resizeRafId = 0;
          }
          this.isResizingSidebar = false;
          this.isResizingContent = false;
          this.uiState.isResizing.set(false);
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
      }
  }

  /** 重试启动会话 */
  retryBootstrap() {
    this.authCoord.retryBootstrap();
  }

  async handleLogin(event?: Event, opts?: { closeSettings?: boolean }) {
    await this.authCoord.handleLogin(event, opts);
  }

  async handleSignup(event?: Event) {
    await this.authCoord.handleSignup(event);
  }

  async handleResetPassword(event?: Event) {
    await this.authCoord.handleResetPassword(event);
  }

  switchToSignup() { this.authCoord.switchToSignup(); }
  switchToLogin() { this.authCoord.switchToLogin(); }
  switchToResetPassword() { this.authCoord.switchToResetPassword(); }

async signOut() {
    this.destroySyncPulse();
    await this.authCoord.signOut();
    this.projectCoord.clearState();
    this.unifiedSearchQuery.set('');
  }

  startRelogin() {
    this.authCoord.startRelogin();
  }

  selectProject(id: string) { this.projectCoord.selectProject(id, this.isSidebarOpen); }
  onProjectCardClick(event: MouseEvent, projectId: string) { this.projectCoord.onProjectCardClick(event, projectId); }
  @HostListener('document:click', ['$event'])
  onGlobalClick(event: MouseEvent) { this.projectCoord.handleGlobalClick(event); }
  enterProject(id: string) { this.projectCoord.enterProject(id, this.isSidebarOpen); }
  handleProjectDoubleClick(id: string, event: MouseEvent) { this.projectCoord.handleProjectDoubleClick(id, event, this.isSidebarOpen); }
  startRenameProject(projectId: string, currentName: string, event: Event) { this.projectCoord.startRenameProject(projectId, currentName, event); }
  executeRenameProject() { this.projectCoord.executeRenameProject(); }
  cancelRenameProject() { this.projectCoord.cancelRenameProject(); }
  onRenameKeydown(event: KeyboardEvent) { this.projectCoord.onRenameKeydown(event); }
  projectDraft(projectId: string) { return this.projectCoord.projectDraft(projectId); }
  updateProjectDraft(projectId: string, field: 'description' | 'createdDate', value: string) { this.projectCoord.updateProjectDraft(projectId, field, value); }
  saveProjectDetails(projectId: string) { this.projectCoord.saveProjectDetails(projectId); }
  createNewProject() { void this.openNewProjectModal(); }
  onFocusFlowNode(taskId: string) { this.projectCoord.onFocusFlowNode(taskId); }
  onSearchTaskClick(taskId: string, isParked: boolean): void {
    const projectId = this.taskStore.getTaskProjectId(taskId)
      ?? this.projectState.activeProjectId();
    if (projectId && projectId !== this.projectState.activeProjectId()) {
      this.projectState.setActiveProjectId(projectId);
    }

    if (isParked) {
      this.uiState.setParkingDockOpen(true);
      this.parkingService.previewTask(taskId);
      return;
    }

    this.onFocusFlowNode(taskId);
  }
  async confirmCreateProject(name: string, desc: string) { await this.projectCoord.confirmCreateProject(name, desc); }
  async confirmDeleteProject(projectId: string, projectName: string, event: Event) { await this.projectCoord.confirmDeleteProject(projectId, projectName, event); }
  async handleImportComplete(project: Project) { await this.projectCoord.handleImportComplete(project); }
  
  // ========== Modal methods (delegated to WorkspaceModalCoordinatorService) ==========

  async openSettings(): Promise<void> { await this.modalCoord.openSettings(); }
  closeSettings() { this.modalCoord.closeSettings(); }
  async openDashboardFromSettings(): Promise<void> { await this.modalCoord.openDashboardFromSettings(); }
  async openDashboard(): Promise<void> { await this.modalCoord.openDashboard(); }
  openConflictCenterFromDashboard() { this.modalCoord.openConflictCenterFromDashboard(); }
  async openLoginModal(): Promise<void> { await this.modalCoord.openLoginModal(); }
  async openTrashModal(): Promise<void> { await this.modalCoord.openTrashModal(); }
  async openConfigHelpModal(): Promise<void> { await this.modalCoord.openConfigHelpModal(); }
  async openNewProjectModal(): Promise<void> { await this.modalCoord.openNewProjectModal(); }
  async openMigrationModal(): Promise<void> { await this.modalCoord.openMigrationModal(); }
  async openErrorRecoveryModal(error: {
    title: string;
    message: string;
    details?: string;
    options: unknown[];
    defaultOptionId?: string;
    autoSelectIn?: number | null;
    resolve: (result: { optionId: string }) => void;
  }): Promise<void> { await this.modalCoord.openErrorRecoveryModal(error); }
  async openStorageEscapeModalImperative(): Promise<void> { await this.modalCoord.openStorageEscapeModalImperative(); }

  updateLayoutDirection(e: Event) {
    const val = (e.target as HTMLSelectElement).value as 'ltr' | 'rtl';
    this.uiState.layoutDirection.set(val);
  }
  
  updateFloatPref(e: Event) {
      const val = (e.target as HTMLSelectElement).value as 'auto' | 'fixed';
      this.uiState.floatingWindowPref.set(val);
  }
  
  updateTheme(theme: ThemeType) {
    // 使用 store 的 setTheme 方法，统一主题管理和云端同步
    void this.preferenceService.setTheme(theme);
  }

  updateFilter(e: Event) {
      this.uiState.filterMode.set((e.target as HTMLSelectElement).value);
  }
  
  // 适配 LoginModalComponent 事件 — 委托到 authCoord
  async handleLoginFromModal(data: { email: string; password: string }) {
    this.modalCoord.loginModalRef?.componentRef.setInput('isLoading', true);
    this.modalCoord.loginModalRef?.componentRef.setInput('authError', null);

    await this.authCoord.handleLoginFromModal(data);

    if (!this.authCoord.authError()) {
      // 登录成功：关闭模态框并导航
      this.modalCoord.closeLoginModal();
      this.modalCoord.navigateAfterLogin();
    } else {
      // 登录失败：回显错误并恢复按钮
      this.modalCoord.loginModalRef?.componentRef.setInput('isLoading', false);
      this.modalCoord.loginModalRef?.componentRef.setInput('authError', this.authCoord.authError());
    }
  }
  async handleSignupFromModal(data: { email: string; password: string; confirmPassword: string }) {
    this.modalCoord.loginModalRef?.componentRef.setInput('isLoading', true);
    this.modalCoord.loginModalRef?.componentRef.setInput('authError', null);

    await this.authCoord.handleSignupFromModal(data);

    if (!this.authCoord.authError() && this.currentUserId()) {
      // 注册成功（无需确认）：关闭模态框
      this.modalCoord.closeLoginModal();
    } else {
      // 注册失败或需要邮件确认：回显状态
      this.modalCoord.loginModalRef?.componentRef.setInput('isLoading', false);
      this.modalCoord.loginModalRef?.componentRef.setInput('authError', this.authCoord.authError());
    }
  }
  async handleResetPasswordFromModal(email: string) {
    this.modalCoord.loginModalRef?.componentRef.setInput('isLoading', true);
    this.modalCoord.loginModalRef?.componentRef.setInput('authError', null);

    await this.authCoord.handleResetPasswordFromModal(email);

    this.modalCoord.loginModalRef?.componentRef.setInput('isLoading', false);
    this.modalCoord.loginModalRef?.componentRef.setInput('authError', this.authCoord.authError());
    this.modalCoord.loginModalRef?.componentRef.setInput('resetPasswordSent', this.authCoord.resetPasswordSent());
  }
  handleLocalModeFromModal() {
    this.authCoord.handleLocalModeFromModal();
    this.modalCoord.closeLoginModal();
  }

  handleMigrationComplete() {
    this.authCoord.handleMigrationComplete();
  }
  closeMigrationModal() {
    this.authCoord.closeMigrationModal();
  }

  // 【P2-31 修复】resize 防抖定时器
  private resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  @HostListener('window:resize')
  checkMobile() {
    if (typeof window === 'undefined') return;
    
    if (this.resizeDebounceTimer) clearTimeout(this.resizeDebounceTimer);
    this.resizeDebounceTimer = setTimeout(() => {
      const nextIsMobile = window.innerWidth < 768; // Tailwind md breakpoint
      const shouldCloseSidebar = shouldAutoCloseSidebarOnViewportChange(
        this.previousViewportIsMobile,
        nextIsMobile
      );

      if (this.uiState.isMobile() !== nextIsMobile) {
        this.uiState.isMobile.set(nextIsMobile);
      }

      if (shouldCloseSidebar) {
        this.isSidebarOpen.set(false);
      }

      this.previousViewportIsMobile = nextIsMobile;
    }, 150);
  }
  
  // ========== 统一搜索方法 ==========
  
  /**
   * 处理统一搜索输入变化
   * 同时更新项目和任务搜索（带防抖）
   */
  onUnifiedSearchInput(event: Event): void {
    this.onUnifiedSearchChange(readTextInputValue(event));
  }

  onRenameProjectNameInput(event: Event): void {
    this.projectCoord.renameProjectName.set(readTextInputValue(event));
  }

  onProjectDescriptionInput(projectId: string, event: Event): void {
    this.updateProjectDraft(projectId, 'description', readTextInputValue(event));
  }

  onUnifiedSearchChange(query: string) {
    // 立即更新显示值
    this.unifiedSearchQuery.set(query);
    
    // 防抖更新实际搜索
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }
    
    this.searchDebounceTimer = setTimeout(() => {
      // 同步到两个搜索 signal
      this.uiState.projectSearchQuery.set(query);
      this.uiState.searchQuery.set(query);
      this.searchDebounceTimer = null;
    }, this.SEARCH_DEBOUNCE_DELAY);
  }
  
  /**
   * 清除统一搜索
   */
  clearUnifiedSearch() {
    this.unifiedSearchQuery.set('');
    this.uiState.clearSearch();
  }
}
