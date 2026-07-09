import { 
  Component, 
  Injector,
  inject, 
  signal, 
  computed,
  OnInit, 
  OnDestroy,
  HostListener,
  DestroyRef,
  ChangeDetectionStrategy
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterOutlet, NavigationEnd } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter, startWith } from 'rxjs/operators';
import { UiStateService } from '../../../services/ui-state.service';
import { ProjectStateService } from '../../../services/project-state.service';
import { TaskOperationAdapterService } from '../../../services/task-operation-adapter.service';
import { SyncCoordinatorService } from '../../../services/sync-coordinator.service';
import { ToastService } from '../../../services/toast.service';
import { TabSyncService } from '../../../services/tab-sync.service';
import { UserSessionService } from '../../../services/user-session.service';
import { FlowCommandService } from '../../features/flow/services/flow-command.service';
import { ModalLoaderService } from '../services/modal-loader.service';
import { LoggerService } from '../../../services/logger.service';
import { DynamicModalService } from '../../../services/dynamic-modal.service';
import { AppProjectCoordinatorService } from '../services/app-project-coordinator.service';
import { DockEngineService } from '../../../services/dock-engine.service';
import { LocalBackupService } from '../../../services/local-backup.service';
// 【重要】@defer 使用的组件必须直接引用源文件，禁止走 barrel（index.ts）
// barrel 会把所有子组件一起 re-export，导致 esbuild 代码分割时 AOT 元数据丢失，
// 触发运行时 JIT 编译失败（TextStageCardComponent / FlowView 等）
import { TextViewComponent } from '../../features/text/components/text-view.component';
import { FlowViewComponent } from '../../features/flow/components/flow-view.component';
// @defer 使用的组件：直接引用源文件（同上理由）
import { ParkingDockComponent } from '../../features/parking/parking-dock.component';
import { ParkingNoticeComponent } from '../../features/parking/parking-notice.component';
import { FEATURE_FLAGS } from '../../../config/feature-flags.config';
import { HandoffCoordinatorService } from '../../../services/handoff-coordinator.service';
import { LaunchSnapshotService } from '../../../services/launch-snapshot.service';
import { createProjectShellDockTakeoverViewModel } from './project-shell-dock-takeover-view-model';
import { ProjectShellContentResizeController } from './project-shell-content-resize.controller';
import { ProjectShellRouteController } from './project-shell-route.controller';
import { ProjectShellCacheReloadController } from './project-shell-cache-reload.controller';
import { ProjectShellTextViewSwipeController } from './project-shell-text-view-swipe.controller';
import { resolveWorkspaceFilterLabel } from './workspace-shell-filter-label.helpers';

/**
 * 项目视图外壳组件
 * 负责管理 text-view 和 flow-view 的切换显示
 * 对应路由: /projects/:projectId, /projects/:projectId/text, /projects/:projectId/flow
 * 
 * 【移动端策略】
 * 使用 @if 条件渲染完全销毁/重建 FlowView 组件。
 * 好处：
 * - 释放 GoJS canvas 占用的内存
 * - 避免僵尸模式下的 canvas 渲染问题
 * - 简化代码，无需手动 suspend/resume
 * 
 * 【Flow 加载策略】
 * 桌面端和移动端都通过 @defer 按需挂载 FlowView，保持 GoJS 运行时代码懒加载。
 * 移动端切回文本时销毁 FlowView，释放 GoJS canvas 占用。
 * Shell 通过 FlowCommandService 与 FlowView 解耦通信。
 */
@Component({
  selector: 'app-project-shell',
  standalone: true,
  // 【P2-22 修复】添加 OnPush 变更检测策略
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TextViewComponent, FlowViewComponent, RouterOutlet, ParkingDockComponent, ParkingNoticeComponent],
  styleUrl: './project-shell.component.css',
  templateUrl: './project-shell.component.html'
})
export class ProjectShellComponent implements OnInit, OnDestroy {
  readonly uiState = inject(UiStateService);
  readonly projectState = inject(ProjectStateService);
  private readonly dockEngine = inject(DockEngineService);
  private readonly dockTakeover = createProjectShellDockTakeoverViewModel({
    focusMode: this.dockEngine.focusMode,
    phase: this.dockEngine.focusChromePhase,
    scrimOn: this.dockEngine.focusScrimOn,
  });
  readonly dockTakeoverPhase = this.dockTakeover.phase;
  readonly dockTakeoverMainHidden = this.dockTakeover.mainHidden;
  readonly dockTakeoverMainDimmed = this.dockTakeover.mainDimmed;
  readonly dockTakeoverMainNonInteractive = this.dockTakeover.mainNonInteractive;
  readonly dockTakeoverMainOpacity = this.dockTakeover.mainOpacity;
  readonly dockTakeoverMainFilter = this.dockTakeover.mainFilter;
  readonly dockTakeoverMainTransform = this.dockTakeover.mainTransform;
  readonly dockTakeoverMainTransition = this.dockTakeover.mainTransition;
  private readonly injector = inject(Injector);
  private readonly taskOpsAdapter = {
    addFloatingTask: (...args: Parameters<TaskOperationAdapterService['addFloatingTask']>) =>
      this.injector.get(TaskOperationAdapterService).addFloatingTask(...args),
  };
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private toast = inject(ToastService);
  private tabSync = inject(TabSyncService);
  private readonly userSession = inject(UserSessionService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private readonly modalLoader = inject(ModalLoaderService);
  private readonly dynamicModal = inject(DynamicModalService);
  private readonly projectCoord = inject(AppProjectCoordinatorService);
  private readonly localBackupService = inject(LocalBackupService);
  private readonly handoffCoordinator = inject(HandoffCoordinatorService);
  private readonly launchSnapshot = inject(LaunchSnapshotService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ProjectShell');
  private readonly cacheReload = new ProjectShellCacheReloadController({
    logger: this.logger,
  });
  private readonly destroyRef = inject(DestroyRef);
  private readonly startupLaunchSnapshot = this.launchSnapshot.read();
  
  // 使用 FlowCommandService 替代 ViewChild，保持 Shell 与 FlowView 解耦
  // Shell 通过命令服务发布意图，FlowView 订阅并响应
  private readonly flowCommand = inject(FlowCommandService);
  private readonly flowIntentLazyLoadEnabled = FEATURE_FLAGS.FLOW_INTENT_LAZYLOAD_V1;
  private readonly flowStateAwareRestoreEnabled = FEATURE_FLAGS.FLOW_STATE_AWARE_RESTORE_V2;
  
  // UI 状态
  isFilterOpen = signal(false);
  readonly flowIntentActivated = signal(!FEATURE_FLAGS.FLOW_INTENT_LAZYLOAD_V1);
  readonly flowPrefetchOnlyActivated = signal(false);
  readonly shouldLoadFlowNow = computed(() =>
    !this.flowIntentLazyLoadEnabled || this.flowIntentActivated()
  );
  readonly shouldPrefetchFlowChunk = computed(() =>
    this.shouldLoadFlowNow() || this.flowPrefetchOnlyActivated()
  );
  // 使用 uiState.activeView 代替本地的 mobileActiveView，使其他组件可以访问当前视图状态
  
  private readonly contentResize = new ProjectShellContentResizeController(this.uiState);
  readonly collapseAnimating = this.contentResize.collapseAnimating;
  private readonly routeController = new ProjectShellRouteController({
    route: this.route,
    router: this.router,
    handoffCoordinator: this.handoffCoordinator,
    startupLaunchSnapshot: this.startupLaunchSnapshot,
    flowStateAwareRestoreEnabled: this.flowStateAwareRestoreEnabled,
    flowIntentActivated: () => this.flowIntentActivated(),
    flowPrefetchOnlyActivated: this.flowPrefetchOnlyActivated,
    uiState: this.uiState,
    projectState: this.projectState,
    syncCoordinator: this.syncCoordinator,
    userSession: this.userSession,
    tabSync: this.tabSync,
    toast: this.toast,
    taskOpsAdapter: this.taskOpsAdapter,
    flowCommand: this.flowCommand,
    activateFlowIntent: source => this.activateFlowIntent(source),
  });
  private readonly textViewSwipe = new ProjectShellTextViewSwipeController({
    isMobile: () => this.uiState.isMobile(),
    switchToFlow: () => this.switchToFlow(),
  });
  
  // 【P2-23 修复】从普通方法改为 computed() 避免每次变更检测重复遍历
  currentFilterLabel = computed(() => {
    return resolveWorkspaceFilterLabel({
      filterId: this.uiState.filterMode(),
      getTask: taskId => this.projectState.getTask(taskId),
    });
  });
  
  ngOnInit() {
    this.localBackupService.setProjectsProvider(() => this.projectState.getProjectsWithCurrentData());
    // 【P2-38 修复】使用 NavigationEnd 事件统一处理路由变化
    // 父子路由结构下，projectId 在 this.route.params，taskId 在 firstChild.params
    // 通过 Router.events 可以同时捕获父路由和子路由的变化
    this.router.events.pipe(
      filter(event => event instanceof NavigationEnd),
      startWith(null), // 初始化时也触发一次
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(() => {
      this.routeController.handleRouteChange();
    });
  }

  /**
   * Flow 视图意图触发器
   * 默认只在用户有明确意图时加载 GoJS 大块代码
   */
  activateFlowIntent(source: 'click' | 'route' | 'deeplink' | 'restore-idle'): void {
    if (!this.flowIntentLazyLoadEnabled || this.flowIntentActivated()) {
      return;
    }

    this.flowIntentActivated.set(true);
    this.flowPrefetchOnlyActivated.set(false);
    this.logger.debug('Flow lazy-load intent activated', { source });
  }
  
  ngOnDestroy() {
    this.textViewSwipe.destroy();
    this.routeController.destroy();
    this.contentResize.cleanup();
  }
  
  // ========== 视图切换 ==========
  
  /**
   * 切换到流程图视图
   * 移动端：使用条件渲染，FlowView 组件会被完全销毁/重建
   */
  switchToFlow() {
    this.routeController.cancelFlowStateAwareTimers();
    this.activateFlowIntent('click');
    this.routeController.setActiveView('flow');
  }
  
  switchToText() {
    this.logger.debug('switchToText 被调用');
    this.routeController.cancelFlowStateAwareTimers();
    this.routeController.setActiveView('text');
  }
  
  // ========== 侧边栏控制 ==========
  
  toggleSidebar() {
    // 通过事件通知父组件切换侧边栏
    // 移动端和桌面端都使用全局事件来控制侧边栏
    window.dispatchEvent(new CustomEvent('toggle-sidebar'));
  }

  toggleDockFocusSession(): void {
    window.dispatchEvent(new CustomEvent('dock-focus-session-toggle'));
  }

  // ========== 文本栏折叠控制（桌面端） ==========

  /** 切换文本栏的折叠/展开状态 */
  toggleTextColumn() {
    this.uiState.isTextColumnCollapsed.update(v => !v);
  }

  /** 从折叠状态展开文本栏到最小可用宽度（25%） */
  expandTextColumnToMin() {
    this.uiState.textColumnRatio.set(25);
    this.uiState.isTextColumnCollapsed.set(false);
  }
  
  // ========== 流程图节点定位 ==========
  
  onFocusFlowNode(taskId: string) {
    if (!this.uiState.isMobile()) {
      this.activateFlowIntent('click');
      // 通过命令服务发送居中请求，无需检查 flowView 实例
      this.flowCommand.centerOnNode(taskId, false);
    }
  }
  
  startContentResize(e: MouseEvent) {
    this.contentResize.start(e);
  }

  @HostListener('document:mousemove', ['$event'])
  onMouseMove(e: MouseEvent) {
    this.contentResize.move(e);
  }
  
  @HostListener('document:mouseup')
  onMouseUp() {
    this.contentResize.end();
  }
  
  // ========== 文本视图滑动手势 ==========
  // 允许从文本视图向左滑动切换到流程图
  // 流程图视图不处理滑动手势，避免与画布操作冲突
  
  onTextViewTouchStart(e: TouchEvent) {
    this.textViewSwipe.onTouchStart(e);
  }
  
  onTextViewTouchMove(e: TouchEvent) {
    this.textViewSwipe.onTouchMove(e);
  }
  
  onTextViewTouchEnd(e: TouchEvent) {
    this.textViewSwipe.onTouchEnd(e);
  }
  
  // ========== 错误边界重试回调 ==========
  
  /**
   * 重试加载文本视图
   */
  retryTextView(): void {
    // 强制刷新当前视图
    this.routeController.setActiveView('text');
  }
  
  /**
   * 重试加载流程图视图
   * 移动端 FlowViewComponent 通过 @defer 延迟加载；桌面端直接向已挂载的 FlowView 发送重试命令。
   */
  retryFlowView(): void {
    // 触发流程图重新初始化
    this.activateFlowIntent('click');
    this.routeController.setActiveView('flow');
    // 通过命令服务发送重试命令
    // 命令会被缓存直到 FlowView 就绪
    this.flowCommand.retryDiagram();
  }
  
  /**
   * 打开新建项目模态框
   * 当没有活动项目时，点击占位区域触发
   */
  async openNewProjectModal(): Promise<void> {
    try {
      const component = await this.modalLoader.loadNewProjectModal();
      this.dynamicModal.open(component, {
        outputs: {
          close: () => this.dynamicModal.close(),
          confirm: (data: unknown) => {
            const { name, description } = data as { name: string; description: string };
            this.dynamicModal.close();
            void this.projectCoord.confirmCreateProject(name, description);
          }
        }
      });
    } catch (error) {
      this.toast.error('新建项目组件加载失败', '请检查网络连接后重试');
      this.logger.error('Failed to load new project modal', error);
    }
  }
  
  /**
   * 刷新页面 - 用于 @defer 加载失败时的恢复
   * 强制清除所有缓存并刷新，避免 Service Worker 再次返回过期/损坏的 chunk
   */
  reloadPage(): void {
    this.cacheReload.reloadPage();
  }
}
