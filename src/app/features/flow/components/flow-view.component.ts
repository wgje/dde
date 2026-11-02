import { Component, inject, signal, computed, effect, untracked, ElementRef, viewChild, AfterViewInit, OnDestroy, NgZone, HostListener, output, ChangeDetectionStrategy, Injector, EffectRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { LoggerService } from '../../../../services/logger.service';
import { FlowCommandService } from '../services/flow-command.service';
import { FlowDiagramService } from '../services/flow-diagram.service';
import type { FlowRelationDisplayMode } from '../services/flow-diagram-config.service';
import { FlowLogicExportService } from '../services/flow-logic-export.service';
import { FlowZoomService } from '../services/flow-zoom.service';
import { FlowSelectionService } from '../services/flow-selection.service';
import { FlowLayoutService } from '../services/flow-layout.service';
import { FlowDragDropService } from '../services/flow-drag-drop.service';
import { FlowTouchService } from '../services/flow-touch.service';
import { FlowLinkService } from '../services/flow-link.service';
import { FlowTaskOperationsService } from '../services/flow-task-operations.service';
import { FlowSwipeGestureService } from '../services/flow-swipe-gesture.service';
import { FlowCascadeAssignService } from '../services/flow-cascade-assign.service';
import { FlowKeyboardService } from '../services/flow-keyboard.service';
import { FlowPaletteResizeService } from '../services/flow-palette-resize.service';
import { FlowBatchDeleteService } from '../services/flow-batch-delete.service';
import { FlowSelectModeService } from '../services/flow-select-mode.service';
import { FlowMobileDrawerService } from '../services/flow-mobile-drawer.service';
import { FlowDiagramEffectsService } from '../services/flow-diagram-effects.service';
import { FlowEventRegistrationService } from '../services/flow-event-registration.service';
import { FlowViewCleanupService, CleanupResources } from '../services/flow-view-cleanup.service';
import { FlowDiagramRetryService } from '../services/flow-diagram-retry.service';
import { FlowUnassignedTouchDropController } from '../services/flow-unassigned-touch-drop.controller';
import { FlowViewCloudSaveService, type FlowCloudSaveResult } from '../services/flow-view-cloud-save.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { Task } from '../../../../models';
import { FlowToolbarComponent } from './flow-toolbar.component';
import { FlowPaletteComponent } from './flow-palette.component';
import { FlowTaskDetailComponent } from './flow-task-detail.component';
import { FlowDeleteConfirmComponent } from './flow-delete-confirm.component';
import { FlowLinkTypeDialogComponent } from './flow-link-type-dialog.component';
import { FlowConnectionEditorComponent, ConnectionEditorSavePayload } from './flow-connection-editor.component';
import { FlowLinkDeleteHintComponent } from './flow-link-delete-hint.component';
import { FlowLinkActionMenuComponent } from './flow-link-action-menu.component';
import { FlowCascadeAssignDialogComponent } from './flow-cascade-assign-dialog.component';
import { FlowBatchDeleteDialogComponent } from './flow-batch-delete-dialog.component';
import { FlowViewDiagramLifecycleController } from './flow-view-diagram-lifecycle.controller';
import { FlowViewLinkActionsController } from './flow-view-link-actions.controller';
import { FlowViewMobileInteractionController } from './flow-view-mobile-interaction.controller';
import { FlowViewNavigationController } from './flow-view-navigation.controller';
import { FlowTaskDetailOwnerTracker, FlowViewTaskDetailPersistenceController, type FlowTaskDetailOwner } from './flow-view-task-detail-persistence.controller';
import { MobileDrawerContainerComponent } from './mobile-drawer-container.component';
import { MobileTodoDrawerComponent } from './mobile-todo-drawer.component';
import { MobileBlackBoxDrawerComponent } from './mobile-black-box-drawer.component';
import { FlowRightPanelComponent } from './flow-right-panel.component';
import { FlowBatchToolbarComponent } from './flow-batch-toolbar.component';
import { FlowOverviewPanelComponent } from './flow-overview-panel.component';

import * as go from 'gojs';

/** 流程图视图组件 —— 模板渲染 + 子组件通信 + 服务协调 + 生命周期管理 */
@Component({
  selector: 'app-flow-view',
  standalone: true,
  imports: [
    CommonModule, 
    FormsModule,
    FlowToolbarComponent, 
    FlowPaletteComponent, 
    FlowTaskDetailComponent,
    FlowDeleteConfirmComponent,
    FlowLinkTypeDialogComponent,
    FlowConnectionEditorComponent,
    FlowLinkDeleteHintComponent,
    FlowLinkActionMenuComponent,
    FlowCascadeAssignDialogComponent,
    FlowBatchDeleteDialogComponent,
    MobileDrawerContainerComponent,
    MobileTodoDrawerComponent,
    MobileBlackBoxDrawerComponent,
    FlowRightPanelComponent,
    FlowBatchToolbarComponent,
    FlowOverviewPanelComponent
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./flow-view.component.scss'],
  templateUrl: './flow-view.component.html'
})
export class FlowViewComponent implements AfterViewInit, OnDestroy {
  readonly diagramDiv = viewChild<ElementRef>('diagramDiv');
  readonly legacyOverviewHost = signal<ElementRef | undefined>(undefined);
  readonly connectionEditor = viewChild(FlowConnectionEditorComponent);
  readonly goBackToText = output<void>();
  
  // ========== P2-1 迁移：直接注入子服务 ==========
  readonly uiState = inject(UiStateService);
  readonly projectState = inject(ProjectStateService);
  private readonly logger = inject(LoggerService).category('FlowView');
  private readonly zone = inject(NgZone);
  private readonly elementRef = inject(ElementRef);
  private readonly injector = inject(Injector);
  
  // 命令服务（解耦与 ProjectShellComponent 的通信）
  private readonly flowCommand = inject(FlowCommandService);
  readonly isFlowViewReady = this.flowCommand.isViewReady;
  
  // 核心服务
  readonly diagram = inject(FlowDiagramService);
  private readonly logicExport = inject(FlowLogicExportService);
  private readonly zoomService = inject(FlowZoomService);
  readonly selectionService = inject(FlowSelectionService);
  private readonly layoutService = inject(FlowLayoutService);
  readonly dragDrop = inject(FlowDragDropService);
  readonly touch = inject(FlowTouchService);
  readonly link = inject(FlowLinkService);
  readonly taskOps = inject(FlowTaskOperationsService);
  private readonly swipeGesture = inject(FlowSwipeGestureService);
  readonly cascadeAssign = inject(FlowCascadeAssignService);
  private readonly keyboard = inject(FlowKeyboardService);
  private readonly paletteResize = inject(FlowPaletteResizeService);
  readonly batchDelete = inject(FlowBatchDeleteService);
  readonly selectMode = inject(FlowSelectModeService);
  private readonly mobileDrawer = inject(FlowMobileDrawerService);
  private readonly diagramEffects = inject(FlowDiagramEffectsService);
  private readonly eventRegistration = inject(FlowEventRegistrationService);
  private readonly cleanup = inject(FlowViewCleanupService);
  private readonly diagramRetry = inject(FlowDiagramRetryService);
  private readonly cloudSave = inject(FlowViewCloudSaveService);

  private get taskOpsAdapter(): TaskOperationAdapterService {
    return this.injector.get(TaskOperationAdapterService);
  }
  
  // ========== 组件状态 ==========
  
  /** 选中的任务ID */
  readonly selectedTaskId = signal<string | null>(null);
  
  /** 关系降噪显示模式：all=全部关联线 / focused=仅当前任务关联 / hidden=隐藏跨树关联线 */
  readonly relationDisplayMode = signal<FlowRelationDisplayMode>('all');

  /** 删除确认状态 */
  readonly deleteConfirmTask = signal<Task | null>(null);
  readonly deleteKeepChildren = signal(false);
  
  /** 任务详情面板位置 */
  readonly taskDetailPos = signal<{ x: number; y: number }>({ x: -1, y: -1 });
  
  /** 调色板高度 - 移动端默认更小 */
  readonly paletteHeight = signal(this.uiState.isMobile() ? 80 : 180);
  
  /** 底部抽屉高度（vh） - 移动端顶部抽屉 */
  // 默认给一个安全值，真正的“最佳高度”由下面的 effect 在移动端动态校准。
  readonly drawerHeight = signal(this.uiState.isMobile() ? 8.62 : 25);
  /** 用户手动拖拽后，阻止预设高度覆盖，直到详情关闭 */
  readonly drawerManualOverride = signal(false);
  readonly isResizingDrawerSignal = signal(false);
  
  /** 是否正在重试加载图表（委托给 diagramRetry 服务） */
  readonly isRetryingDiagram = computed(() => this.diagramRetry.isRetrying());
  
  /** 是否已达到重试上限（委托给 diagramRetry 服务） */
  readonly hasReachedRetryLimit = computed(() => this.diagramRetry.hasReachedRetryLimit());
  
  /** 小地图状态 */
  readonly isOverviewVisible = signal(true);
  readonly isOverviewCollapsed = signal(false);

  /**
   * 小地图实现开关。true=新 SVG 自绘（FlowMinimapComponent）；false=旧 GoJS Overview。切此一处即回滚。
   */
  readonly useSvgMinimap = signal(true);
  
  /** 侧边栏（调色板）展开状态 */
  readonly isPaletteOpen = signal(true);
  
  /** 右侧滑出面板状态（移动端） */
  readonly isRightPanelOpen = signal(false);
  /** 详情面板布局版本：移动端页面/层切换后递增，驱动详情高度重测 */
  readonly detailLayoutTick = signal(0);
  
  /** 图表初始化重试次数 - 委托给 diagramRetry 服务管理 */
  
  /** 选中的任务对象 */
  readonly selectedTask = computed(() => {
    const id = this.selectedTaskId();
    if (!id) return null;
    return this.projectState.tasks().find(task => task.id === id) ?? null;
  });
  /** 移动端待分配拖拽会话是否仍处于活动状态。 */
  readonly hasPendingUnassignedTouchDrag = computed(() =>
    this.unassignedTouchDrop.hasPending
  );

  private readonly unassignedTouchDrop = new FlowUnassignedTouchDropController({
    dragDrop: this.dragDrop,
    getDiagramElement: () => this.diagramDiv()?.nativeElement ?? null,
    getDiagramInstance: () => this.diagram.diagramInstance,
    touch: this.touch,
    zone: this.zone,
  });
  
  // ========== 私有状态 ==========
  private isDestroyed = false;
  private deleteConfirmOwner: FlowTaskDetailOwner | null = null;
  private readonly taskDetailOwner = new FlowTaskDetailOwnerTracker({
    activeProjectId: () => this.projectState.activeProjectId(),
    activeTaskId: () => this.selectedTask()?.id ?? null,
    isTaskCurrent: (taskId, task) => this.projectState.tasks().some(current =>
      current.id === taskId && (!task || current === task)),
    retire: projectChanged => this.retireTaskDetailUi(projectChanged),
  });
  readonly taskDetailPersistence = new FlowViewTaskDetailPersistenceController(this.taskOps, this.taskDetailOwner);

  /** 【2026-02-24】所有通过组件 injector 创建的 EffectRef，ngOnDestroy 时主动销毁 */
  private readonly managedEffectRefs: EffectRef[] = [];

  /** 绑定的 saveToCloud 回调，传递给 toolbar 组件 */
  readonly saveToCloudBound = () => this.saveToCloud();
  
  /** 待清理的定时器 */
  private pendingTimers: ReturnType<typeof setTimeout>[] = [];

  private readonly mobileInteraction = new FlowViewMobileInteractionController({
    detailLayoutTick: this.detailLayoutTick,
    diagram: this.diagram,
    drawerHeight: this.drawerHeight,
    drawerManualOverride: this.drawerManualOverride,
    goBackToText: () => this.goBackToText.emit(),
    injector: this.injector,
    isPaletteOpen: this.isPaletteOpen,
    isRightPanelOpen: this.isRightPanelOpen,
    isDestroyed: () => this.isDestroyed,
    loggerDebug: (message, context) => this.logger.debug(message, context),
    scheduleTimer: this.scheduleTimer.bind(this),
    selectedTaskId: this.selectedTaskId,
    swipeGesture: this.swipeGesture,
    uiState: this.uiState,
  });

  private readonly navigation = new FlowViewNavigationController({
    centerOnNode: (taskId, openDetail) => this.flowCommand.centerOnNode(taskId, openDetail),
    getTask: taskId => this.projectState.getTask(taskId),
    warn: (message, context) => this.logger.warn(message, context),
  });

  private readonly linkActions = new FlowViewLinkActionsController({
    link: this.link,
    logger: this.logger,
    refreshDiagram: () => this.refreshDiagram(),
    getConnectionEditorSessionIdentity: () => this.connectionEditor()?.sessionIdentity() ?? null,
    closeConnectionEditor: () => this.link.closeConnectionEditor(),
    restoreConnectionEditorAfterSaveFailure: () => this.connectionEditor()?.resumeAfterSaveFailure(),
  });

  private readonly diagramLifecycle = new FlowViewDiagramLifecycleController({
    diagram: this.diagram,
    diagramRetry: this.diagramRetry,
    dragDrop: this.dragDrop,
    eventRegistration: this.eventRegistration,
    flowCommand: this.flowCommand,
    isOverviewCollapsed: this.isOverviewCollapsed,
    isOverviewVisible: this.isOverviewVisible,
    isPaletteOpen: this.isPaletteOpen,
    isMobile: () => this.uiState.isMobile(),
    logger: this.logger,
    overviewDiv: () => this.legacyOverviewHost(),
    diagramDiv: () => this.diagramDiv(),
    projectTasks: () => this.projectState.tasks(),
    scheduleTimer: this.scheduleTimer.bind(this),
    selectMode: this.selectMode,
    selectedTaskId: this.selectedTaskId,
    touch: this.touch,
    useSvgMinimap: this.useSvgMinimap,
    zone: this.zone,
    bumpDetailLayoutTick: () => this.bumpDetailLayoutTick(),
    expandDrawerToOptimalHeight: () => this.expandDrawerToOptimalHeight(),
    handleDeleteKeyPressed: () => this.handleDeleteKeyPressed(),
    handleDiagramDrop: (taskData, docPoint) => this.handleDiagramDrop(taskData, docPoint),
    isDestroyed: () => this.isDestroyed,
    refreshDiagram: () => this.refreshDiagram(),
    executeCenterOnNode: (taskId, openDetail) => this.executeCenterOnNode(taskId, openDetail),
  });
  
  @HostListener('window:resize')
  onWindowResize(): void {
    this.diagramLifecycle.handleResize();
  }
  
  @HostListener('window:orientationchange')
  onOrientationChange(): void {
    this.diagramLifecycle.handleOrientationChange();
  }
  
  constructor() {
    const setSelectedTaskId = this.selectedTaskId.set.bind(this.selectedTaskId);
    this.selectedTaskId.set = taskId => { setSelectedTaskId(taskId); this.taskDetailOwner.sync(); };
    this.managedEffectRefs.push(effect(() => {
      this.projectState.activeProjectId();
      this.selectedTask();
      untracked(() => this.taskDetailOwner.sync());
    }));
    this.setupDiagramEffects();
    this.setupMobileDrawerEffects();
    this.setupMobileViewSwitchEffect();
  }
  private setupDiagramEffects(): void {
    // 【2026-02-24 修复】isDestroyed 使用 getter 函数，避免 rAF 回调捕获过期布尔值
    const scheduleRaf = (tasks: Task[], forceUpdate: boolean) =>
      this.diagramEffects.scheduleRafDiagramUpdate(tasks, forceUpdate, () => this.isDestroyed);
    
    // 【2026-02-24 修复】收集所有 EffectRef，ngOnDestroy 中主动销毁以避免 @defer 拆除时竞态
    this.managedEffectRefs.push(
      this.diagramEffects.createTasksEffect(this.injector, scheduleRaf),
      this.diagramEffects.createConnectionsEffect(this.injector, scheduleRaf),
      this.diagramEffects.createExternalSourceLinksEffect(this.injector, scheduleRaf),
      this.diagramEffects.createSearchEffect(this.injector, scheduleRaf),
      this.diagramEffects.createThemeEffect(this.injector, scheduleRaf),
      this.diagramEffects.createSelectionSyncEffect(
        this.injector,
        this.selectedTaskId,
        (taskId: string) => this.selectionService.selectNodeWithRetry(taskId, this.scheduleTimer.bind(this))
      ),
      this.diagramEffects.createCenterCommandEffect(this.injector, this.executeCenterOnNode.bind(this)),
      this.diagramEffects.createRetryCommandEffect(this.injector, this.retryInitDiagram.bind(this)),
      this.diagramEffects.createRelationDisplayEffect(this.injector, this.relationDisplayMode, this.selectedTaskId),
    );
  }

  private setupMobileDrawerEffects(): void {
    this.managedEffectRefs.push(
      ...this.mobileDrawer.setupDrawerEffects(this.injector, {
        paletteHeight: () => this.paletteHeight(),
        drawerHeight: () => this.drawerHeight(),
        drawerManualOverride: this.drawerManualOverride,
        isResizingDrawerSignal: () => this.isResizingDrawerSignal(),
        selectedTaskId: () => this.selectedTaskId(),
        scheduleDrawerHeightUpdate: (vh) => this.mobileDrawer.scheduleDrawerHeightUpdate(this.drawerHeight, vh)
      })
    );
  }

  private setupMobileViewSwitchEffect(): void {
    this.managedEffectRefs.push(this.mobileInteraction.setupMobileViewSwitchEffect());
  }
  
  // ========== 生命周期 ==========
  
  ngAfterViewInit() {
    this.touch.activate();
    this.link.activate();
    this.diagramLifecycle.scheduleDiagramInit();
    this.mobileInteraction.bumpDetailLayoutTick();
  }
  
  ngOnDestroy() {
    this.isDestroyed = true;

    // 【2026-02-24 修复】主动销毁所有 effect，避免 @defer 拆除时 Angular 内部清理竞态
    // 必须在 Angular 拆除视图内部数据结构（LView/tView）之前完成
    for (const ref of this.managedEffectRefs) {
      ref.destroy();
    }
    this.managedEffectRefs.length = 0;

    // 通知服务组件销毁
    this.selectionService.markDestroyed();
    this.diagramRetry.resetState();

    const resources: CleanupResources = {
      pendingTimers: this.pendingTimers,
      pendingRetryRafIds: [],
      overviewResizeTimer: this.diagramLifecycle.getOverviewResizeTimer(),
      idleInitHandle: this.diagramRetry.getIdleInitHandle()
    };

    this.cleanup.performCleanup(
      resources,
      () => this.touch.uninstallDiagramDragGhostListeners(this.diagram.diagramInstance)
    );

    this.unassignedTouchDrop.removeGlobalListeners();
    this.diagramLifecycle.clearOverviewResizeTimer();
  }
  
  // ========== 图表初始化 ==========

  private scheduleDiagramInit(): void {
    this.diagramLifecycle.scheduleDiagramInit();
  }
  
  // ========== 小地图 ==========

  toggleOverviewCollapse(): void {
    this.diagramLifecycle.toggleOverviewCollapse();
  }

  onLegacyOverviewHostChange(host: ElementRef | undefined): void {
    this.legacyOverviewHost.set(host);
    this.diagramLifecycle.handleLegacyOverviewHostChange(host);
  }

  retryInitDiagram(): void {
    this.diagramLifecycle.retryInitDiagram();
  }
  
  /** 完全重置图表并重新初始化 */
  resetAndRetryDiagram(): void {
    this.diagramLifecycle.resetAndRetryDiagram();
  }
  
  // ========== 图表操作 ==========
  
  zoomIn(): void {
    this.zoomService.zoomIn();
  }
  
  zoomOut(): void {
    this.zoomService.zoomOut();
  }
  
  applyAutoLayout(): void {
    this.layoutService.applyAutoLayout();
  }

  /**
   * 关系降噪：循环切换关联线显示模式（全部 → 仅当前任务 → 隐藏 → 全部）。
   * 仅更新本地 signal，实际同步由构造函数中的 effect 完成；focused 模式持续跟随当前选中任务。
   */
  toggleRelationDisplayMode(): void {
    const nextMode: Record<FlowRelationDisplayMode, FlowRelationDisplayMode> = {
      all: 'focused',
      focused: 'hidden',
      hidden: 'all',
    };
    this.relationDisplayMode.update(current => nextMode[current]);
  }
  
  exportToPng(): void {
    this.diagram.exportToPng();
  }
  
  exportToSvg(): void {
    this.diagram.exportToSvg();
  }

  /** 导出 AI 战略审查 Markdown（主任务中心 + 洞察师 prompt） */
  exportStrategicReview(): void {
    this.logicExport.exportStrategicReview();
  }
  
  /** 保存当前项目到云端，返回 Promise 供 toolbar 组件复位按钮状态。 */
  async saveToCloud(): Promise<FlowCloudSaveResult> {
    return this.cloudSave.saveToCloud();
  }

  /** 居中到指定节点 */
  centerOnNode(taskId: string, openDetail: boolean = true): void {
    this.navigation.centerOnNode(taskId, openDetail);
  }
  
  private executeCenterOnNode(taskId: string, openDetail: boolean): void {
    if (!this.diagram.isInitialized) {
      this.logger.warn('图表未初始化，无法居中到节点', { taskId });
      return;
    }
    this.zoomService.centerOnNode(taskId);
    this.selectedTaskId.set(taskId);
    if (openDetail) {
      this.uiState.isFlowDetailOpen.set(true);
    }
  }
  
  refreshLayout(): void {
    // 视图切换到 flow 后，触发一次“延后 auto-fit”的落地（若有）。
    this.diagram.onFlowActivated();
    this.zoomService.requestUpdate();
  }
  
  private refreshDiagram(): void {
    this.scheduleTimer(() => {
      this.diagram.updateDiagram(this.projectState.tasks());
    }, 50);
  }
  
  // ========== 拖放处理 ==========
  
  onDragStart(event: DragEvent, task: Task): void {
    this.dragDrop.startDrag(event, task);
  }
  
  async onUnassignedDrop(event: DragEvent): Promise<void> {
    if (await this.dragDrop.handleFullUnassignedDrop(event)) {
      this.refreshDiagram();
    }
  }
  
  private handleDiagramDrop(taskData: Task, docPoint: go.Point): void {
    const diagramInstance = this.diagram.diagramInstance;
    if (!diagramInstance) return;

    const insertInfo = this.dragDrop.findInsertPosition(docPoint, diagramInstance);
    this.dragDrop.processDropFromInteraction(taskData, insertInfo, docPoint, 100);
  }
  
  // ========== 触摸处理 ==========
  
  onUnassignedTouchStart(event: TouchEvent, task: Task): void {
    if (!this.touch.startTouch(event, task)) {
      return;
    }
    this.unassignedTouchDrop.installGlobalListeners();
  }
  
  onUnassignedTouchMove(event: TouchEvent): void {
    this.unassignedTouchDrop.handleTouchMove(event);
  }
  
  onUnassignedTouchEnd(event: TouchEvent): void {
    this.unassignedTouchDrop.finish(false, event);
  }

  onUnassignedTouchCancel(_event: TouchEvent): void {
    this.unassignedTouchDrop.cancelIfNotDeferred();
  }
  
  // ========== 待分配任务点击 ==========
  
  onUnassignedTaskClick(task: Task): void {
    // 待分配任务也会在流程图中显示，直接定位到该节点
    this.centerOnNode(task.id);
  }
  
  // ========== 连接线操作 ==========
  
  confirmParentChildLink(): void {
    this.linkActions.confirmParentChildLink();
  }
  
  confirmCrossTreeLink(): void {
    this.linkActions.confirmCrossTreeLink();
  }
  
  // ========== 级联分配 ==========

  showCascadeAssignDialog(
    taskId: string,
    targetStage: number,
    targetParentId: string | null
  ): void {
    this.cascadeAssign.showDialog(taskId, targetStage, targetParentId);
  }
  
  /** 确认级联分配 */
  async confirmCascadeAssign(): Promise<void> {
    if (await this.cascadeAssign.confirm()) {
      this.refreshDiagram();
    }
  }
  
  /** 取消级联分配 */
  cancelCascadeAssign(): void {
    this.cascadeAssign.cancel();
  }
  
  /** 保存联系块的标题和描述 */
  async saveConnectionDescription(data: ConnectionEditorSavePayload): Promise<boolean> {
    return await this.linkActions.saveConnectionDescription(data);
  }

  async requestConnectionEditorClose(): Promise<boolean> {
    return await this.linkActions.requestConnectionEditorClose();
  }
  
  async deleteConnection(): Promise<void> {
    await this.linkActions.deleteConnection();
  }
  
  async confirmLinkDelete(): Promise<void> {
    await this.linkActions.confirmLinkDelete();
  }
  
  // ========== 移动端连接线操作菜单处理 ==========
  
  /** 从操作菜单编辑连接 */
  handleLinkActionEdit(): void {
    this.linkActions.handleLinkActionEdit();
  }
  
  /** 从操作菜单查看父子关系 */
  handleLinkActionView(): void {
    this.linkActions.handleLinkActionView();
  }
  
  /** 从操作菜单删除连接 */
  async handleLinkActionDelete(): Promise<void> {
    await this.linkActions.handleLinkActionDelete();
  }
  
  // ========== 任务操作 ==========
  private retireTaskDetailUi(projectChanged: boolean): void {
    if (projectChanged) this.selectedTaskId.set(null);
    this.deleteConfirmTask.set(null);
    this.deleteKeepChildren.set(false);
    this.deleteConfirmOwner = null;
  }
  private captureTaskOwner(task: Task): FlowTaskDetailOwner | null {
    const owner = this.taskDetailOwner.captureOwner();
    return this.taskDetailOwner.isTaskCurrent(task.id, task) ? owner : null;
  }
  createUnassigned(): void {
    void this.taskOps.createUnassignedTask('新任务');
  }
  async addSiblingTask(task: Task): Promise<void> {
    const owner = this.captureTaskOwner(task);
    if (!owner) return;
    const newTaskId = await this.taskOps.addSiblingTask(task);
    if (newTaskId && this.taskDetailOwner.isOwnerCurrent(owner)) {
      this.selectedTaskId.set(newTaskId);
      this.taskOps.focusTitleInput(this.elementRef);
    }
  }
  async addChildTask(task: Task): Promise<void> {
    const owner = this.captureTaskOwner(task);
    if (!owner) return;
    const newTaskId = await this.taskOps.addChildTask(task);
    if (newTaskId && this.taskDetailOwner.isOwnerCurrent(owner)) {
      this.selectedTaskId.set(newTaskId);
      this.taskOps.focusTitleInput(this.elementRef);
    }
  }
  async archiveTask(task: Task): Promise<void> {
    const owner = this.captureTaskOwner(task);
    if (!owner) return;
    const newStatus = await this.taskOps.archiveTask(task);
    if (newStatus === 'archived' && this.taskDetailOwner.isOwnerCurrent(owner)) {
      this.selectedTaskId.set(null);
    }
  }
  parkTaskAction(task: Task): void {
    const currentTask = this.selectedTask();
    if (currentTask?.id === task.id && this.captureTaskOwner(currentTask)) this.selectedTaskId.set(null);
  }
  deleteTask(task: Task): void {
    const owner = this.captureTaskOwner(task);
    if (!owner) return;
    this.deleteConfirmOwner = owner;
    this.deleteConfirmTask.set(task);
  }
  async confirmDelete(keepChildren: boolean): Promise<void> {
    const task = this.deleteConfirmTask();
    const owner = this.deleteConfirmOwner;
    if (!task || !owner || !this.taskDetailOwner.isOwnerCurrent(owner)
      || !this.taskDetailOwner.isTaskCurrent(task.id)) return;
    const deleted = await this.taskOps.deleteTask(task.id, keepChildren);
    if (!deleted || !this.taskDetailOwner.isOwnerCurrent(owner)) return;
    this.selectedTaskId.set(null);
    this.deleteConfirmTask.set(null);
    this.deleteKeepChildren.set(false);
    this.deleteConfirmOwner = null;
    if (this.diagram.isInitialized) {
      this.diagram.updateDiagram(this.projectState.tasks(), true);
    }
  }
  
  // ========== 移动端抽屉 ==========

  private expandDrawerToOptimalHeight(): void {
    this.mobileInteraction.expandDrawerToOptimalHeight();
  }
  
  // ========== 批量删除 ==========

  requestBatchDelete(): void {
    const singleTask = this.batchDelete.requestBatchDelete();
    if (singleTask) {
      // 单选时走单任务删除流程
      this.deleteTask(singleTask);
    }
  }
  
  async confirmBatchDelete(): Promise<void> {
    const deletedCount = await this.batchDelete.confirmBatchDelete(() => {
      this.selectedTaskId.set(null);
    });
    
    // 强制刷新图表
    if (deletedCount > 0 && this.diagram.isInitialized) {
      this.diagram.updateDiagram(this.projectState.tasks(), true);
    }
  }
  
  /** Delete 键处理 */
  private handleDeleteKeyPressed(): void {
    const singleTask = this.batchDelete.handleDeleteKeyPressed();
    if (singleTask) {
      this.deleteTask(singleTask);
    }
  }
  
  // ========== 框选模式 ==========

  toggleSelectMode(): void {
    this.selectMode.toggleSelectMode();
  }
  
  // ========== 调色板拖动 ==========

  startPaletteResize(e: MouseEvent): void {
    this.paletteResize.bindHeightSignal(this.paletteHeight);
    this.paletteResize.startMouseResize(e);
  }
  
  startPaletteResizeTouch(e: TouchEvent): void {
    this.paletteResize.bindHeightSignal(this.paletteHeight);
    this.paletteResize.startTouchResize(e);
  }
  
  @HostListener('window:keydown', ['$event'])
  handleDiagramShortcut(event: KeyboardEvent): void {
    const result = this.keyboard.handleShortcut(event);
    if (result.status !== 'handled') {
      return;
    }

    void result.completed.then(
      () => this.refreshDiagram(),
      () => this.refreshDiagram(),
    );
  }
  
  emitToggleSidebar(): void {
    window.dispatchEvent(new CustomEvent('toggle-sidebar'));
  }

  /** 处理调色板展开状态变更 */
  onPaletteOpenChange(isOpen: boolean): void {
    this.isPaletteOpen.set(isOpen);
    // 互斥逻辑：左侧展开时，收起右侧面板
    if (isOpen && this.uiState.isMobile()) {
      this.isRightPanelOpen.set(false);
    }
  }
  
  /** 处理抽屉状态变化 (移动端双向抽屉) */
  onDrawerStateChange(event: { previousLayer: string; currentLayer: string; triggeredBy: string }): void {
    this.mobileInteraction.onDrawerStateChange(event);
  }
  
  /** 移动端抽屉内点击节点定位（关闭抽屉后定位） */
  onMobileDrawerCenterOnNode(taskId: string): void {
    this.mobileInteraction.centerOnNodeFromDrawer(() => this.centerOnNode(taskId));
  }
  
  /**
   * 流程图区域滑动手势
   * - 向右：切换到文本视图
   * - 向左：打开项目侧边栏
   */
  onDrawerSwipeToSwitch(direction: 'left' | 'right'): void {
    this.mobileInteraction.onDrawerSwipeToSwitch(direction, () => this.toggleRightPanel());
  }
  
  /** 切换右侧面板（移动端） */
  toggleRightPanel(): void {
    this.mobileInteraction.toggleRightPanel();
  }
  
  onDiagramAreaTouchStart(e: TouchEvent): void {
    this.mobileInteraction.onDiagramAreaTouchStart(e);
  }
  
  onDiagramAreaTouchMove(e: TouchEvent): void {
    this.mobileInteraction.onDiagramAreaTouchMove(e);
  }
  
  onDiagramAreaTouchEnd(e: TouchEvent): void {
    this.mobileInteraction.onDiagramAreaTouchEnd(e);
  }
  
  private bumpDetailLayoutTick(delayMs: number = 0): void {
    this.mobileInteraction.bumpDetailLayoutTick(delayMs);
  }
  
  /**
   * 安全调度定时器，自动追踪并在组件销毁时清理
   */
  private scheduleTimer(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
    const timerId = setTimeout(() => {
      // 从列表中移除已执行的定时器
      const index = this.pendingTimers.indexOf(timerId);
      if (index > -1) {
        this.pendingTimers.splice(index, 1);
      }
      // 如果组件已销毁，不执行回调
      if (this.isDestroyed) return;
      callback();
    }, delay);
    
    this.pendingTimers.push(timerId);
    return timerId;
  }
}
