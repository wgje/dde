import { Injectable, inject, signal, NgZone, effect, ElementRef } from '@angular/core';
import { UiStateService } from '../../../../services/ui-state.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { ThemeService } from '../../../../services/theme.service';
import { FlowLayoutService } from './flow-layout.service';
import { FlowSelectionService } from './flow-selection.service';
import { FlowZoomService, type ViewState } from './flow-zoom.service';
import { FlowEventService } from './flow-event.service';
import { FlowTemplateService } from './flow-template.service';
import { FlowLinkTemplateService } from './flow-link-template.service';
import { FlowOverviewService } from './flow-overview.service';
import { FlowDiagramDataService } from './flow-diagram-data.service';
import { FlowDiagramFontRedrawService } from './flow-diagram-font-redraw.service';
import { FlowTouchService } from './flow-touch.service';
import {
  FlowDiagramOverviewCoordinatorService,
  type FlowDiagramOverviewRuntime,
} from './flow-diagram-overview-coordinator.service';
import type { FlowRelationDisplayMode } from './flow-diagram-config.service';
import { flowTemplateEventHandlers } from './flow-template-events';
import { installDragOutOfBoundsTool } from './flow-drag-out-of-bounds.helpers';
import { installFlowDiagramDropHandlers } from './flow-diagram-drop.helpers';
import {
  setupDesktopPanAndSelectTools,
  setupMultiSelectClickTool,
} from './flow-diagram-interaction-tools.helpers';
import {
  createFlowDiagram,
  initializeFlowDiagramModel,
  installFlowDiagramRouters,
  setupFlowDiagramCommandInterception,
} from './flow-diagram-setup.helpers';
import {
  applyFlowDiagramCanvasBackground,
  refreshFlowDiagramTheme,
} from './flow-diagram-theme.helpers';
import {
  isSafeFlowDiagramSize,
} from './flow-diagram-view-state.helpers';
import { FlowDiagramRecoveryController, type FlowDiagramHardRecoveryToken } from './flow-diagram-recovery.controller';
import type { FlowTheme } from '../../../../config/flow-styles';
import { Task } from '../../../../models';
import { environment } from '../../../../environments/environment';
import { UI_CONFIG } from '../../../../config';
import { ProjectStateService } from '../../../../services/project-state.service';
import * as go from 'gojs';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';

/**
 * FlowDiagramService - GoJS 图表核心服务（精简版）
 * 
 * 重构后职责：
 * - GoJS Diagram 实例的生命周期管理
 * - 小地图 (Overview) 管理
 * - 拖放支持
 * 
 * 已委托的职责：
 * - 数据同步/导出/视图状态 → FlowDiagramDataService
 * - 模板配置 → FlowTemplateService
 * - 事件处理 → FlowEventService
 * - 布局操作 → FlowLayoutService
 * - 选择管理 → FlowSelectionService
 * - 缩放控制 → FlowZoomService
 */
@Injectable({
  providedIn: 'root'
})
export class FlowDiagramService {
  private static readonly MAX_HARD_RECOVERY_ATTEMPTS = 2;

  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly uiState = inject(UiStateService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowDiagram');
  private readonly toast = inject(ToastService);
  private readonly zone = inject(NgZone);
  private readonly themeService = inject(ThemeService);
  private readonly projectState = inject(ProjectStateService);
  
  // ========== 委托的子服务 ==========
  private readonly layoutService = inject(FlowLayoutService);
  private readonly selectionService = inject(FlowSelectionService);
  private readonly zoomService = inject(FlowZoomService);
  private readonly eventService = inject(FlowEventService);
  private readonly templateService = inject(FlowTemplateService);
  private readonly linkTemplateService = inject(FlowLinkTemplateService);
  private readonly overviewService = inject(FlowOverviewService);
  private readonly dataService = inject(FlowDiagramDataService);
  private readonly fontRedrawService = inject(FlowDiagramFontRedrawService);
  private readonly overviewCoordinator = inject(FlowDiagramOverviewCoordinatorService);
  private readonly touchService = inject(FlowTouchService);
  
  // ========== 内部状态 ==========
  private diagram: go.Diagram | null = null;
  private diagramDiv: HTMLDivElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private isDestroyed = false;
  private hardRecoveryGeneration = 0;
  private readonly hardRecoveryHold = signal<FlowDiagramHardRecoveryToken | null>(null);
  
  // ========== 定时器 ==========
  private resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly recovery = new FlowDiagramRecoveryController(
    this.zone,
    FlowDiagramService.MAX_HARD_RECOVERY_ATTEMPTS,
    {
      getDiagram: () => this.diagram,
      getDiagramDiv: () => this.diagramDiv,
      isDestroyed: () => this.isDestroyed,
      getPersistedViewState: () => this.projectState.getViewState() as ViewState | null,
      getSelectedNodeKeys: () => this.selectionService.getSelectedNodeKeys(),
      getShouldRestoreOverview: () => this.overviewCoordinator.shouldRestore,
      getOverviewContainer: () => this.overviewCoordinator.container,
      updateDiagram: forceRefresh => this.updateDiagram(this.projectState.tasks(), forceRefresh),
      applyHardRecoveryViewport: (viewState, complete) => this.dataService.applyHardRecoveryViewport(viewState, complete),
      completeHardRecovery: proof => this.dataService.completeHardRecovery(proof),
      abortHardRecovery: token => this.abortHardRecovery(token),
      restoreOverviewAfterRecovery: container => this.restoreOverviewAfterRecovery(container),
      attemptPendingOverviewRestore: () => this.attemptPendingOverviewRestore(),
      teardownDiagramForRecovery: () => this.teardownDiagramForRecovery(),
      initializeOutsideZone: (container, token) => this._initializeOutsideZone(container, token),
      beginHardRecovery: () => this.beginHardRecovery(),
      isHardRecoveryCurrent: token => this.isHardRecoveryCurrent(token),
      releaseHardRecovery: token => this.releaseHardRecovery(token),
      cleanupFailedHardRecovery: () => this.cleanupFailedHardDiagramRecovery(),
      restoreDropHandler: () => {
        if (this.diagramDropHandler) this.setupDropHandler(this.diagramDropHandler);
      },
      selectMultiple: keys => this.selectionService.selectMultiple(keys),
      requestFitToContents: () => this.zoomService.fitToContents(),
      requestCancelPendingViewStateSave: () => {
        this.dataService.cancelPendingViewStateSave();
        this.zoomService.cancelPendingViewStateSave();
      },
      saveViewState: () => this.dataService.saveViewState(),
      refreshOverview: () => this.overviewService.refreshOverview(),
      info: (message, context) => this.logger.info(message, context),
      warn: (message, context) => this.logger.warn(message, context),
      error: (message, context) => this.logger.error(message, context),
      captureException: (error, context) => this.sentryLazyLoader.captureException(error, context),
    },
  );
  
  // ========== 僵尸模式 ==========
  private isSuspended = false;
  private suspendedResizeObserver: ResizeObserver | null = null;

  // ========== 事件处理器引用（用于销毁时清理） ==========
  /** ViewportBoundsChanged 监听器引用，防止泄漏 */
  private viewportBoundsHandler: ((e: go.DiagramEvent) => void) | null = null;
  /** rAF 合并 ViewportBoundsChanged 的调度句柄（避免 panning 时每帧都跑视图持久化） */
  private viewportBoundsRafId: number | null = null;

  // ========== 主题变化监听 ==========
  private themeChangeEffect = effect(() => {
    // 监听颜色模式变化，触发 GoJS 重绘
    const isDark = this.themeService.isDark();
    const theme = this.themeService.theme();
    
    // 只在 diagram 已初始化时重绘
    if (this.diagram && !this.isDestroyed && !this.isSuspended) {
      this.zone.runOutsideAngular(() => {
        refreshFlowDiagramTheme({
          diagram: this.diagram!,
          theme: theme as FlowTheme,
          isDark,
          setupNodeTemplate: diagram => this.templateService.setupNodeTemplate(diagram as go.Diagram),
          setupLinkTemplate: diagram => this.linkTemplateService.setupLinkTemplate(diagram as go.Diagram),
          updateOverviewTheme: () => this.overviewService.updateTheme(),
          debug: (message, context) => this.logger.debug(message, context),
        });
      });
    }
  });
  
  // ========== 公开信号 ==========
  readonly error = signal<string | null>(null);
  
  // ========== 公开属性 ==========
  
  get diagramInstance(): go.Diagram | null {
    return this.diagram;
  }
  
  get isInitialized(): boolean {
    const hold = this.hardRecoveryHold();
    if (!hold) return this.diagram !== null && !this.isDestroyed;
    if (this.projectState.isActiveProjectOwnerCurrent(hold.owner)) return false;
    this.hardRecoveryHold.set(null);
    this.dataService.abortHardRecovery();
    return this.diagram !== null && !this.isDestroyed;
  }

  get activeProjectId(): string | null {
    return this.projectState.activeProjectId();
  }
  
  get isSuspendedMode(): boolean {
    return this.isSuspended;
  }

  private overviewRuntime(): FlowDiagramOverviewRuntime {
    return {
      isInitialized: () => this.isInitialized,
      initializeOverview: (container) => this.initializeOverview(container),
    };
  }
  
  // ========== 生命周期方法 ==========
  
  /**
   * 初始化 GoJS Diagram
   * 
   * 【2026-02-25 性能优化】整个初始化在 NgZone 外部执行
   * GoJS 内部所有鼠标移动、画布重绘、工具激活（拖拽/平移/连线）
   * 都不再触发 Angular 变更检测，显著降低 50+ 节点时的交互卡顿。
   * 需要触发 CD 的回调（节点点击等）在 FlowEventService 中显式 zone.run()。
   */
  initialize(container: HTMLDivElement): boolean {
    if (typeof go === 'undefined') {
      this.handleError('GoJS 库未加载', 'GoJS library not loaded');
      return false;
    }

    this.retireHardRecovery();
    this.recovery.resetForInitialize(container);
    
    // 【性能关键】在 Angular Zone 外部创建和配置 GoJS Diagram
    // 避免 GoJS 内部事件（鼠标移动、canvas 重绘、工具切换等）触发不必要的变更检测
    return this.zone.runOutsideAngular(() => this._initializeOutsideZone(container));
  }

  /**
   * 在 NgZone 外部执行的 Diagram 初始化逻辑
   */
  private _initializeOutsideZone(container: HTMLDivElement, recoveryToken?: FlowDiagramHardRecoveryToken): boolean {
    try {
      this.prepareDiagramInitialization(container, recoveryToken);
      this.diagram = createFlowDiagram(container);
      const isMobile = this.uiState.isMobile();

      this.configureDiagramTemplatesAndTools(this.diagram, isMobile);
      initializeFlowDiagramModel(this.diagram);
      installFlowDiagramRouters(this.diagram, this.logger);
      this.connectInitializedDiagram(this.diagram);
      this.error.set(null);
      this.logger.info('GoJS Diagram 初始化成功');
      return true;
      
    } catch (error) {
      this.sentryLazyLoader.captureException(error, { tags: { operation: 'initDiagram' } });
      this.handleError('流程图初始化失败', error);
      return false;
    }
  }

  private prepareDiagramInitialization(container: HTMLDivElement, recoveryToken?: FlowDiagramHardRecoveryToken): void {
    this.isDestroyed = false;
    this.diagramDiv = container;
    this.recovery.resetForInitialize(container, recoveryToken);

    if (environment.gojsLicenseKey) {
      (go.Diagram as unknown as { licenseKey: string }).licenseKey = environment.gojsLicenseKey;
    }
  }

  private configureDiagramTemplatesAndTools(diagram: go.Diagram, isMobile: boolean): void {
    if (diagram.toolManager.contextMenuTool) {
      diagram.toolManager.contextMenuTool.isEnabled = false;
    }

    this.templateService.ensureDiagramLayers(diagram);
    this.templateService.setupNodeTemplate(diagram);
    this.linkTemplateService.setupLinkTemplate(diagram);

    if (isMobile) {
      diagram.toolManager.dragSelectingTool.isEnabled = false;
      diagram.toolManager.panningTool.isEnabled = true;
    } else {
      setupDesktopPanAndSelectTools(diagram);
    }

    setupMultiSelectClickTool(diagram, this.uiState.isMobile(), this.logger);

    if (!isMobile) {
      this.setupDragOutOfBoundsTool(diagram);
    }
  }

  private connectInitializedDiagram(diagram: go.Diagram): void {
    setupFlowDiagramCommandInterception(diagram, this.logger);
    this.eventService.setDiagram(diagram, this.diagramDiv);
    this.viewportBoundsHandler = () => {
      this.handleViewportBoundsChanged();
    };
    diagram.addDiagramListener('ViewportBoundsChanged', this.viewportBoundsHandler);

    // 移动端拖拽幽灵监听必须跟随 diagram 实例接入：硬恢复原地重建后组件层不会再次
    // initDiagram，若不在这里补装，SelectionMoved 幽灵清理会留在已销毁的旧实例上
    //（installDiagramDragGhostListeners 自身幂等，组件层的重复安装会被跳过）
    this.touchService.installDiagramDragGhostListeners(diagram, this.uiState.isMobile());

    this.setupResizeObserver();
    this.dataService.setDiagram(diagram);
    this.layoutService.setDiagram(diagram);
    this.selectionService.setDiagram(diagram);
    this.zoomService.setDiagram(diagram);
    this.zoomService.setViewStatePersistenceGuard(() => this.canPersistViewState());
    this.dataService.restoreViewState();
    this.applyCanvasBackground();
    this.schedulePostFontLoadRedraw();
  }

  /**
   * 【2026-03-04】自定义 DraggingTool：检测节点拖出画布边界
   * 
   * 问题根因：GoJS DraggingTool 在内部处理拖拽，节点始终保持在 Canvas 内部，
   * 无法跨越到 HTML DOM 元素（如停泊坞 drop-zone）。
   * 用户 Ctrl+Click 选中多个节点后拖动，节点向下移动但永远到不了停泊坞。
   * 
   * 解决方案：
   * 1. 覆盖 DraggingTool.doMouseMove，在每次拖拽移动时检测鼠标是否超出画布边界
   * 2. 当鼠标移出画布底部/左/右边界时，取消 GoJS 内部拖拽（doCancel）
   * 3. 收集当前选中的所有节点 task ID，启动指针跟踪式拖入停泊坞流程
   * 4. 还原节点原始位置，避免 GoJS 内部状态与 Store 不一致
   */
  private setupDragOutOfBoundsTool(diagram: go.Diagram): void {
    installDragOutOfBoundsTool(diagram, {
      getDiagramDiv: () => this.diagramDiv,
      logger: this.logger,
      onNodesDragOutOfBounds: (selectedTaskIds, mouseClientX, mouseClientY) => {
        flowTemplateEventHandlers.onNodesDragOutOfBounds?.(selectedTaskIds, mouseClientX, mouseClientY);
      },
    });
  }
  
  /**
   * 暂停图表（僵尸模式）
   */
  suspend(): void {
    if (!this.diagram || this.isSuspended) return;
    
    try {
      this.logger.info('进入僵尸模式');
      
      this.diagram.isReadOnly = true;
      this.diagram.animationManager.isEnabled = false;
      
      if (this.resizeObserver) {
        this.suspendedResizeObserver = this.resizeObserver;
        this.resizeObserver.disconnect();
        this.resizeObserver = null;
      }
      
      this.clearAllTimers();

      this.isSuspended = true;
    } catch (error) {
      this.logger.error('暂停图表失败:', error);
    }
  }
  
  /**
   * 恢复图表
   */
  resume(): void {
    if (!this.diagram || !this.isSuspended) return;
    
    try {
      this.logger.info('退出僵尸模式');
      
      this.isSuspended = false;
      this.diagram.isReadOnly = false;
      this.diagram.animationManager.isEnabled = false;
      
      if (this.suspendedResizeObserver && this.diagramDiv) {
        this.resizeObserver = this.suspendedResizeObserver;
        this.resizeObserver.observe(this.diagramDiv);
        this.suspendedResizeObserver = null;
      } else if (!this.resizeObserver && this.diagramDiv) {
        this.setupResizeObserver();
      }
      
      this.diagram.requestUpdate();

      // 【2026-02-25 性能优化】恢复时仅请求一次更新，不再全量 invalidateRoute
      // GoJS 在 requestUpdate() 时会自动重新路由需要更新的链接
      this.zone.runOutsideAngular(() => {
        requestAnimationFrame(() => {
          if (!this.diagram || this.isDestroyed) return;
          this.diagram.requestUpdate();
        });
      });
    } catch (error) {
      this.logger.error('恢复图表失败:', error);
    }
  }
  
  // ========== 小地图 ==========
  
  initializeOverview(container: HTMLDivElement): void {
    if (!this.diagram || this.isDestroyed) return;

    this.overviewCoordinator.setInitializedContainer(container);
    this.overviewService.setDiagram(this.diagram);
    const isMobile = this.uiState.isMobile();
    this.overviewService.initializeOverview(container, isMobile);
  }
  
  /**
   * 应用画布背景色（根据当前主题）
   */
  private applyCanvasBackground(): void {
    applyFlowDiagramCanvasBackground(
      this.diagram,
      this.themeService.theme() as FlowTheme,
      this.themeService.isDark(),
    );
  }

  private schedulePostFontLoadRedraw(): void {
    this.fontRedrawService.schedulePostFontLoadRedraw(
      () => this.diagram,
      () => this.isDestroyed || this.isSuspended,
    );
  }

  private cleanupFontLoadListener(): void {
    this.fontRedrawService.cleanupFontLoadListener();
  }
  
  disposeOverview(): void {
    this.overviewCoordinator.markDisposed();
    this.overviewService.destroyOverview();
  }
  
  refreshOverview(): void {
    this.overviewService.refreshOverview();
  }

  public syncViewportMetrics(): void {
    this.recovery.syncViewportMetrics();
  }

  /** 调度小地图初始化（idle 优先） */
  scheduleOverviewInit(
    overviewDiv: ElementRef | undefined,
    isVisible: boolean,
    isCollapsed: boolean,
    zone: NgZone,
    scheduleTimer: (cb: () => void, delay: number) => void,
    immediate = false
  ): void {
    this.overviewCoordinator.scheduleOverviewInit(
      overviewDiv,
      isVisible,
      isCollapsed,
      zone,
      scheduleTimer,
      this.overviewRuntime(),
      immediate,
    );
  }

  cancelIdleOverviewInit(): void {
    this.overviewCoordinator.cancelIdleOverviewInit();
  }

  dispose(): void {
    this.isDestroyed = true;
    this.retireHardRecovery();
    this.recovery.resetForDispose();
    this.overviewCoordinator.reset();
    
    // 清理数据服务
    this.dataService.dispose();
    this.templateService.closeSiyuanPopover();
    
    this.disposeOverview();
    this.clearAllTimers();
    // 【修复 2026-02-20】清理字体加载事件监听
    this.cleanupFontLoadListener();
    
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    
    // 【P1-11 修复】清理 drop 事件监听器
    this.dropHandlerCleanup?.();
    this.dropHandlerCleanup = null;
    this.diagramDropHandler = null;
    
    // 清理事件服务
    this.eventService.dispose();
    
    if (this.diagram) {
      // 【修复 C-07】显式移除 ViewportBoundsChanged 监听器，防止泄漏
      if (this.viewportBoundsHandler) {
        this.diagram.removeDiagramListener('ViewportBoundsChanged', this.viewportBoundsHandler);
        this.viewportBoundsHandler = null;
      }
      if (this.viewportBoundsRafId !== null) {
        cancelAnimationFrame(this.viewportBoundsRafId);
        this.viewportBoundsRafId = null;
      }
      // 顺序：先移除监听器 → clear 清除数据 → div = null 断开 DOM
      this.diagram.clear();
      this.diagram.div = null;
      this.diagram = null;
    }
    
    this.diagramDiv = null;
    
    // 清理子服务
    this.layoutService.dispose();
    this.selectionService.setDiagram(null);
    this.zoomService.setViewStatePersistenceGuard(null);
    this.zoomService.dispose();
    
    this.logger.info('GoJS Diagram 已销毁');
  }
  
  // ========== 导出功能（委托给 FlowDiagramDataService） ==========
  
  async exportToPng(): Promise<Blob | null> {
    return this.dataService.exportToPng();
  }
  
  async exportToSvg(): Promise<Blob | null> {
    return this.dataService.exportToSvg();
  }
  
  // ========== 图表操作 ==========
  
  /**
   * 移除连接线
   */
  removeLink(link: go.Link): void {
    if (this.diagram && link) {
      const model = this.diagram.model as go.GraphLinksModel;
      if (link.data && model.linkDataArray) {
        this.diagram.startTransaction('remove-link');
        model.removeLinkData(link.data);
        this.diagram.commitTransaction('remove-link');
      } else {
        this.diagram.remove(link);
      }
    }
  }
  
  /**
   * 选中指定节点
   */
  selectNode(nodeKey: string): void {
    this.selectionService.selectNode(nodeKey, true);
  }
  
  /**
   * 获取最后的输入点
   */
  getLastInputViewPoint(): go.Point | null {
    return this.diagram?.lastInput?.viewPoint || null;
  }
  
  /**
   * 由外部在 Flow 视图激活时调用（委托给 FlowDiagramDataService）
   */
  onFlowActivated(): void {
    this.dataService.onFlowActivated();
  }
  
  // ========== 图表数据更新（委托给 FlowDiagramDataService） ==========

  /**
   * 更新图表数据
   */
  updateDiagram(tasks: Task[], forceRefresh: boolean = false): boolean {
    return this.dataService.updateDiagram(tasks, forceRefresh);
  }

  setRelationDisplayMode(mode: FlowRelationDisplayMode, focusedTaskId: string | null): void {
    const changed = this.dataService.setRelationDisplayMode(mode, focusedTaskId);
    if (changed && this.isInitialized) {
      this.updateDiagram(this.projectState.tasks(), true);
    }
  }
  
  // ========== 拖放支持 ==========
  
  // 【P1-11 修复】保存事件监听器引用，用于 dispose 时清理
  private dropHandlerCleanup: (() => void) | null = null;
  private diagramDropHandler: ((taskData: Task, docPoint: go.Point) => void) | null = null;

  setupDropHandler(onDrop: (taskData: Task, docPoint: go.Point) => void): void {
    if (!this.diagram || !this.diagramDiv) return;

    this.diagramDropHandler = onDrop;
    
    // 【P1-11 修复】先清理旧的监听器，防止重复注册
    this.dropHandlerCleanup?.();

    this.dropHandlerCleanup = installFlowDiagramDropHandlers({
      diagram: this.diagram,
      diagramDiv: this.diagramDiv,
      projectState: this.projectState,
      logger: this.logger,
      sentryLazyLoader: this.sentryLazyLoader,
      onDrop,
    });
  }
  
  // ========== 私有方法 ==========
  
  private setupResizeObserver(): void {
    if (!this.diagramDiv) return;
    
    this.resizeObserver = new ResizeObserver((entries) => {
      if (this.isDestroyed || this.recovery.isHardRecoveryInProgress) {
        return;
      }

      const latestEntry = entries[entries.length - 1];
      const entryWidth = latestEntry?.contentRect.width ?? this.diagramDiv?.clientWidth ?? 0;
      const entryHeight = latestEntry?.contentRect.height ?? this.diagramDiv?.clientHeight ?? 0;

      if (!isSafeFlowDiagramSize(entryWidth, entryHeight)) {
        this.recovery.armResizeRecovery();
      }

      if (this.resizeDebounceTimer !== null) {
        clearTimeout(this.resizeDebounceTimer);
      }
      
      this.resizeDebounceTimer = setTimeout(() => {
        this.syncViewportMetrics();
      }, UI_CONFIG.RESIZE_DEBOUNCE_DELAY);
    });
    
    this.resizeObserver.observe(this.diagramDiv);
  }
  
  private clearAllTimers(): void {
    if (this.resizeDebounceTimer !== null) {
      clearTimeout(this.resizeDebounceTimer);
      this.resizeDebounceTimer = null;
    }
    this.recovery.cancelScheduledRecovery();
    this.dataService.clearTimers();
  }

  private handleViewportBoundsChanged(): void {
    // 【2026-04-24 性能优化】panning 期间此事件按 ~60Hz 触发，
    // 原实现每帧都 captureStableViewState + saveViewState(内部 clear/set setTimeout)
    // 会放大 Angular Zone setTimeout 的 patch 开销，造成 30+ 节点拖拽时的"拖尾"。
    // 使用 rAF 合并同帧内多次触发，只在真正有新帧时落地。
    if (this.viewportBoundsRafId !== null) return;
    this.viewportBoundsRafId = requestAnimationFrame(() => {
      this.viewportBoundsRafId = null;
      this.recovery.captureStableViewState();
      if (!this.recovery.canPersistViewState()) {
        return;
      }
      this.dataService.saveViewState();
    });
  }

  private cleanupFailedHardDiagramRecovery(): void {
    this.dataService.setDiagram(null);
    this.layoutService.setDiagram(null);
    this.selectionService.setDiagram(null);
    this.zoomService.setDiagram(null);
  }

  private teardownDiagramForRecovery(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    this.suspendedResizeObserver = null;
    this.clearAllTimers();
    this.cleanupFontLoadListener();
    this.dropHandlerCleanup?.();
    this.dropHandlerCleanup = null;
    this.cancelIdleOverviewInit();
    this.overviewService.destroyOverview();
    this.overviewService.setDiagram(null);
    this.dataService.clearTimers();
    this.zoomService.cancelPendingViewStateSave();
    this.zoomService.setViewStatePersistenceGuard(null);
    // 先按旧实例卸载幽灵监听并清掉残留幽灵元素，否则 FlowTouchService 持有的旧监听引用
    // 会让重建后的 installDiagramDragGhostListeners 因幂等守卫拒绝在新实例上安装
    this.touchService.uninstallDiagramDragGhostListeners(this.diagram);
    this.touchService.endDiagramNodeDragGhost();

    if (!this.diagram) {
      return;
    }

    if (this.viewportBoundsHandler) {
      this.diagram.removeDiagramListener('ViewportBoundsChanged', this.viewportBoundsHandler);
      this.viewportBoundsHandler = null;
    }

    this.eventService.setDiagram(null);
    this.selectionService.setDiagram(null);
    this.layoutService.setDiagram(null);
    this.zoomService.setDiagram(null);

    this.diagram.clear();
    this.diagram.div = null;
    this.diagram = null;
  }

  private restoreOverviewAfterRecovery(container: HTMLDivElement, retriesLeft: number = 3): void {
    this.overviewCoordinator.restoreOverviewAfterRecovery(
      container,
      this.overviewRuntime(),
      (callback) => this.zone.runOutsideAngular(() => requestAnimationFrame(callback)),
      () => this.isDestroyed,
      retriesLeft,
    );
  }

  private attemptPendingOverviewRestore(): void {
    this.overviewCoordinator.attemptPendingOverviewRestore(
      this.overviewRuntime(),
      this.overviewService.isOverviewInitialized,
    );
  }

  private canPersistViewState(): boolean {
    return this.recovery.canPersistViewState();
  }
  private beginHardRecovery(): FlowDiagramHardRecoveryToken | null {
    const owner = this.projectState.captureActiveProjectOwner();
    if (!owner.projectId || !this.projectState.isActiveProjectOwnerCurrent(owner)
      || !this.dataService.beginHardRecovery()) return null;
    const token = { projectId: owner.projectId, generation: ++this.hardRecoveryGeneration, owner: Object.freeze({ ...owner }) };
    this.hardRecoveryHold.set(token);
    return token;
  }

  private isHardRecoveryCurrent(token: FlowDiagramHardRecoveryToken): boolean {
    const current = this.hardRecoveryHold();
    if (current && !this.projectState.isActiveProjectOwnerCurrent(current.owner)) {
      this.hardRecoveryHold.set(null);
      this.dataService.abortHardRecovery();
    }
    return this.hardRecoveryHold() === token
      && this.projectState.isActiveProjectOwnerCurrent(token.owner);
  }

  private releaseHardRecovery(token: FlowDiagramHardRecoveryToken): boolean {
    if (!this.isHardRecoveryCurrent(token)) return false;
    this.hardRecoveryHold.set(null);
    return true;
  }

  private retireHardRecovery(): void {
    if (this.hardRecoveryHold()) this.dataService.abortHardRecovery();
    this.hardRecoveryHold.set(null);
  }

  private abortHardRecovery(token: FlowDiagramHardRecoveryToken): void {
    if (this.hardRecoveryHold() !== token) return;
    this.dataService.abortHardRecovery();
    this.hardRecoveryHold.set(null);
  }
  
  private handleError(userMessage: string, error: unknown): void {
    const _errorStr = error instanceof Error ? error.message : String(error);
    this.logger.error(`❌ Flow diagram error: ${userMessage}`, error);
    this.error.set(userMessage);
    this.toast.error('流程图错误', `${userMessage}。请刷新页面重试。`);
  }

  /**
   * 获取当前流程图停泊快照（A5.2.5）
   * 用于 ContextRestoreService 保存 flow 视图状态
   */
  getFlowParkingSnapshot(): { scale: number; selectedNodeId: string | null } | null {
    if (!this.diagram || this.isDestroyed) return null;
    const scale = this.zoomService.getZoom();
    const selectedKeys = this.selectionService.getSelectedNodeKeys();
    return {
      scale,
      selectedNodeId: selectedKeys.length === 1 ? selectedKeys[0] : null,
    };
  }
}
