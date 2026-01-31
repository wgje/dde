import { Component, inject, signal, computed, ElementRef, ViewChild, AfterViewInit, OnDestroy, effect, NgZone, HostListener, Output, EventEmitter, ChangeDetectionStrategy, Injector, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { SyncCoordinatorService } from '../../../../services/sync-coordinator.service';
import { PreferenceService } from '../../../../services/preference.service';
import { ToastService } from '../../../../services/toast.service';
import { LoggerService } from '../../../../services/logger.service';
import { FlowCommandService } from '../services/flow-command.service';
import { FlowDiagramService } from '../services/flow-diagram.service';
import { FlowEventService } from '../services/flow-event.service';
import { FlowZoomService } from '../services/flow-zoom.service';
import { FlowSelectionService } from '../services/flow-selection.service';
import { FlowLayoutService } from '../services/flow-layout.service';
import { FlowDragDropService, InsertPositionInfo } from '../services/flow-drag-drop.service';
import { FlowTouchService } from '../services/flow-touch.service';
import { FlowLinkService } from '../services/flow-link.service';
import { FlowTaskOperationsService } from '../services/flow-task-operations.service';
import { FlowSwipeGestureService, SwipeResult } from '../services/flow-swipe-gesture.service';
import { FlowDrawerHeightService } from '../services/flow-drawer-height.service';
import { FlowCascadeAssignService } from '../services/flow-cascade-assign.service';
import { FlowKeyboardService } from '../services/flow-keyboard.service';
import { FlowPaletteResizeService } from '../services/flow-palette-resize.service';
import { FlowBatchDeleteService } from '../services/flow-batch-delete.service';
import { FlowSelectModeService } from '../services/flow-select-mode.service';
import { FlowMobileDrawerService } from '../services/flow-mobile-drawer.service';
import { FlowDiagramEffectsService } from '../services/flow-diagram-effects.service';
import { FlowEventRegistrationService } from '../services/flow-event-registration.service';
import { Task } from '../../../../models';
import { UI_CONFIG, FLOW_VIEW_CONFIG } from '../../../../config';
import { FlowToolbarComponent } from './flow-toolbar.component';
import { FlowPaletteComponent } from './flow-palette.component';
import { FlowTaskDetailComponent } from './flow-task-detail.component';
import { FlowDeleteConfirmComponent } from './flow-delete-confirm.component';
import { FlowLinkTypeDialogComponent } from './flow-link-type-dialog.component';
import { FlowConnectionEditorComponent } from './flow-connection-editor.component';
import { FlowLinkDeleteHintComponent } from './flow-link-delete-hint.component';
import { FlowCascadeAssignDialogComponent } from './flow-cascade-assign-dialog.component';
import { FlowBatchDeleteDialogComponent } from './flow-batch-delete-dialog.component';
import { MobileDrawerContainerComponent } from './mobile-drawer-container.component';
import { MobileTodoDrawerComponent } from './mobile-todo-drawer.component';
import { MobileBlackBoxDrawerComponent } from './mobile-black-box-drawer.component';
import { flowTemplateEventHandlers } from '../services/flow-template-events';
import * as go from 'gojs';

/**
 * FlowViewComponent - 流程图视图组件
 * 
 * 重构后的职责：
 * - 模板渲染
 * - 子组件通信
 * - 服务协调
 * - 生命周期管理
 * 
 * 核心逻辑已拆分到以下服务：
 * - FlowDiagramService: GoJS 图表管理
 * - FlowDragDropService: 拖放处理
 * - FlowTouchService: 触摸处理
 * - FlowLinkService: 连接线管理
 * - FlowTaskOperationsService: 任务操作
 */
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
    FlowCascadeAssignDialogComponent,
    FlowBatchDeleteDialogComponent,
    MobileDrawerContainerComponent,
    MobileTodoDrawerComponent,
    MobileBlackBoxDrawerComponent
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./flow-view.component.scss'],
  templateUrl: './flow-view.component.html'
})
export class FlowViewComponent implements AfterViewInit, OnDestroy {
  @ViewChild('diagramDiv') diagramDiv!: ElementRef;
  @ViewChild('overviewDiv') overviewDiv!: ElementRef;
  @Output() goBackToText = new EventEmitter<void>();
  
  // ========== P2-1 迁移：直接注入子服务 ==========
  readonly uiState = inject(UiStateService);
  readonly projectState = inject(ProjectStateService);
  private readonly taskOpsAdapter = inject(TaskOperationAdapterService);
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private readonly preference = inject(PreferenceService);
  private readonly toast = inject(ToastService);
  private readonly logger = inject(LoggerService).category('FlowView');
  private readonly zone = inject(NgZone);
  private readonly elementRef = inject(ElementRef);
  private readonly injector = inject(Injector);
  private readonly router = inject(Router);
  
  // 命令服务（解耦与 ProjectShellComponent 的通信）
  private readonly flowCommand = inject(FlowCommandService);
  
  // 核心服务
  readonly diagram = inject(FlowDiagramService);
  private readonly eventService = inject(FlowEventService);
  private readonly zoomService = inject(FlowZoomService);
  readonly selectionService = inject(FlowSelectionService);
  private readonly layoutService = inject(FlowLayoutService);
  readonly dragDrop = inject(FlowDragDropService);
  readonly touch = inject(FlowTouchService);
  readonly link = inject(FlowLinkService);
  readonly taskOps = inject(FlowTaskOperationsService);
  private readonly swipeGesture = inject(FlowSwipeGestureService);
  private readonly drawerHeightService = inject(FlowDrawerHeightService);
  readonly cascadeAssign = inject(FlowCascadeAssignService);
  private readonly keyboard = inject(FlowKeyboardService);
  private readonly paletteResize = inject(FlowPaletteResizeService);
  readonly batchDelete = inject(FlowBatchDeleteService);
  readonly selectMode = inject(FlowSelectModeService);
  private readonly mobileDrawer = inject(FlowMobileDrawerService);
  private readonly diagramEffects = inject(FlowDiagramEffectsService);
  private readonly eventRegistration = inject(FlowEventRegistrationService);
  
  // ========== 组件状态 ==========
  
  /** 选中的任务ID */
  readonly selectedTaskId = signal<string | null>(null);
  
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
  
  /** 是否正在重试加载图表 */
  readonly isRetryingDiagram = signal(false);
  
  /** 小地图状态 */
  readonly isOverviewVisible = signal(true);
  readonly isOverviewCollapsed = signal(false);
  
  /** 侧边栏（调色板）展开状态 */
  readonly isPaletteOpen = signal(true);
  
  /** 右侧滑出面板状态（移动端） */
  readonly isRightPanelOpen = signal(false);
  
  /** 小地图尺寸（移动端使用更小尺寸） */
  readonly overviewSize = computed(() => {
    if (this.uiState.isMobile()) {
      return { width: 100, height: 80 };
    }
    return { width: 180, height: 140 };
  });

  /** 小地图底部位置（抽屉在顶部，固定在底部） */
  readonly overviewBottomPosition = computed(() => {
    // 桌面端稍高一点
    if (!this.uiState.isMobile()) {
      return '16px';
    }
    // 移动端固定在底部（抽屉在顶部，不影响小地图）
    return '8px';
  });

  /** 图表初始化重试次数 */
  private diagramRetryCount = 0;
  
  /** 是否已达到重试上限（用于 UI 显示不同按钮） */
  readonly hasReachedRetryLimit = signal(false);
  
  /** 计算属性: 获取选中的任务对象 */
  readonly selectedTask = computed(() => {
    const id = this.selectedTaskId();
    if (!id) return null;
    return this.projectState.tasks().find(t => t.id === id) || null;
  });
  
  // ========== 私有状态 ==========
  private isDestroyed = false;

  /** GoJS 拖拽结束时用于移动端幽灵清理的监听器引用（便于销毁/重建时移除） */
  private diagramSelectionMovedListener: ((e: go.DiagramEvent) => void) | null = null;
  
  /** 待清理的定时器（防止内存泄漏） */
  private pendingTimers: ReturnType<typeof setTimeout>[] = [];
  
  /** rAF 调度 ID（用于取消） */
  private pendingRafId: number | null = null;

  /** 抽屉高度更新的 rAF（合并多次高度变更） */
  private pendingDrawerHeightRafId: number | null = null;
  private pendingDrawerHeightTarget: number | null = null;
  
  /** 节点选中重试的 rAF ID 列表（用于取消） */
  private pendingRetryRafIds: number[] = [];
  
  /** 是否有待处理的图表更新（用于 rAF 合并） */
  private diagramUpdatePending = false;
  
  /** Overview 刷新定时器（防抖） */
  private overviewResizeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Idle 初始化句柄（用于取消） */
  private idleInitHandle: number | null = null;

  /** Idle 小地图初始化句柄（用于取消） */
  private idleOverviewInitHandle: number | null = null;
  
  /**
   * 监听窗口大小改变（处理屏幕旋转等情况）
   */
  @HostListener('window:resize')
  onWindowResize(): void {
    // 防抖处理，避免频繁刷新
    if (this.overviewResizeTimer) {
      clearTimeout(this.overviewResizeTimer);
    }
    
    this.overviewResizeTimer = setTimeout(() => {
      if (!this.isDestroyed && !this.isOverviewCollapsed()) {
        this.diagram.refreshOverview();
      }
    }, 300);
  }
  
  /**
   * 监听屏幕方向改变（移动端）
   */
  @HostListener('window:orientationchange')
  onOrientationChange(): void {
    // 屏幕旋转后延迟刷新，确保布局完成
    this.scheduleTimer(() => {
      if (!this.isDestroyed && !this.isOverviewCollapsed()) {
        this.diagram.refreshOverview();
      }
    }, 500);
  }
  
  constructor() {
    // 使用 FlowDiagramEffectsService 统一管理响应式 effect
    const scheduleRaf = this.scheduleRafDiagramUpdate.bind(this);
    
    // 核心数据变化 effects
    this.diagramEffects.createTasksEffect(this.injector, scheduleRaf);
    this.diagramEffects.createConnectionsEffect(this.injector, scheduleRaf);
    this.diagramEffects.createSearchEffect(this.injector, scheduleRaf);
    this.diagramEffects.createThemeEffect(this.injector, scheduleRaf);
    
    // 选中状态同步
    this.diagramEffects.createSelectionSyncEffect(
      this.injector,
      this.selectedTaskId,
      this.selectNodeWithRetry.bind(this)
    );
    
    // 命令服务订阅
    this.diagramEffects.createCenterCommandEffect(
      this.injector,
      this.executeCenterOnNode.bind(this)
    );
    this.diagramEffects.createRetryCommandEffect(
      this.injector,
      this.retryInitDiagram.bind(this)
    );
    
    // 移动端抽屉高度管理 effects
    this.setupMobileDrawerEffects();
  }
  
  /**
   * 设置移动端抽屉高度相关的 effects
   * 使用 FlowMobileDrawerService 进行高度计算
   */
  private setupMobileDrawerEffects(): void {
    // 🎯 移动端：基于"调色板高度"为参考系，设置详情抽屉的最佳高度（vh）
    effect(() => {
      const isDetailOpen = this.uiState.isFlowDetailOpen();
      const activeView = this.uiState.activeView();

      if (!this.uiState.isMobile() || activeView !== 'flow') {
        // 非移动端或非流程图视图时，仅更新状态追踪
        this.mobileDrawer.determineScenario(isDetailOpen);
        if (!isDetailOpen) {
          this.drawerManualOverride.set(false);
        }
        return;
      }

      const scenario = this.mobileDrawer.determineScenario(isDetailOpen);
      
      if (scenario && !this.drawerManualOverride()) {
        untracked(() => {
          const targetVh = this.mobileDrawer.calculateDrawerVh(this.paletteHeight(), scenario);
          if (targetVh !== null) {
            this.scheduleDrawerHeightUpdate(targetVh);
          }
        });
      }
      
      if (!isDetailOpen) {
        this.drawerManualOverride.set(false);
      }
    }, { injector: this.injector });

    // 🎯 场景二之后：当详情已开且点击任务块时，自动切回"场景一"最佳高度
    effect(() => {
      const selectedId = this.selectedTaskId();
      const isDetailOpen = this.uiState.isFlowDetailOpen();
      const activeView = this.uiState.activeView();

      if (!this.uiState.isMobile() || activeView !== 'flow' || !isDetailOpen || !selectedId) return;
      if (this.drawerManualOverride()) return;
      if (this.mobileDrawer.isAtDirectPreset()) return;

      untracked(() => {
        const targetVh = this.mobileDrawer.calculateDrawerVh(this.paletteHeight(), 'direct');
        if (targetVh !== null) {
          this.scheduleDrawerHeightUpdate(targetVh);
          this.mobileDrawer.markAsDirectPreset();
        }
      });
    }, { injector: this.injector });

    // 监听拖拽标记，用户一旦开始拖拽则启用手动覆盖
    effect(() => {
      if (this.isResizingDrawerSignal()) {
        this.drawerManualOverride.set(true);
      }
    }, { injector: this.injector });
    
    // 🎯 移动端：场景2（小抽屉）后，点击任务块应自动扩展到场景1的最佳位置
    effect(() => {
      const activeView = this.uiState.activeView();
      const isDetailOpen = this.uiState.isFlowDetailOpen();
      const selectedTaskId = this.selectedTaskId();
      const isResizing = this.isResizingDrawerSignal();

      if (!this.uiState.isMobile()) return;
      if (activeView !== 'flow' || !isDetailOpen || !selectedTaskId || isResizing) return;
      if (this.drawerManualOverride()) return;

      untracked(() => {
        const targetVh = this.mobileDrawer.calculateDrawerVh(this.paletteHeight(), 'direct');
        if (targetVh === null) return;
        
        const currentVh = this.drawerHeight();
        if (this.mobileDrawer.shouldExpandDrawer(currentVh, targetVh)) {
          this.scheduleDrawerHeightUpdate(targetVh);
        }
      });
    }, { injector: this.injector });
  }
  
  /**
   * 使用 requestAnimationFrame 调度图表更新
   * 将多个 signal 变化合并到同一帧，避免过度渲染
   * 
   * 注意：rAF 的作用是"对齐"而非"延迟"
   * 它把更新逻辑和浏览器刷新频率（60Hz）对齐，确保不会在一帧里做两次无用渲染
   */
  private scheduleRafDiagramUpdate(tasks: Task[], forceUpdate: boolean): void {
    // 标记需要完整更新
    if (forceUpdate) {
      this.diagramUpdatePending = true;
    }
    
    // 如果已有 rAF 调度，复用它
    if (this.pendingRafId !== null) {
      return;
    }
    
    this.pendingRafId = requestAnimationFrame(() => {
      this.pendingRafId = null;
      
      if (this.isDestroyed || !this.diagram.isInitialized) return;
      
      // 执行图表更新，使用合并后的 forceUpdate 标志
      this.diagram.updateDiagram(this.projectState.tasks(), this.diagramUpdatePending);
      this.diagramUpdatePending = false;
    });
  }

  /**
   * 合并抽屉高度更新，避免短时间内多次触发布局变化
   */
  private scheduleDrawerHeightUpdate(targetVh: number): void {
    if (this.isDestroyed) return;

    this.pendingDrawerHeightTarget = targetVh;
    if (this.pendingDrawerHeightRafId !== null) return;

    this.pendingDrawerHeightRafId = requestAnimationFrame(() => {
      this.pendingDrawerHeightRafId = null;
      const nextVh = this.pendingDrawerHeightTarget;
      this.pendingDrawerHeightTarget = null;
      if (nextVh === null) return;
      if (Math.abs(this.drawerHeight() - nextVh) > 0.2) {
        this.drawerHeight.set(nextVh);
      }
    });
  }
  
  // ========== 生命周期 ==========
  
  ngAfterViewInit() {
    this.scheduleDiagramInit();
  }
  
  ngOnDestroy() {
    this.isDestroyed = true;
    
    // 标记 View 已销毁
    this.flowCommand.markViewDestroyed();

    // 优先卸载 GoJS 监听 + 清理幽灵，避免残留 DOM/引用
    this.uninstallMobileDiagramDragGhostListeners();
    this.touch.endDiagramNodeDragGhost();
    
    // 清理所有待处理的定时器
    this.pendingTimers.forEach(clearTimeout);
    this.pendingTimers = [];
    
    // 清理 rAF
    if (this.pendingRafId !== null) {
      cancelAnimationFrame(this.pendingRafId);
      this.pendingRafId = null;
    }

    if (this.pendingDrawerHeightRafId !== null) {
      cancelAnimationFrame(this.pendingDrawerHeightRafId);
      this.pendingDrawerHeightRafId = null;
      this.pendingDrawerHeightTarget = null;
    }
    
    // 清理节点选中重试的 rAF
    this.pendingRetryRafIds.forEach(id => cancelAnimationFrame(id));
    this.pendingRetryRafIds = [];
    
    // 清理 Overview 刷新定时器
    if (this.overviewResizeTimer) {
      clearTimeout(this.overviewResizeTimer);
      this.overviewResizeTimer = null;
    }

    // 清理 idle 初始化句柄
    if (typeof cancelIdleCallback !== 'undefined' && this.idleInitHandle !== null) {
      cancelIdleCallback(this.idleInitHandle);
      this.idleInitHandle = null;
    }

    if (typeof cancelIdleCallback !== 'undefined' && this.idleOverviewInitHandle !== null) {
      cancelIdleCallback(this.idleOverviewInitHandle);
      this.idleOverviewInitHandle = null;
    }
    
    // 清理服务
    this.diagram.dispose();
    this.touch.dispose();
    this.link.dispose();
    this.dragDrop.dispose();
    this.taskOps.dispose();
    
    // 清理 Delete 键事件处理器
    flowTemplateEventHandlers.onDeleteKeyPressed = undefined;
  }
  
  // ========== 图表初始化 ==========

  private scheduleDiagramInit(): void {
    const startInit = () => {
      if (this.isDestroyed) return;
      this.initDiagram();
      if (this.diagram.isInitialized) {
        this.onDiagramInitialized();
      }
    };

    // 使用 requestIdleCallback 延迟重任务，避免阻塞 LCP
    if (typeof requestIdleCallback !== 'undefined') {
      this.idleInitHandle = requestIdleCallback(() => {
        this.idleInitHandle = null;
        this.zone.run(() => startInit());
      }, { timeout: 5000 });
    } else {
      this.scheduleTimer(() => {
        this.zone.run(() => startInit());
      }, 1200);
    }
  }

  private onDiagramInitialized(delayMs: number = UI_CONFIG.MEDIUM_DELAY): void {
    // 初始化完成后加载图表数据
    this.scheduleTimer(() => {
      if (this.diagram.isInitialized) {
        this.diagram.updateDiagram(this.projectState.tasks());

        // 标记 View 已就绪
        this.flowCommand.markViewReady();

        // 检查并执行待处理的命令
        const pendingCmd = this.flowCommand.consumePendingCenterCommand();
        if (pendingCmd) {
          // 延迟执行，确保图表完全渲染
          this.scheduleTimer(() => {
            this.executeCenterOnNode(pendingCmd.taskId, pendingCmd.openDetail);
          }, 100);
        }
      }
    }, delayMs);
  }
  
  private initDiagram(): void {
    // 防御性检查：确保 DOM 元素已准备好
    if (!this.diagramDiv || !this.diagramDiv.nativeElement) {
      this.logger.warn('[FlowView] diagramDiv 未准备好，跳过初始化');
      return;
    }

    // 若重复初始化（重试/重置），先移除旧监听并清理幽灵
    this.uninstallMobileDiagramDragGhostListeners();
    this.touch.endDiagramNodeDragGhost();

    const success = this.diagram.initialize(this.diagramDiv.nativeElement);
    if (!success) return;
    
    // 注册所有 GoJS 事件回调（通过 EventRegistrationService）
    this.eventRegistration.registerAllEvents({
      isSelectMode: () => this.selectMode.isSelectMode(),
      selectedTaskId: this.selectedTaskId,
      refreshDiagram: () => this.refreshDiagram(),
      expandDrawerToOptimalHeight: () => this.expandDrawerToOptimalHeight(),
      handleNodeMoved: (key, loc, isUnassigned, diagram) => 
        this.dragDrop.handleNodeMoved(key, loc, isUnassigned, diagram),
      isPaletteOpen: this.isPaletteOpen,
      handleDeleteKeyPressed: () => this.handleDeleteKeyPressed()
    });

    this.installMobileDiagramDragGhostListeners();
    
    // 设置拖放处理
    this.diagram.setupDropHandler((taskData, docPoint) => {
      this.handleDiagramDrop(taskData, docPoint);
    });
    
    // 初始化小地图
    this.initOverview();
  } 

  private installMobileDiagramDragGhostListeners(): void {
    if (!this.uiState.isMobile()) return;
    if (this.diagramSelectionMovedListener) return;

    const diagramInstance = this.diagram.diagramInstance;
    if (!diagramInstance) return;

    // 注意：GoJS 没有 'SelectionMoving' 事件（会导致运行时错误）
    // 只使用 'SelectionMoved' 在拖拽结束时清理幽灵元素
    // 如果需要实时跟踪，应该监听 ToolManager 或使用 doMouseMove
    this.diagramSelectionMovedListener = () => {
      if (!this.uiState.isMobile()) return;
      this.touch.endDiagramNodeDragGhost();
    };

    diagramInstance.addDiagramListener('SelectionMoved', this.diagramSelectionMovedListener);
  }

  private uninstallMobileDiagramDragGhostListeners(): void {
    const diagramInstance = this.diagram.diagramInstance;
    if (!diagramInstance) return;

    if (this.diagramSelectionMovedListener) {
      try {
        diagramInstance.removeDiagramListener('SelectionMoved', this.diagramSelectionMovedListener);
      } catch (error) {
        // 忽略移除监听器时的错误（图表可能已经被销毁）
        console.warn('[FlowView] 移除 SelectionMoved 监听器失败', error);
      }
      this.diagramSelectionMovedListener = null;
    }
  }
  
  // ========== 小地图 ==========
  
  /**
   * 初始化小地图
   */
  private initOverview(immediate = false): void {
    if (!this.isOverviewVisible() || this.isOverviewCollapsed()) return;

    const runInit = () => {
      if (this.overviewDiv?.nativeElement && this.diagram.isInitialized) {
        this.diagram.initializeOverview(this.overviewDiv.nativeElement);
      }
    };

    if (immediate) {
      this.scheduleTimer(() => runInit(), 0);
      return;
    }

    if (typeof requestIdleCallback !== 'undefined') {
      if (typeof cancelIdleCallback !== 'undefined' && this.idleOverviewInitHandle !== null) {
        cancelIdleCallback(this.idleOverviewInitHandle);
      }
      this.idleOverviewInitHandle = requestIdleCallback(() => {
        this.idleOverviewInitHandle = null;
        this.zone.run(() => runInit());
      }, { timeout: 3000 });
    } else {
      this.scheduleTimer(() => runInit(), 300);
    }
  }
  
  /**
   * 折叠/展开小地图
   */
  toggleOverviewCollapse(): void {
    const wasCollapsed = this.isOverviewCollapsed();
    this.isOverviewCollapsed.set(!wasCollapsed);
    
    // 展开时需要重新初始化 Overview
    if (wasCollapsed) {
      // 使用 requestAnimationFrame + setTimeout 确保 DOM 完全渲染后再初始化
      // 修复移动端展开小地图时只显示一半的问题
      requestAnimationFrame(() => {
        this.scheduleTimer(() => {
          this.initOverview(true);
        }, 100); // 增加延迟时间，确保容器尺寸已确定
      });
    } else {
      // 折叠时销毁 Overview
      this.diagram.disposeOverview();
    }
  }

  onOverviewTogglePointerDown(e: PointerEvent): void {
    // 重要：GoJS 会在 canvas 上处理指针事件；这里提前截断，避免事件被 Overview 抢走导致按钮无响应。
    e.preventDefault();
    e.stopPropagation();
    this.toggleOverviewCollapse();
  }

  retryInitDiagram(): void {
    // 检查是否超过最大重试次数
    if (this.diagramRetryCount >= FLOW_VIEW_CONFIG.MAX_DIAGRAM_RETRIES) {
      this.toast.error(
        '初始化失败', 
        `流程图加载失败已重试 ${FLOW_VIEW_CONFIG.MAX_DIAGRAM_RETRIES} 次，请尝试刷新页面或切换到文本视图`
      );
      this.isRetryingDiagram.set(false);
      this.hasReachedRetryLimit.set(true);
      return;
    }
    
    this.diagramRetryCount++;
    this.isRetryingDiagram.set(true);
    this.hasReachedRetryLimit.set(false);
    
    // 显示重试进度反馈
    const remaining = FLOW_VIEW_CONFIG.MAX_DIAGRAM_RETRIES - this.diagramRetryCount;
    this.toast.info(
      `重试加载中...`,
      `第 ${this.diagramRetryCount} 次尝试（剩余 ${remaining} 次）`,
      { duration: 2000 }
    );
    
    // 使用指数退避：使用集中配置的基础延迟
    const delay = FLOW_VIEW_CONFIG.DIAGRAM_RETRY_BASE_DELAY * Math.pow(2, this.diagramRetryCount - 1);
    
    this.scheduleTimer(() => {
      // 在 Angular zone 内运行以确保变更检测
      this.zone.run(() => {
        // 再次检查 DOM 是否准备好
        if (!this.diagramDiv || !this.diagramDiv.nativeElement) {
          this.logger.warn('[FlowView] 重试时 diagramDiv 仍未准备好，将再次重试');
          this.isRetryingDiagram.set(false);
          // 如果 DOM 未准备好，递归重试（会增加重试计数）
          this.scheduleTimer(() => this.retryInitDiagram(), 500);
          return;
        }

        this.initDiagram();
        if (this.diagram.isInitialized) {
          this.onDiagramInitialized(0);
          // 成功后重置重试计数
          this.diagramRetryCount = 0;
          this.hasReachedRetryLimit.set(false);
          this.toast.success('加载成功', '流程图已就绪');
        }
        this.isRetryingDiagram.set(false);
      });
    }, delay);
  }
  
  /**
   * 完全重置图表状态并重新初始化
   * 用于用户手动触发的"完全重置"操作
   */
  resetAndRetryDiagram(): void {
    // 重置所有状态
    this.diagramRetryCount = 0;
    this.hasReachedRetryLimit.set(false);
    this.diagram.dispose();
    
    // 重新初始化
    this.toast.info('重置中...', '正在完全重置流程图');
    
    this.scheduleTimer(() => {
      this.zone.run(() => {
        // 检查 DOM 是否准备好
        if (!this.diagramDiv || !this.diagramDiv.nativeElement) {
          this.logger.error('[FlowView] 重置时 diagramDiv 不可用');
          this.toast.error('重置失败', '视图未准备好，请稍后重试');
          return;
        }

        this.initDiagram();
        if (this.diagram.isInitialized) {
          this.onDiagramInitialized(0);
          this.toast.success('重置成功', '流程图已就绪');
        } else {
          // 重置后仍然失败，显示错误但允许再次重试
          this.toast.error('重置失败', '流程图初始化失败，请尝试刷新页面');
        }
      });
    }, 200);
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
  
  exportToPng(): void {
    this.diagram.exportToPng();
  }
  
  exportToSvg(): void {
    this.diagram.exportToSvg();
  }
  
  saveToCloud(): void {
    // TODO: 实现云端保存功能
    this.toast.info('功能开发中', '云端保存功能即将推出');
  }

  /**
   * 居中到指定节点（公共 API，向后兼容）
   * 可被模板或外部直接调用
   */
  centerOnNode(taskId: string, openDetail: boolean = true): void {
    this.executeCenterOnNode(taskId, openDetail);
  }
  
  /**
   * 执行居中到节点（内部实现）
   * 供命令服务 effect 和公共方法调用
   */
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
  
  onUnassignedDrop(event: DragEvent): void {
    const success = this.dragDrop.handleDropToUnassigned(event);
    if (success) {
      this.refreshDiagram();
    }
  }
  
  private handleDiagramDrop(taskData: Task, docPoint: go.Point): void {
    const diagramInstance = this.diagram.diagramInstance;
    if (!diagramInstance) return;

    // 场景二：从待分配区域拖放到画布时，不应立刻"任务化"。
    // 仅更新位置，待后续"拉线"时再根据连接关系赋予阶段/序号。
    if (taskData?.stage === null) {
      // 同时更新 Store 和 GoJS 中的节点位置
      // Store 更新确保数据持久化，GoJS 更新确保视觉即时反馈
      this.taskOpsAdapter.updateTaskPosition(taskData.id, docPoint.x, docPoint.y);
      this.layoutService.setNodePosition(taskData.id, docPoint.x, docPoint.y);
      return;
    }
    
    const insertInfo = this.dragDrop.findInsertPosition(docPoint, diagramInstance);
    
    if (insertInfo.insertOnLink) {
      const { sourceId, targetId } = insertInfo.insertOnLink;
      this.dragDrop.insertTaskBetweenNodes(taskData.id, sourceId, targetId, docPoint);
    } else if (insertInfo.parentId) {
      const parentTask = this.projectState.tasks().find(t => t.id === insertInfo.parentId);
      if (parentTask) {
        const newStage = (parentTask.stage || 1) + 1;
        this.taskOpsAdapter.moveTaskToStage(taskData.id, newStage, insertInfo.beforeTaskId, insertInfo.parentId);
        this.scheduleTimer(() => {
          this.taskOpsAdapter.updateTaskPosition(taskData.id, docPoint.x, docPoint.y);
        }, 100);
      }
    } else if (insertInfo.beforeTaskId || insertInfo.afterTaskId) {
      const refTask = this.projectState.tasks().find(t => t.id === (insertInfo.beforeTaskId || insertInfo.afterTaskId));
      if (refTask?.stage) {
        if (insertInfo.afterTaskId) {
          const siblings = this.projectState.tasks()
            .filter(t => t.stage === refTask.stage && t.parentId === refTask.parentId)
            .sort((a, b) => a.rank - b.rank);
          const afterIndex = siblings.findIndex(t => t.id === refTask.id);
          const nextSibling = siblings[afterIndex + 1];
          this.taskOpsAdapter.moveTaskToStage(taskData.id, refTask.stage, nextSibling?.id || null, refTask.parentId);
        } else {
          this.taskOpsAdapter.moveTaskToStage(taskData.id, refTask.stage, insertInfo.beforeTaskId, refTask.parentId);
        }
        this.scheduleTimer(() => {
          this.taskOpsAdapter.updateTaskPosition(taskData.id, docPoint.x, docPoint.y);
        }, 100);
      }
    } else {
      this.taskOpsAdapter.updateTaskPosition(taskData.id, docPoint.x, docPoint.y);
    }
  }
  
  // ========== 触摸处理 ==========
  
  onUnassignedTouchStart(event: TouchEvent, task: Task): void {
    this.touch.startTouch(event, task);
  }
  
  onUnassignedTouchMove(event: TouchEvent): void {
    const shouldPrevent = this.touch.handleTouchMove(event);
    if (shouldPrevent) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
  
  onUnassignedTouchEnd(event: TouchEvent): void {
    this.touch.endTouch(
      event,
      this.diagramDiv?.nativeElement,
      this.diagram.diagramInstance,
      (task, insertInfo, docPoint) => {
        this.handleTouchDrop(task, insertInfo, docPoint);
      }
    );
  }
  
  private handleTouchDrop(task: Task, insertInfo: InsertPositionInfo, docPoint: go.Point): void {
    // 场景二（移动端）：待分配块拖入画布仅更新位置，不立刻任务化
    if (task.stage === null) {
      // 同时更新 Store 和 GoJS 中的节点位置
      // Store 更新确保数据持久化，GoJS 更新确保视觉即时反馈
      this.taskOpsAdapter.updateTaskPosition(task.id, docPoint.x, docPoint.y);
      this.layoutService.setNodePosition(task.id, docPoint.x, docPoint.y);
      return;
    }

    if (insertInfo.insertOnLink) {
      const { sourceId, targetId } = insertInfo.insertOnLink;
      this.dragDrop.insertTaskBetweenNodes(task.id, sourceId, targetId, docPoint);
    } else if (insertInfo.parentId) {
      const parentTask = this.projectState.tasks().find(t => t.id === insertInfo.parentId);
      if (parentTask) {
        const newStage = (parentTask.stage || 1) + 1;
        this.taskOpsAdapter.moveTaskToStage(task.id, newStage, insertInfo.beforeTaskId, insertInfo.parentId);
        this.scheduleTimer(() => {
          this.taskOpsAdapter.updateTaskPosition(task.id, docPoint.x, docPoint.y);
        }, UI_CONFIG.MEDIUM_DELAY);
      }
    } else if (insertInfo.beforeTaskId || insertInfo.afterTaskId) {
      const refTask = this.projectState.tasks().find(t => t.id === (insertInfo.beforeTaskId || insertInfo.afterTaskId));
      if (refTask?.stage) {
        this.taskOpsAdapter.moveTaskToStage(task.id, refTask.stage, insertInfo.beforeTaskId, refTask.parentId);
        this.scheduleTimer(() => {
          this.taskOpsAdapter.updateTaskPosition(task.id, docPoint.x, docPoint.y);
        }, UI_CONFIG.MEDIUM_DELAY);
      }
    } else {
      this.taskOpsAdapter.updateTaskPosition(task.id, docPoint.x, docPoint.y);
    }
  }
  
  // ========== 待分配任务点击 ==========
  
  onUnassignedTaskClick(task: Task): void {
    // 待分配任务也会在流程图中显示，直接定位到该节点
    this.centerOnNode(task.id);
  }
  
  // ========== 连接线操作 ==========
  
  confirmParentChildLink(): void {
    this.link.confirmParentChildLink();
    this.refreshDiagram();
  }
  
  confirmCrossTreeLink(): void {
    this.link.confirmCrossTreeLink();
    this.refreshDiagram();
  }
  
  // ========== 级联分配对话框（委托给 FlowCascadeAssignService） ==========
  
  /**
   * 显示级联分配确认对话框
   * 当用户将待分配任务树拖拽到阶段区域时调用
   */
  showCascadeAssignDialog(
    taskId: string,
    targetStage: number,
    targetParentId: string | null
  ): void {
    this.cascadeAssign.showDialog(taskId, targetStage, targetParentId);
  }
  
  /**
   * 确认级联分配
   */
  confirmCascadeAssign(): void {
    if (this.cascadeAssign.confirm()) {
      this.refreshDiagram();
    }
  }
  
  /**
   * 取消级联分配
   */
  cancelCascadeAssign(): void {
    this.cascadeAssign.cancel();
  }
  
  /** 保存联系块的标题和描述 */
  saveConnectionDescription(data: { title: string; description: string }): void {
    this.link.saveConnectionContent(data.title, data.description);
    this.refreshDiagram();
  }
  
  deleteConnection(): void {
    this.logger.debug('deleteConnection 被调用');
    const result = this.link.deleteCurrentConnection();
    this.logger.debug('删除结果:', result);
    if (result) {
      this.refreshDiagram();
    }
  }
  
  confirmLinkDelete(): void {
    this.logger.debug('confirmLinkDelete 被调用');
    const result = this.link.confirmLinkDelete();
    this.logger.debug('删除连接线结果:', result);
    if (result) {
      this.refreshDiagram();
    }
  }
  
  // ========== 任务操作 ==========
  
  createUnassigned(): void {
    this.taskOps.createUnassignedTask('新任务');
  }
  
  addSiblingTask(task: Task): void {
    const newTaskId = this.taskOps.addSiblingTask(task);
    if (newTaskId) {
      // 设置 selectedTaskId 会触发 effect 自动选中节点（包含重试逻辑）
      this.selectedTaskId.set(newTaskId);
      this.taskOps.focusTitleInput(this.elementRef);
    }
  }
  
  addChildTask(task: Task): void {
    const newTaskId = this.taskOps.addChildTask(task);
    if (newTaskId) {
      // 设置 selectedTaskId 会触发 effect 自动选中节点（包含重试逻辑）
      this.selectedTaskId.set(newTaskId);
      this.taskOps.focusTitleInput(this.elementRef);
    }
  }
  
  archiveTask(task: Task): void {
    const newStatus = this.taskOps.archiveTask(task);
    if (newStatus === 'archived') {
      this.selectedTaskId.set(null);
    }
  }
  
  deleteTask(task: Task): void {
    this.deleteConfirmTask.set(task);
  }
  
  confirmDelete(keepChildren: boolean): void {
    const task = this.deleteConfirmTask();
    if (task) {
      this.selectedTaskId.set(null);
      this.taskOps.deleteTask(task.id, keepChildren);
      this.deleteConfirmTask.set(null);
      this.deleteKeepChildren.set(false);
      
      // 强制刷新图表
      if (this.diagram.isInitialized) {
        this.diagram.updateDiagram(this.projectState.tasks(), true);
      }
    }
  }
  
  // ========== 批量删除操作 ==========
  
  /**
   * 展开抽屉到最佳观看高度（仅手机端）
   * 双击任务块打开详情时调用，使用与现有 effect 相同的计算逻辑
   */
  private expandDrawerToOptimalHeight(): void {
    if (typeof window === 'undefined' || window.innerHeight <= 0) return;

    // 使用与场景一（直接点击）相同的计算逻辑
    const REFERENCE_SCREEN_HEIGHT = 667;
    const REFERENCE_PALETTE_HEIGHT_PX = 80;
    const DRAWER_VH_DIRECT_CLICK = 24.88; // 直接点击场景的最佳高度
    
    const refDrawerPxDirect = (REFERENCE_SCREEN_HEIGHT * DRAWER_VH_DIRECT_CLICK) / 100;
    const ratioDirect = refDrawerPxDirect / REFERENCE_PALETTE_HEIGHT_PX;

    const palettePx = this.paletteHeight();
    const targetDrawerPx = palettePx * ratioDirect;
    const targetVh = (targetDrawerPx / window.innerHeight) * 100;
    const clampedVh = Math.max(5, Math.min(targetVh, 70));

    // 延迟设置，等待详情面板完全渲染
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.scheduleDrawerHeightUpdate(clampedVh);
      });
    });
  }
  
  // ========== 批量删除操作（委托给 FlowBatchDeleteService） ==========
  
  /**
   * 请求批量删除（由 Delete 键或工具栏按钮触发）
   */
  requestBatchDelete(): void {
    const singleTask = this.batchDelete.requestBatchDelete();
    if (singleTask) {
      // 单选时走单任务删除流程
      this.deleteTask(singleTask);
    }
  }
  
  /**
   * 确认批量删除
   */
  confirmBatchDelete(): void {
    const deletedCount = this.batchDelete.confirmBatchDelete(() => {
      this.selectedTaskId.set(null);
    });
    
    // 强制刷新图表
    if (deletedCount > 0 && this.diagram.isInitialized) {
      this.diagram.updateDiagram(this.projectState.tasks(), true);
    }
  }
  
  /**
   * 处理 Delete 键删除事件（由 GoJS commandHandler 拦截后触发）
   */
  private handleDeleteKeyPressed(): void {
    const singleTask = this.batchDelete.handleDeleteKeyPressed();
    if (singleTask) {
      this.deleteTask(singleTask);
    }
  }
  
  // ========== 框选模式（委托给 FlowSelectModeService） ==========
  
  /**
   * 切换移动端框选模式
   */
  toggleSelectMode(): void {
    this.selectMode.toggleSelectMode();
  }
  
  // ========== 调色板拖动（委托给 FlowPaletteResizeService） ==========
  
  startPaletteResize(e: MouseEvent): void {
    this.paletteResize.bindHeightSignal(this.paletteHeight);
    this.paletteResize.startMouseResize(e);
  }
  
  startPaletteResizeTouch(e: TouchEvent): void {
    this.paletteResize.bindHeightSignal(this.paletteHeight);
    this.paletteResize.startTouchResize(e);
  }
  
  // ========== 快捷键处理（委托给 FlowKeyboardService） ==========
  
  @HostListener('window:keydown', ['$event'])
  handleDiagramShortcut(event: KeyboardEvent): void {
    const result = this.keyboard.handleShortcut(event);
    if (result === 'handled') {
      this.refreshDiagram();
    }
  }
  
  // ========== 其他 ==========
  
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
    this.logger.debug('Drawer state change:', event);
    // 抽屉关闭时，可能需要刷新图表
    if (event.currentLayer === 'middle' && event.previousLayer !== 'middle') {
      // 返回中层时触发图表重绘
      requestAnimationFrame(() => {
        const diagramInstance = this.diagram.diagramInstance;
        if (diagramInstance) {
          diagramInstance.requestUpdate();
        }
      });
    }
  }
  
  /** 移动端抽屉内点击节点定位（关闭抽屉后定位） */
  onMobileDrawerCenterOnNode(taskId: string): void {
    // 延迟执行，等待抽屉关闭动画
    setTimeout(() => {
      this.centerOnNode(taskId);
    }, 350);
  }
  
  /**
   * 处理移动端抽屉区域（待分配区域、黑匣子）的滑动切换手势
   * - 向右滑动：切换到文本视图
   * - 向左滑动：打开项目侧边栏
   */
  onDrawerSwipeToSwitch(direction: 'left' | 'right'): void {
    if (direction === 'right') {
      // 向右滑动 → 切换到文本视图
      this.goBackToText.emit();
    } else if (direction === 'left') {
      // 向左滑动 → 打开项目侧边栏
      this.toggleRightPanel();
    }
  }
  
  /** 切换右侧面板（移动端） */
  toggleRightPanel(): void {
    if (this.uiState.isMobile()) {
      const willOpen = !this.isRightPanelOpen();
      // 互斥逻辑：先收起左侧调色板，再展开右侧面板（丝滑过渡）
      if (willOpen && this.isPaletteOpen()) {
        this.isPaletteOpen.set(false);
      }
      this.isRightPanelOpen.set(willOpen);
    }
  }
  
  /** 右侧面板任务点击处理 */
  onRightPanelTaskClick(taskId: string): void {
    this.selectedTaskId.set(taskId);
    this.centerOnNode(taskId, true);
    this.isRightPanelOpen.set(false);
  }
  
  /** 右侧面板项目点击处理 - 切换项目并同步 URL */
  onRightPanelProjectClick(projectId: string): void {
    // 设置活动项目 ID，触发 tasks() computed 重新计算
    this.projectState.activeProjectId.set(projectId);
    // 关闭右侧面板
    this.isRightPanelOpen.set(false);
    // 同步 URL 路由，保持当前视图类型
    const currentView = this.uiState.activeView() || 'flow';
    void this.router.navigate(['/projects', projectId, currentView]);
  }
  
  // ========== 右侧面板滑动手势（委托给 FlowSwipeGestureService） ==========
  
  onRightPanelTouchStart(e: TouchEvent): void {
    this.swipeGesture.handleRightPanelTouchStart(e);
  }
  
  onRightPanelTouchMove(e: TouchEvent): void {
    this.swipeGesture.handleRightPanelTouchMove(e);
  }
  
  onRightPanelTouchEnd(e: TouchEvent): void {
    if (this.swipeGesture.handleRightPanelTouchEnd(e) === 'close-panel') {
      this.isRightPanelOpen.set(false);
    }
  }
  
  onRightPanelBackdropTouchStart(e: TouchEvent): void {
    this.swipeGesture.handleRightPanelTouchStart(e);
  }
  
  onRightPanelBackdropTouchMove(e: TouchEvent): void {
    this.swipeGesture.handleRightPanelTouchMove(e);
  }
  
  onRightPanelBackdropTouchEnd(e: TouchEvent): void {
    if (this.swipeGesture.handleBackdropTouchEnd(e) === 'close-panel') {
      this.isRightPanelOpen.set(false);
    }
  }
  
  // ========== 流程图区域滑动手势（委托给 FlowSwipeGestureService） ==========
  
  onDiagramAreaTouchStart(e: TouchEvent): void {
    this.swipeGesture.handleDiagramAreaTouchStart(e);
  }
  
  onDiagramAreaTouchMove(e: TouchEvent): void {
    this.swipeGesture.handleDiagramAreaTouchMove(e);
  }
  
  onDiagramAreaTouchEnd(e: TouchEvent): void {
    const result = this.swipeGesture.handleDiagramAreaTouchEnd(e);
    if (result === 'right') {
      this.isRightPanelOpen.set(true);
    } else if (result === 'left') {
      this.logger.debug('滑动触发 goBackToText');
      this.goBackToText.emit();
    }
  }
  
  // ========== 私有辅助方法 ==========
  
  /**
   * 带重试逻辑的节点选中方法
   * 
   * 解决问题：创建任务后，GoJS 图表可能还未完成更新，节点不存在
   * 方案：使用多次重试 + 递增延迟，确保节点存在后再选中
   * 
   * @param taskId 要选中的任务 ID
   * @param retryCount 当前重试次数（内部使用）
   */
  private selectNodeWithRetry(taskId: string, retryCount = 0): void {
    const MAX_RETRIES = 5;
    const RETRY_DELAYS = [0, 16, 50, 100, 200]; // 渐进延迟：立即、1帧、50ms、100ms、200ms
    
    if (this.isDestroyed) return;
    
    const diagramInstance = this.diagram.diagramInstance;
    if (!diagramInstance) return;
    
    const node = diagramInstance.findNodeForKey(taskId);
    if (node) {
      // 节点存在，直接选中
      this.diagram.selectNode(taskId);
      return;
    }
    
    // 节点不存在，重试
    if (retryCount < MAX_RETRIES) {
      const delay = RETRY_DELAYS[retryCount] ?? 200;
      this.logger.debug('节点选中重试', { taskId, retryCount, delay });
      
      if (delay === 0) {
        // 使用 rAF 等待下一帧，追踪 ID 以便销毁时取消
        const rafId = requestAnimationFrame(() => {
          // 从追踪列表中移除
          const idx = this.pendingRetryRafIds.indexOf(rafId);
          if (idx > -1) this.pendingRetryRafIds.splice(idx, 1);
          // 再次检查销毁状态
          if (this.isDestroyed) return;
          this.selectNodeWithRetry(taskId, retryCount + 1);
        });
        this.pendingRetryRafIds.push(rafId);
      } else {
        // 使用定时器延迟重试
        this.scheduleTimer(() => {
          this.selectNodeWithRetry(taskId, retryCount + 1);
        }, delay);
      }
    } else {
      // 所有重试失败，记录警告
      this.logger.warn('节点选中失败：节点不存在（已重试 ' + MAX_RETRIES + ' 次）', { taskId });
    }
  }
  
  /**
   * 安全调度定时器，自动追踪并在组件销毁时清理
   * @param callback 回调函数
   * @param delay 延迟毫秒数
   * @returns 定时器 ID
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
