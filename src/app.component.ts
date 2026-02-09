import { Component, inject, signal, HostListener, computed, OnInit, OnDestroy, DestroyRef, effect, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  ActivatedRoute,
  Router,
  NavigationEnd,
  RouterOutlet
} from '@angular/router';
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
import { ModalService, type DeleteProjectData, type ConflictData, type LoginData } from './services/modal.service';
import { DynamicModalService } from './services/dynamic-modal.service';
import { SyncCoordinatorService } from './services/sync-coordinator.service';
import { SupabaseClientService } from './services/supabase-client.service';
import { SimpleSyncService } from './app/core/services/simple-sync.service';
import { SearchService } from './services/search.service';
import { BeforeUnloadManagerService } from './services/before-unload-manager.service';
import { ModalLoaderService } from './app/core/services/modal-loader.service';
import { BeforeUnloadGuardService } from './services/guards';
import { AppAuthCoordinatorService } from './app/core/services/app-auth-coordinator.service';
import { AppProjectCoordinatorService } from './app/core/services/app-project-coordinator.service';
import { ToastContainerComponent } from './app/shared/components/toast-container.component';
import { SyncStatusComponent } from './app/shared/components/sync-status.component';
import { OfflineBannerComponent } from './app/shared/components/offline-banner.component';
import { DemoBannerComponent } from './app/shared/components/demo-banner.component';
import type { StorageEscapeData } from './app/shared/modals';
import { ErrorBoundaryComponent } from './app/shared/components/error-boundary.component';
import { FormsModule } from '@angular/forms';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs/operators';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ThemeType, Project } from './models';
import { UI_CONFIG } from './config';
import { FocusModeComponent } from './app/features/focus/focus-mode.component';
import { SpotlightTriggerComponent } from './app/features/focus/components/spotlight/spotlight-trigger.component';
import { shouldAutoCloseSidebarOnViewportChange } from './utils/layout-stability';
import { ExportService } from './services/export.service';
import { StorageQuotaService } from './services/storage-quota.service';
import { IndexedDBHealthService } from './services/indexeddb-health.service';

/**
 * 应用根组件
 * 
 * 认证逻辑委托到 AppAuthCoordinatorService
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterOutlet,
    ToastContainerComponent,
    SyncStatusComponent,
    OfflineBannerComponent,
    DemoBannerComponent,
    ErrorBoundaryComponent,
    // 【性能优化 2026-02-07】FocusMode 和 SpotlightTrigger 改为 @defer 懒加载
    // 从 imports 移除，仅在模板 @defer 块中引用，由 Angular 自动 code-split
    // FocusModeComponent,       → @defer (on idle) in template
    // SpotlightTriggerComponent, → @defer (on idle) in template
  ],
  templateUrl: './app.component.html',
})

export class AppComponent implements OnInit, OnDestroy {
  
  public throwTestError(): void {
    throw new Error("Sentry Test Error");
  }

  private readonly logger = inject(LoggerService).category('App');
  private readonly uiState = inject(UiStateService);
  private readonly projectState = inject(ProjectStateService);
  private readonly taskOpsAdapter = inject(TaskOperationAdapterService);
  private readonly preferenceService = inject(PreferenceService);
  private readonly userSession = inject(UserSessionService);
  private readonly projectOps = inject(ProjectOperationService);
  private readonly searchService = inject(SearchService);

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
  undoService = inject(UndoService);
  swUpdate = inject(SwUpdate);
  toast = inject(ToastService);
  actionQueue = inject(ActionQueueService);
  errorHandler = inject(GlobalErrorHandler);
  modal = inject(ModalService);
  modalLoader = inject(ModalLoaderService);
  dynamicModal = inject(DynamicModalService);
  private syncCoordinator = inject(SyncCoordinatorService);
  readonly supabaseClient = inject(SupabaseClientService);
  private simpleSync = inject(SimpleSyncService);
  private beforeUnloadManager = inject(BeforeUnloadManagerService);
  private beforeUnloadGuard = inject(BeforeUnloadGuardService);
  
  /** 数据保护服务 */
  private readonly exportService = inject(ExportService);
  private readonly storageQuota = inject(StorageQuotaService);
  private readonly indexedDBHealth = inject(IndexedDBHealthService);
  
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  isSidebarOpen = signal(true);
  isFilterOpen = signal(false);
  
  /** 模态框加载中状态（按类型跟踪，提供按钮级别反馈） */
  readonly modalLoading = signal<Record<string, boolean>>({});
  
  /** 检查指定类型的模态框是否正在加载 */
  isModalLoading(type: string): boolean {
    return this.modalLoading()[type] ?? false;
  }
  
  private setModalLoading(type: string, loading: boolean): void {
    this.modalLoading.update(state => ({ ...state, [type]: loading }));
  }
  
  /** 存储失败逃生数据 */
  storageEscapeData = signal<StorageEscapeData | null>(null);
  showStorageEscapeModal = signal(false);
  
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
    const task = this.projectState.rootTasks().find(t => t.id === filterId);
    if (!task) return '全部任务';
    return task.title || task.displayId || '未命名任务';
  });

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
  
  // 搜索防抖定时器
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly SEARCH_DEBOUNCE_DELAY = 300; // 300ms 搜索防抖

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
  };
  
  ngOnInit() {
    this.setupRouteSync();

    // capture 阶段注册全局快捷键，避免被聚焦组件吞掉
    document.addEventListener('keydown', this.keyboardShortcutCaptureListener, { capture: true });
    
    // 标记应用已加载完成，用于隐藏初始加载指示器
    (window as unknown as { __NANOFLOW_READY__?: boolean }).__NANOFLOW_READY__ = true;
    
    // ⚡ 性能优化：延迟会话检查到浏览器空闲时段
    this.authCoord.scheduleSessionBootstrap();

    // 【性能审计 2026-02-07】延迟初始化同步服务，避免阻塞首屏渲染
    // SyncCoordinator 的重型副作用（处理器注册、定时器）延迟到首屏完成后
    setTimeout(() => this.syncCoordinator.initialize(), 100);
    
    // 🚀 空闲时预加载常用模态框（消除首次点击延迟）
    this.modalLoader.preloadCommonModals();
    
    // 🛡️ 数据保护：延迟初始化存储配额监控和 IndexedDB 健康检查
    setTimeout(() => {
      void this.storageQuota.initialize();
      void this.indexedDBHealth.initialize();
    }, 5000); // 延迟 5 秒，避免阻塞启动
  }
  
  /**
   * 信号 effect 集中注册（必须在构造函数中调用以确保注入上下文可用）
   * 
   * 背景：effect() 内部需要 inject(Injector)，若在 ngOnInit 等生命周期钩子中调用
   * 会抛出 NG0203: inject() must be called from an injection context
   */
  private setupSignalEffects(): void {
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
        // 保存 returnUrl（closeByType 会清除 ModalService 数据）
        const loginData = this.modal.getData('login') as LoginData | undefined;
        this._loginReturnUrl = loginData?.returnUrl ?? null;
        this.modal.closeByType('login'); // 清除旧状态
        // 防止重复打开（当前登录模态框已在显示中）
        if (!this._loginModalRef) {
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
    
    // 📦 数据保护：导出提醒（7 天未导出时 Toast 提示）
    effect(() => {
      const needsReminder = this.exportService.needsExportReminder();
      const userId = this.userSession.currentUserId();

      // 未登录时重置一次性提醒状态，避免用户切换后被错误拦截。
      if (!userId) {
        this._exportReminderShownForUser = null;
        return;
      }

      if (!needsReminder) {
        return;
      }

      // 防止 effect 因 Toast 内部 signal 读写被“反向订阅”，触发无限提示风暴。
      if (this._exportReminderShownForUser === userId) {
        return;
      }

      this._exportReminderShownForUser = userId;
      untracked(() => {
        this.toast.info(
          '数据备份提醒',
          '已超过 7 天未导出备份，建议前往设置导出数据。',
          { duration: 10000 }
        );
      });
    });
  }

  ngOnDestroy() {
    // DestroyRef 自动处理取消订阅，无需手动触发
    
    // 确保待处理的撤销操作被保存
    this.undoService.flushPendingAction();
    
    // 移除全局事件监听器
    window.removeEventListener('toggle-sidebar', this.handleToggleSidebar);
    document.removeEventListener('keydown', this.keyboardShortcutCaptureListener, { capture: true } as AddEventListenerOptions);
    
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
      
      this.storageEscapeData.set(escapeData);
      // 使用命令式方式打开存储逃生模态框
      void this.openStorageEscapeModalImperative();
    });
  }
  
  /**
   * 关闭存储逃生模态框
   */
  closeStorageEscapeModal(): void {
    this.showStorageEscapeModal.set(false);
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
      this._pendingConflict = { localProject, remoteProject, projectId };
      void this.openConflictModal({ localProject, remoteProject, projectId });
    });
  }
  
  /** 登录模态框引用（用于成功后关闭和动态更新 inputs） */
  private _loginModalRef: import('./services/dynamic-modal.service').ModalRef | null = null;
  /** 登录后的返回 URL（在 effect 清除 ModalService 状态前保存） */
  private _loginReturnUrl: string | null = null;
  /** 导出提醒一用户一次性展示，防止 signal 反馈循环导致 toast 风暴 */
  private _exportReminderShownForUser: string | null = null;

  /** 临时存储冲突数据 */
  private _pendingConflict: ConflictData | null = null;
  /** 冲突模态框引用 */
  private _conflictModalRef: import('./services/dynamic-modal.service').ModalRef | null = null;

  /**
   * 打开冲突解决模态框（命令式）
   */
  private async openConflictModal(data: ConflictData): Promise<void> {
    try {
      const component = await this.modalLoader.loadConflictModal();
      this._conflictModalRef = this.dynamicModal.open(component, {
        inputs: { conflictData: data },
        outputs: {
          resolveLocal: () => this.resolveConflictLocal(),
          resolveRemote: () => this.resolveConflictRemote(),
          resolveMerge: () => this.resolveConflictMerge(),
          cancel: () => this.cancelConflictResolution()
        },
        closeOnBackdropClick: false,
        closeOnEscape: false
      });
    } catch {
      this.toast.error('冲突解决组件加载失败', '请刷新页面重试');
    }
  }
  
  // 解决冲突：使用本地版本
  async resolveConflictLocal() {
    const data = this._pendingConflict;
    if (data) {
      await this.projectOps.resolveConflict(data.projectId, 'local');
    }
    this._conflictModalRef?.close({ choice: 'local' });
    this._pendingConflict = null;
    this._conflictModalRef = null;
  }
  
  // 解决冲突：使用远程版本
  async resolveConflictRemote() {
    const data = this._pendingConflict;
    if (data) {
      await this.projectOps.resolveConflict(data.projectId, 'remote');
    }
    this._conflictModalRef?.close({ choice: 'remote' });
    this._pendingConflict = null;
    this._conflictModalRef = null;
  }
  
  // 解决冲突：智能合并
  async resolveConflictMerge() {
    const data = this._pendingConflict;
    if (data) {
      await this.projectOps.resolveConflict(data.projectId, 'merge');
    }
    this._conflictModalRef?.close({ choice: 'merge' });
    this._pendingConflict = null;
    this._conflictModalRef = null;
  }
  
  // 取消冲突解决（稍后处理）
  cancelConflictResolution() {
    this._conflictModalRef?.close({ choice: 'cancel' });
    this._pendingConflict = null;
    this._conflictModalRef = null;
    this.toast.info('冲突待解决，下次同步时会再次提示');
  }
  
  private setupSwUpdateListener() {
    if (this.swUpdate.isEnabled) {
      this.swUpdate.versionUpdates
        .pipe(
          filter((evt): evt is VersionReadyEvent => evt.type === 'VERSION_READY'),
          takeUntilDestroyed(this.destroyRef)
        )
        .subscribe(() => {
          // 使用 ToastService 显示更新通知，带操作按钮
          this.toast.info(
            '🚀 发现新版本', 
            '软件有更新可用，点击刷新获取最新功能',
            {
              duration: 0, // 不自动关闭
              action: {
                label: '立即刷新',
                onClick: () => window.location.reload()
              }
            }
          );
        });
    }
  }

  // Resizing State
  isResizingSidebar = false;
  isResizingContent = false;
  private startX = 0;
  private startWidth = 0;
  private startRatio = 0;
  private mainContentWidth = 0;

  toggleSidebar() {
    this.isSidebarOpen.update(v => !v);
  }

  // --- Resizing Logic ---

  startSidebarResize(e: MouseEvent) {
      e.preventDefault();
      this.isResizingSidebar = true;
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
      if (this.isResizingSidebar) {
          e.preventDefault();
          const delta = e.clientX - this.startX;
          const newWidth = Math.max(200, Math.min(600, this.startWidth + delta));
          this.uiState.sidebarWidth.set(newWidth);
      } else if (this.isResizingContent) {
          e.preventDefault();
          const delta = e.clientX - this.startX;
          // Convert delta pixels to percentage
          const deltaPercent = (delta / this.mainContentWidth) * 100;
          // 限制在 25-75% 之间，避免极端情况
          const newRatio = Math.max(25, Math.min(75, this.startRatio + deltaPercent));
          this.uiState.textColumnRatio.set(newRatio);
      }
  }

  @HostListener('document:mouseup')
  onMouseUp() {
      if (this.isResizingSidebar || this.isResizingContent) {
          this.isResizingSidebar = false;
          this.isResizingContent = false;
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
  async confirmCreateProject(name: string, desc: string) { await this.projectCoord.confirmCreateProject(name, desc); }
  async confirmDeleteProject(projectId: string, projectName: string, event: Event) { await this.projectCoord.confirmDeleteProject(projectId, projectName, event); }
  async handleImportComplete(project: Project) { await this.projectCoord.handleImportComplete(project); }
  
  /**
   * 打开设置模态框（命令式加载，绕过 @defer 限制）
   * 
   * 修复：@defer when 是一次性触发器，加载失败后永远无法重试
   * 改用 ModalLoaderService 提供：重试、超时保护、缓存、按钮反馈
   */
  async openSettings(): Promise<void> {
    if (this.isModalLoading('settings')) return;
    this.setModalLoading('settings', true);
    try {
      const component = await this.modalLoader.loadSettingsModal();
      this.dynamicModal.open(component, {
        inputs: {
          sessionEmail: this.authCoord.sessionEmail(),
          projects: this.projects()
        },
        outputs: {
          close: () => this.closeSettings(),
          signOut: () => this.signOut(),
          themeChange: (theme: unknown) => this.updateTheme(theme as ThemeType),
          openDashboard: () => this.openDashboardFromSettings(),
          importComplete: (project: unknown) => this.handleImportComplete(project as Project)
        }
      });
    } catch {
      this.toast.error('设置面板加载失败', '请检查网络连接后重试');
    } finally {
      this.setModalLoading('settings', false);
    }
  }

  closeSettings() {
    this.dynamicModal.close();
    this.authCoord.isReloginMode.set(false);
  }

  /**
   * 从设置页打开仪表盘
   */
  async openDashboardFromSettings(): Promise<void> {
    this.dynamicModal.close(); // 先关闭设置
    await this.openDashboard();
  }
  
  /**
   * 打开仪表盘模态框
   */
  async openDashboard(): Promise<void> {
    if (this.isModalLoading('dashboard')) return;
    this.setModalLoading('dashboard', true);
    try {
      const component = await this.modalLoader.loadDashboardModal();
      this.dynamicModal.open(component, {
        outputs: {
          close: () => this.dynamicModal.close(),
          openConflictCenter: () => this.openConflictCenterFromDashboard()
        }
      });
    } catch {
      this.toast.error('仪表盘加载失败', '请检查网络连接后重试');
    } finally {
      this.setModalLoading('dashboard', false);
    }
  }
  
  openConflictCenterFromDashboard() {
    this.dynamicModal.close(); // 先关闭仪表盘
    this.toast.info('冲突解决中心', '请从项目列表中选择有冲突的项目进行处理');
  }

  // ========== 命令式模态框打开方法（替代 @defer 模板方案）==========
  
  /**
   * 打开登录模态框
   */
  async openLoginModal(): Promise<void> {
    if (this.isModalLoading('login')) return;

    // 当登录入口不是由 Guard 触发时，至少保证登录成功后能回到项目页。
    if (!this._loginReturnUrl) {
      this._loginReturnUrl = this.router.url && this.router.url !== '/' ? this.router.url : '/projects';
    }

    this.setModalLoading('login', true);
    try {
      const component = await this.modalLoader.loadLoginModal();
      this._loginModalRef = this.dynamicModal.open(component, {
        inputs: {
          authError: this.authCoord.authError(),
          isLoading: this.authCoord.isAuthLoading(),
          resetPasswordSent: this.authCoord.resetPasswordSent()
        },
        outputs: {
          close: () => { this._loginModalRef = null; },
          login: (data: unknown) => this.handleLoginFromModal(data as { email: string; password: string }),
          signup: (data: unknown) => this.handleSignupFromModal(data as { email: string; password: string; confirmPassword: string }),
          resetPassword: (email: unknown) => this.handleResetPasswordFromModal(email as string),
          localMode: () => this.handleLocalModeFromModal()
        },
        closeOnBackdropClick: false,
        closeOnEscape: false
      });
    } catch {
      this.toast.error('登录组件加载失败', '请检查网络连接后重试');
    } finally {
      this.setModalLoading('login', false);
    }
  }
  
  /**
   * 打开回收站模态框
   */
  async openTrashModal(): Promise<void> {
    if (this.isModalLoading('trash')) return;
    this.setModalLoading('trash', true);
    try {
      const component = await this.modalLoader.loadTrashModal();
      this.dynamicModal.open(component, {
        inputs: { show: true },
        outputs: {
          close: () => this.dynamicModal.close()
        }
      });
    } catch {
      this.toast.error('回收站加载失败', '请检查网络连接后重试');
    } finally {
      this.setModalLoading('trash', false);
    }
  }
  
  /**
   * 打开配置帮助模态框
   */
  async openConfigHelpModal(): Promise<void> {
    if (this.isModalLoading('configHelp')) return;
    this.setModalLoading('configHelp', true);
    try {
      const component = await this.modalLoader.loadConfigHelpModal();
      this.dynamicModal.open(component, {
        outputs: {
          close: () => this.dynamicModal.close()
        }
      });
    } catch {
      this.toast.error('配置帮助加载失败', '请检查网络连接后重试');
    } finally {
      this.setModalLoading('configHelp', false);
    }
  }
  
  /**
   * 打开新建项目模态框
   */
  async openNewProjectModal(): Promise<void> {
    if (this.isModalLoading('newProject')) return;
    this.setModalLoading('newProject', true);
    try {
      const component = await this.modalLoader.loadNewProjectModal();
      this.dynamicModal.open(component, {
        outputs: {
          close: () => this.dynamicModal.close(),
          confirm: (data: unknown) => {
            const { name, description } = data as { name: string; description: string };
            this.dynamicModal.close();
            void this.confirmCreateProject(name, description);
          }
        }
      });
    } catch {
      this.toast.error('新建项目组件加载失败', '请检查网络连接后重试');
    } finally {
      this.setModalLoading('newProject', false);
    }
  }
  
  /**
   * 打开迁移模态框
   */
  async openMigrationModal(): Promise<void> {
    if (this.isModalLoading('migration')) return;
    this.setModalLoading('migration', true);
    try {
      const component = await this.modalLoader.loadMigrationModal();
      this.dynamicModal.open(component, {
        outputs: {
          close: () => { this.dynamicModal.close(); this.closeMigrationModal(); },
          migrated: () => { this.dynamicModal.close(); this.handleMigrationComplete(); }
        },
        closeOnBackdropClick: false,
        closeOnEscape: false
      });
    } catch {
      this.toast.error('迁移组件加载失败', '请检查网络连接后重试');
    } finally {
      this.setModalLoading('migration', false);
    }
  }
  
  /**
   * 打开错误恢复模态框
   */
  async openErrorRecoveryModal(error: {
    title: string;
    message: string;
    details?: string;
    options: unknown[];
    defaultOptionId?: string;
    autoSelectIn?: number | null;
    resolve: (result: { optionId: string }) => void;
  }): Promise<void> {
    try {
      const component = await this.modalLoader.loadErrorRecoveryModal();
      this.dynamicModal.open(component, {
        inputs: {
          title: error.title,
          message: error.message,
          details: error.details,
          options: error.options,
          defaultOptionId: error.defaultOptionId,
          autoSelectIn: error.autoSelectIn ?? null
        },
        outputs: {
          select: (event: unknown) => {
            error.resolve(event as { optionId: string });
            this.dynamicModal.close();
          },
          close: () => {
            this.errorHandler.dismissRecoveryDialog();
            this.dynamicModal.close();
          }
        },
        closeOnBackdropClick: false,
        closeOnEscape: false
      });
    } catch {
      this.toast.error('错误恢复组件加载失败', '请刷新页面重试');
      this.errorHandler.dismissRecoveryDialog();
    }
  }
  
  /**
   * 打开存储逃生模态框
   */
  async openStorageEscapeModalImperative(): Promise<void> {
    const data = this.storageEscapeData();
    if (!data) return;
    try {
      const component = await this.modalLoader.loadStorageEscapeModal();
      this.dynamicModal.open(component, {
        inputs: {
          show: true,
          data: data
        },
        outputs: {
          close: () => {
            this.closeStorageEscapeModal();
            this.dynamicModal.close();
          }
        },
        closeOnBackdropClick: false,
        closeOnEscape: false
      });
    } catch {
      this.toast.error('存储逃生组件加载失败', '请刷新页面重试');
    }
  }

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
    this._loginModalRef?.componentRef.setInput('isLoading', true);
    this._loginModalRef?.componentRef.setInput('authError', null);

    await this.authCoord.handleLoginFromModal(data);

    if (!this.authCoord.authError()) {
      // 登录成功：关闭模态框并导航
      this.navigateAfterLogin();
      this.closeLoginModal();
    } else {
      // 登录失败：回显错误并恢复按钮
      this._loginModalRef?.componentRef.setInput('isLoading', false);
      this._loginModalRef?.componentRef.setInput('authError', this.authCoord.authError());
    }
  }
  async handleSignupFromModal(data: { email: string; password: string; confirmPassword: string }) {
    this._loginModalRef?.componentRef.setInput('isLoading', true);
    this._loginModalRef?.componentRef.setInput('authError', null);

    await this.authCoord.handleSignupFromModal(data);

    if (!this.authCoord.authError() && this.currentUserId()) {
      // 注册成功（无需确认）：关闭模态框
      this.closeLoginModal();
    } else {
      // 注册失败或需要邮件确认：回显状态
      this._loginModalRef?.componentRef.setInput('isLoading', false);
      this._loginModalRef?.componentRef.setInput('authError', this.authCoord.authError());
    }
  }
  async handleResetPasswordFromModal(email: string) {
    this._loginModalRef?.componentRef.setInput('isLoading', true);
    this._loginModalRef?.componentRef.setInput('authError', null);

    await this.authCoord.handleResetPasswordFromModal(email);

    this._loginModalRef?.componentRef.setInput('isLoading', false);
    this._loginModalRef?.componentRef.setInput('authError', this.authCoord.authError());
    this._loginModalRef?.componentRef.setInput('resetPasswordSent', this.authCoord.resetPasswordSent());
  }
  handleLocalModeFromModal() {
    this.authCoord.handleLocalModeFromModal();
    this.closeLoginModal();
  }

  /** 关闭登录模态框并清理引用 */
  private closeLoginModal(): void {
    if (this._loginModalRef) {
      this._loginModalRef.close();
      this._loginModalRef = null;
    }
  }

  /** 登录成功后导航到 returnUrl（由 auth guard 保存） */
  private navigateAfterLogin(): void {
    const returnUrl = this._loginReturnUrl && this._loginReturnUrl !== '/'
      ? this._loginReturnUrl
      : '/projects';
    this._loginReturnUrl = null;
    if (this.router.url !== returnUrl) {
      void this.router.navigateByUrl(returnUrl).catch(error => {
        this.logger.warn('登录后路由导航失败', { returnUrl, error });
      });
    }
  }

  handleMigrationComplete() {
    this.authCoord.handleMigrationComplete();
  }
  closeMigrationModal() {
    this.authCoord.closeMigrationModal();
  }

  @HostListener('window:resize')
  checkMobile() {
    if (typeof window === 'undefined') return;

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
  }
  
  // ========== 统一搜索方法 ==========
  
  /**
   * 处理统一搜索输入变化
   * 同时更新项目和任务搜索（带防抖）
   */
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
