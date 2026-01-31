import { Injectable, inject, signal, NgZone, effect } from '@angular/core';
import { ProjectStateService } from '../../../../services/project-state.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { SyncCoordinatorService } from '../../../../services/sync-coordinator.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { ThemeService } from '../../../../services/theme.service';
import { FlowDiagramConfigService } from './flow-diagram-config.service';
import { FlowLayoutService } from './flow-layout.service';
import { FlowSelectionService } from './flow-selection.service';
import { FlowZoomService } from './flow-zoom.service';
import { FlowEventService } from './flow-event.service';
import { FlowTemplateService } from './flow-template.service';
import { FlowOverviewService } from './flow-overview.service';
import { flowTemplateEventHandlers } from './flow-template-events';
import { getFlowStyles, FlowTheme } from '../../../../config/flow-styles';
import { MinimapMathService } from './minimap-math.service';
import { Task } from '../../../../models';
import { environment } from '../../../../environments/environment';
import { UI_CONFIG } from '../../../../config';
import * as go from 'gojs';
import * as Sentry from '@sentry/angular';

/**
 * 视图状态（用于保存/恢复）
 * @internal 仅用于文档目的
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface ViewState {
  scale: number;
  positionX: number;
  positionY: number;
}

/**
 * FlowDiagramService - GoJS 图表核心服务（精简版）
 * 
 * 重构后职责：
 * - GoJS Diagram 实例的生命周期管理
 * - 小地图 (Overview) 管理
 * - 图表数据更新
 * - 视图状态保存/恢复
 * - 导出功能
 * 
 * 已委托的职责：
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
  private readonly projectState = inject(ProjectStateService);
  private readonly uiState = inject(UiStateService);
  private readonly taskOps = inject(TaskOperationAdapterService);
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowDiagram');
  private readonly toast = inject(ToastService);
  private readonly zone = inject(NgZone);
  private readonly configService = inject(FlowDiagramConfigService);
  private readonly themeService = inject(ThemeService);
  
  // ========== 委托的子服务 ==========
  private readonly layoutService = inject(FlowLayoutService);
  private readonly selectionService = inject(FlowSelectionService);
  private readonly zoomService = inject(FlowZoomService);
  private readonly eventService = inject(FlowEventService);
  private readonly templateService = inject(FlowTemplateService);
  private readonly overviewService = inject(FlowOverviewService);
  
  // TODO: 后续重构可将 calculateExtendedBounds 等边界计算逻辑迁移到 MinimapMathService
  // 这将提高可维护性和可测试性（可以独立单元测试，无需 DOM/Canvas）
  private readonly minimapMath = inject(MinimapMathService);
  
  // ========== 内部状态 ==========
  private diagram: go.Diagram | null = null;
  private diagramDiv: HTMLDivElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private isDestroyed = false;
  
  // ========== 小地图状态 ==========
  private overview: go.Overview | null = null;
  private overviewContainer: HTMLDivElement | null = null;


  


  
  
  
  // ========== 定时器 ==========
  private resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private viewStateSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private restoreViewStateTimer: ReturnType<typeof setTimeout> | null = null;
  private autoFitTimer: ReturnType<typeof setTimeout> | null = null;

  // ========== 视图切换稳定性 ==========
  private pendingAutoFitToContents = false;
  
  // ========== 首次加载标志 ==========
  private isFirstLoad = true;
  private _familyColorLogged = false;
  
  // ========== 僵尸模式 ==========
  private isSuspended = false;
  private suspendedResizeObserver: ResizeObserver | null = null;
  
  // ========== 主题变化监听 ==========
  private themeChangeEffect = effect(() => {
    // 监听颜色模式变化，触发 GoJS 重绘
    const isDark = this.themeService.isDark();
    const theme = this.themeService.theme();
    
    // 只在 diagram 已初始化时重绘
    if (this.diagram && !this.isDestroyed && !this.isSuspended) {
      this.zone.runOutsideAngular(() => {
        // 重新设置模板并更新绑定
        this.templateService.setupNodeTemplate(this.diagram!);
        this.templateService.setupLinkTemplate(this.diagram!);
        
        // 更新所有节点和连接线的绑定
        this.diagram!.updateAllTargetBindings();
        
        // 更新画布背景色
        const flowStyles = getFlowStyles(theme as FlowTheme, isDark ? 'dark' : 'light');
        this.diagram!.div!.style.backgroundColor = flowStyles.canvas.background;
        
        // 更新 Overview（委托给 FlowOverviewService）
        this.overviewService.updateTheme();
        
        this.logger.debug('主题变化触发 GoJS 重绘', { isDark, theme });
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
    return this.diagram !== null && !this.isDestroyed;
  }
  
  get isSuspendedMode(): boolean {
    return this.isSuspended;
  }
  
  // ========== 生命周期方法 ==========
  
  /**
   * 初始化 GoJS Diagram
   */
  initialize(container: HTMLDivElement): boolean {
    if (typeof go === 'undefined') {
      this.handleError('GoJS 库未加载', 'GoJS library not loaded');
      return false;
    }
    
    try {
      this.isDestroyed = false;
      this.isFirstLoad = true;
      this.diagramDiv = container;
      
      if (environment.gojsLicenseKey) {
        (go.Diagram as unknown as { licenseKey: string }).licenseKey = environment.gojsLicenseKey;
      }
      
      const $ = go.GraphObject.make;
      
      // 创建 Diagram 实例
      this.diagram = $(go.Diagram, container, {
        "undoManager.isEnabled": false,
        "animationManager.isEnabled": false,
        "allowDrop": true,
        layout: $(go.Layout),
        "autoScale": go.Diagram.None,
        "initialAutoScale": go.Diagram.None,
        // 无限画布：使用 InfiniteScroll 模式，允许视口自由移动到任何位置
        "scrollMode": go.Diagram.InfiniteScroll,
        "scrollMargin": new go.Margin(Infinity, Infinity, Infinity, Infinity),
        "draggingTool.isGridSnapEnabled": false,
        "fixedBounds": new go.Rect(NaN, NaN, NaN, NaN),
        "computePixelRatio": () => window.devicePixelRatio || 1,
        // 减少 tooltip 悬停延迟（默认 850ms，改为 200ms）
        "toolManager.hoverDelay": 200
      });

      const isMobile = this.uiState.isMobile();

      // 【关键】在设置模板之前先配置 ToolManager
      // 某些移动端环境（Android 6.0 / Chrome Mobile）在 setupLinkTemplate 创建 contextMenu 时
      // 会内部访问 contextMenuTool.isEnabled，如果此时未初始化会抛出错误
      // 参见 Sentry: "Trying to set undefined property contextMenuTool.isEnabled"
      if (this.diagram.toolManager.contextMenuTool) {
        this.diagram.toolManager.contextMenuTool.isEnabled = false;
      }
      
      // 委托给 FlowTemplateService 设置图层和模板
      this.templateService.ensureDiagramLayers(this.diagram);
      this.templateService.setupNodeTemplate(this.diagram);
      this.templateService.setupLinkTemplate(this.diagram);
      
      // 配置工具行为：桌面端左键平移、右键框选；移动端保持原策略
      if (isMobile) {
        this.diagram.toolManager.dragSelectingTool.isEnabled = false;
        this.diagram.toolManager.panningTool.isEnabled = true;
      } else {
        this.setupDesktopPanAndSelectTools(this.diagram);
      }
      this.setupMultiSelectClickTool(this.diagram);
      
      // 初始化模型
      this.diagram!.model = new go.GraphLinksModel([], [], {
        linkKeyProperty: 'key',
        nodeKeyProperty: 'key',
        linkFromPortIdProperty: 'fromPortId',
        linkToPortIdProperty: 'toPortId'
      });
      
      // 【关键】拦截 GoJS 默认删除行为，强制单向数据流 (Store -> Signal -> Diagram)
      // 这可以防止“脑裂”——GoJS 认为节点删了，但 Store 还没反应过来
      this.setupDeleteKeyInterception();
      
      // 委托给 FlowEventService 设置事件监听
      this.eventService.setDiagram(this.diagram, this.diagramDiv);
      
      // 添加视口变化监听（用于保存视图状态）
      this.diagram.addDiagramListener('ViewportBoundsChanged', () => {
        this.saveViewState();
      });
      
      // 设置 ResizeObserver
      this.setupResizeObserver();
      
      // 恢复视图状态
      this.restoreViewState();
      
      // 将 diagram 实例传递给其他子服务
      this.layoutService.setDiagram(this.diagram);
      this.selectionService.setDiagram(this.diagram);
      this.zoomService.setDiagram(this.diagram);
      
      // 初始化时设置正确的画布背景色
      this.applyCanvasBackground();
      
      this.error.set(null);
      this.logger.info('GoJS Diagram 初始化成功');
      return true;
      
    } catch (error) {
      Sentry.captureException(error, { tags: { operation: 'initDiagram' } });
      this.handleError('流程图初始化失败', error);
      return false;
    }
  }

  /**
   * 桌面端交互：左键平移视口、右键框选
   */
  private setupDesktopPanAndSelectTools(diagram: go.Diagram): void {
    const panningTool = diagram.toolManager.panningTool;
    const dragSelectTool = diagram.toolManager.dragSelectingTool;

    // 左键在空白处拖拽视口
    panningTool.isEnabled = true;
    panningTool.canStart = function () {
      if (!this.diagram || !this.isEnabled || this.diagram.isReadOnly) return false;

      const e = this.diagram.lastInput;
      if (!e || !e.left) return false;
      // 允许 Ctrl/Cmd 按下时仍可拖动画布（常见“按住 Ctrl 临时平移/查看”的习惯）
      // 保留 Shift/Alt：避免与其他修饰键交互冲突
      if (e.shift || e.alt) return false;
      if (e.targetDiagram !== this.diagram) return false;

      // 避免拦截节点/连线的拖动
      const part = this.diagram.findPartAt(e.documentPoint, true);
      if (part && (part instanceof go.Node || part instanceof go.Link)) {
        return false;
      }

      return this.diagram.allowHorizontalScroll || this.diagram.allowVerticalScroll;
    };

    // 右键拖拽框选
    dragSelectTool.isEnabled = true;
    dragSelectTool.isPartialInclusion = true;
    dragSelectTool.canStart = function () {
      if (!this.diagram || !this.isEnabled || this.diagram.isReadOnly) return false;

      const e = this.diagram.lastInput;
      if (!e || !e.right) return false;
      if (e.targetDiagram !== this.diagram) return false;

      const part = this.diagram.findPartAt(e.documentPoint, true);
      if (part && (part instanceof go.Node || part instanceof go.Link)) {
        return false;
      }

      return true;
    };
  }

  /**
   * 自定义点击选择行为
   * - 在 GoJS 默认选择逻辑之前处理多选（Shift/Ctrl/Cmd 或移动端框选模式）
   * - 解决默认 ClickSelectingTool 先清空选择、再触发节点 click 导致无法多选的问题
   */
  private setupMultiSelectClickTool(diagram: go.Diagram): void {
    const clickTool = diagram.toolManager.clickSelectingTool;
    const isMobileMode = this.uiState.isMobile();
    // GoJS 类型声明将 standardMouseSelect 定义为无参方法，但实际会以 (e, obj) 调用
    const originalStandardMouseSelect = (clickTool.standardMouseSelect as (e?: go.InputEvent, obj?: go.GraphObject | null) => void).bind(clickTool);
    const originalStandardTouchSelect = ((clickTool as unknown as { standardTouchSelect?: (e?: go.InputEvent, obj?: go.GraphObject | null) => void }).standardTouchSelect)?.bind(clickTool);

    (clickTool as unknown as { standardMouseSelect: (e?: go.InputEvent, obj?: go.GraphObject | null) => void }).standardMouseSelect = (e?: go.InputEvent, obj?: go.GraphObject | null) => {
      // 如果事件已经被模板 click（或其他工具）处理过，避免重复切换导致“选中闪烁/失效”
      if (e?.handled) return;

      const dragSelectTool = diagram.toolManager.dragSelectingTool;
      const lastInput = diagram.lastInput as go.InputEvent | null;
      const domEvent = (e as go.InputEvent & { event?: MouseEvent | PointerEvent | KeyboardEvent })?.event;

      // 移动端框选模式：点击节点时禁用默认单选，交给节点模板或下方逻辑处理
      const isSelectModeActive = isMobileMode && Boolean(dragSelectTool && dragSelectTool.isEnabled);
      if (isSelectModeActive && obj?.part instanceof go.Node) {
        this.logger.debug('[standardMouseSelect] 框选模式激活', { nodeKey: obj.part.key, isSelected: obj.part.isSelected });
        if (e) {
          e.handled = true;
        } else {
          this.logger.warn('[FlowDiagram] 事件对象为 undefined，无法标记为已处理');
        }
        // 在事务中切换选中状态
        diagram.startTransaction('toggle-selection');
        obj.part.isSelected = !obj.part.isSelected;
        diagram.commitTransaction('toggle-selection');
        // 手动触发 ChangedSelection 事件
        diagram.raiseDiagramEvent('ChangedSelection');
        this.logger.debug('[toggle-selection] 切换选中状态完成', { 
          nodeKey: obj.part.key, 
          newState: obj.part.isSelected,
          totalSelected: diagram.selection.count
        });
        return;
      }

      const shift = Boolean(e?.shift || lastInput?.shift || domEvent?.shiftKey);
      const ctrl = Boolean(e?.control || lastInput?.control || (domEvent as MouseEvent | undefined)?.ctrlKey);
      const meta = Boolean(e?.meta || lastInput?.meta || (domEvent as MouseEvent | undefined)?.metaKey);
      // 桌面端：仅修饰键触发多选；移动端框选模式的点选在模板事件中处理
      const wantsMultiSelect = shift || ctrl || meta;

      if (wantsMultiSelect && obj?.part instanceof go.Node) {
        if (e) {
          e.handled = true;
        } else {
          this.logger.warn('[FlowDiagram] 多选模式下事件对象为 undefined');
        }
        diagram.startTransaction('multi-select');
        obj.part.isSelected = !obj.part.isSelected;
        diagram.commitTransaction('multi-select');
        // 显式触发 ChangedSelection，确保 FlowSelectionService 同步（避免某些路径下事件不触发）
        diagram.raiseDiagramEvent('ChangedSelection');
        return;
      }

      // 防御性检查：避免将 undefined 传递给 GoJS 原始方法
      if (e) {
        originalStandardMouseSelect(e, obj);
      } else {
        this.logger.warn('[FlowDiagram] 跳过 originalStandardMouseSelect 调用（事件为 undefined）');
      }
    };

    // 移动端：触摸点击也会走 standardTouchSelect（不重写会导致先清空 selection，从而无法“点击追加多选”）
    if (typeof originalStandardTouchSelect === 'function') {
      (clickTool as unknown as { standardTouchSelect: (e?: go.InputEvent, obj?: go.GraphObject | null) => void }).standardTouchSelect = (e?: go.InputEvent, obj?: go.GraphObject | null) => {
        const dragSelectTool = diagram.toolManager.dragSelectingTool;
        const isSelectModeActive = isMobileMode && Boolean(dragSelectTool && dragSelectTool.isEnabled);

        // 仅在移动端框选模式下启用"点选多选"
        if (isSelectModeActive && obj?.part instanceof go.Node) {
          if (e) {
            e.handled = true;
          } else {
            this.logger.warn('[FlowDiagram] Touch 事件对象为 undefined');
          }
          // 在事务中切换选中状态
          diagram.startTransaction('toggle-selection');
          obj.part.isSelected = !obj.part.isSelected;
          diagram.commitTransaction('toggle-selection');
          // 手动触发 ChangedSelection 事件
          diagram.raiseDiagramEvent('ChangedSelection');
          this.logger.debug('[Touch toggle] 切换完成', { 
            nodeKey: obj.part.key, 
            newState: obj.part.isSelected,
            totalSelected: diagram.selection.count
          });
          return;
        }
        // 防御性检查：避免将 undefined 传递给 GoJS 原始方法
        if (e) {
          originalStandardTouchSelect(e, obj);
        } else {
          this.logger.warn('[FlowDiagram] 跳过 originalStandardTouchSelect 调用（事件为 undefined）');
        }
      };
    }
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
      
      if (this.overview) {
        this.overview.animationManager.isEnabled = false;
      }
      
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
      
      if (this.overview) {
        this.overview.animationManager.isEnabled = false;
        this.overview.requestUpdate();
      }
      
      this.diagram.requestUpdate();
      
      requestAnimationFrame(() => {
        if (!this.diagram || this.isDestroyed) return;
        
        this.diagram.nodes.each((node: go.Node) => {
          node.invalidateLayout();
        });
        this.diagram.links.each((link: go.Link) => {
          link.invalidateRoute();
        });
        
        this.diagram.requestUpdate();
        
        if (this.overview) {
          this.overview.requestUpdate();
        }
      });
    } catch (error) {
      this.logger.error('恢复图表失败:', error);
    }
  }
  
  // ========== 小地图 ==========
  
  /**
   * 初始化小地图
   * 
   * 【重构完成】完全委托给 FlowOverviewService
   * 内部保留的重复代码将在下一个 Sprint 中删除
   */
  initializeOverview(container: HTMLDivElement): void {
    if (!this.diagram || this.isDestroyed) return;
    
    // 设置 OverviewService 的主图引用
    this.overviewService.setDiagram(this.diagram);
    
    // 完全委托给 FlowOverviewService
    const isMobile = this.uiState.isMobile();
    this.overviewService.initializeOverview(container, isMobile);
  }
  
  /**
   * 应用画布背景色（根据当前主题）
   */
  private applyCanvasBackground(): void {
    if (!this.diagram || !this.diagram.div) return;
    
    const theme = this.themeService.theme() as FlowTheme;
    const isDark = this.themeService.isDark();
    const flowStyles = getFlowStyles(theme, isDark ? 'dark' : 'light');
    this.diagram.div.style.backgroundColor = flowStyles.canvas.background;
  }
  
  /**
   * 销毁小地图
   * 
   * 【重构完成】完全委托给 FlowOverviewService
   */
  disposeOverview(): void {
    // 完全委托给 FlowOverviewService
    this.overviewService.destroyOverview();
  }
  
  /**
   * 刷新 Overview 渲染
   * 
   * 【重构完成】完全委托给 FlowOverviewService
   */
  refreshOverview(): void {
    // 完全委托给 FlowOverviewService
    this.overviewService.refreshOverview();
  }

  dispose(): void {
    this.isDestroyed = true;
    this.isFirstLoad = true;
    
    this.disposeOverview();
    this.clearAllTimers();
    
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    
    // 清理事件服务
    this.eventService.dispose();
    
    if (this.diagram) {
      this.diagram.div = null;
      this.diagram.clear();
      this.diagram = null;
    }
    
    this.diagramDiv = null;
    
    // 清理子服务
    this.layoutService.dispose();
    this.selectionService.setDiagram(null);
    this.zoomService.dispose();
    
    this.logger.info('GoJS Diagram 已销毁');
  }
  
  // ========== 导出功能 ==========
  
  async exportToPng(): Promise<Blob | null> {
    if (!this.diagram) {
      this.toast.error('导出失败', '流程图未加载');
      return null;
    }
    
    try {
      const imgData = this.diagram.makeImageData({
        scale: 2,
        background: '#F5F2E9',
        type: 'image/png',
        maxSize: new go.Size(4096, 4096)
      }) as string;
      
      if (!imgData) {
        this.toast.error('导出失败', '无法生成图片');
        return null;
      }
      
      const response = await fetch(imgData);
      const blob = await response.blob();
      
      this.downloadBlob(blob, `流程图_${this.getExportFileName()}.png`);
      this.toast.success('导出成功', 'PNG 图片已下载');
      
      return blob;
    } catch (error) {
      this.logger.error('导出 PNG 失败', error);
      Sentry.captureException(error, { tags: { operation: 'exportToPng' } });
      this.toast.error('导出失败', '生成图片时发生错误');
      return null;
    }
  }
  
  async exportToSvg(): Promise<Blob | null> {
    if (!this.diagram) {
      this.toast.error('导出失败', '流程图未加载');
      return null;
    }
    
    try {
      const svg = this.diagram.makeSvg({
        scale: 1,
        background: '#F5F2E9',
        maxSize: new go.Size(4096, 4096)
      });
      
      if (!svg) {
        this.toast.error('导出失败', '无法生成 SVG');
        return null;
      }
      
      const serializer = new XMLSerializer();
      const svgString = serializer.serializeToString(svg);
      const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
      
      this.downloadBlob(blob, `流程图_${this.getExportFileName()}.svg`);
      this.toast.success('导出成功', 'SVG 图片已下载');
      
      return blob;
    } catch (error) {
      this.logger.error('导出 SVG 失败', error);
      Sentry.captureException(error, { tags: { operation: 'exportToSvg' } });
      this.toast.error('导出失败', '生成 SVG 时发生错误');
      return null;
    }
  }
  
  private getExportFileName(): string {
    const project = this.projectState.activeProject();
    const projectName = project?.name || '未命名项目';
    const date = new Date().toISOString().slice(0, 10);
    return `${projectName}_${date}`;
  }
  
  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
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
   * 由外部在 Flow 视图激活时调用
   */
  onFlowActivated(): void {
    if (this.isDestroyed || !this.diagram) return;
    if (this.uiState.activeView() !== 'flow') return;
    if (!this.pendingAutoFitToContents) return;

    const viewState = this.projectState.getViewState();
    if (viewState) {
      this.pendingAutoFitToContents = false;
      this.diagram.scale = viewState.scale;
      this.diagram.position = new go.Point(viewState.positionX, viewState.positionY);
      return;
    }

    this.pendingAutoFitToContents = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (this.isDestroyed || !this.diagram) return;
        this.zoomService.fitToContents();
      });
    });
  }
  
  // ========== 图表数据更新 ==========
  
  private detectStructuralChange(currentNodeMap: Map<string, go.ObjectData>, newTasks: Task[]): boolean {
    if (currentNodeMap.size !== newTasks.length) {
      return true;
    }
    
    for (const task of newTasks) {
      const existing = currentNodeMap.get(task.id);
      if (!existing) {
        return true;
      }
      
      if (existing.stage !== task.stage ||
          existing.status !== task.status ||
          existing.parentId !== task.parentId) {
        return true;
      }
    }
    
    const newTaskIds = new Set(newTasks.map(t => t.id));
    for (const key of currentNodeMap.keys()) {
      if (!newTaskIds.has(key)) {
        return true;
      }
    }
    
    const project = this.projectState.activeProject();
    if (project) {
      const model = this.diagram?.model as go.GraphLinksModel;
      if (model) {
        const currentLinkCount = (model.linkDataArray || []).length;
        const parentChildCount = newTasks.filter(t => t.parentId).length;
        const crossTreeCount = project.connections?.length || 0;
        const expectedLinkCount = parentChildCount + crossTreeCount;
        if (currentLinkCount !== expectedLinkCount) {
          return true;
        }
      }
    }
    
    return false;
  }

  /**
   * 更新图表数据
   */
  updateDiagram(tasks: Task[], forceRefresh: boolean = false): void {
    if (this.error() || !this.diagram) {
      return;
    }
    
    const project = this.projectState.activeProject();
    if (!project) {
      return;
    }
    
    try {
      const lastUpdateType = this.taskOps.getLastUpdateType();
      
      const model = this.diagram.model as go.GraphLinksModel;
      const currentNodeMap = new Map<string, go.ObjectData>();
      (model.nodeDataArray || []).forEach((n: go.ObjectData) => {
        if (n.key) currentNodeMap.set(n.key as string, n);
      });
      
      const activeTasks = tasks.filter(t => !t.deletedAt);
      const hasStructuralChange = this.detectStructuralChange(currentNodeMap, activeTasks);
      
      if (lastUpdateType === 'position' && !forceRefresh && !hasStructuralChange) {
        return;
      }
      
      const existingNodeMap = new Map<string, go.ObjectData>();
      (this.diagram.model as go.GraphLinksModel).nodeDataArray.forEach((n: go.ObjectData) => {
        if (n.key) {
          existingNodeMap.set(n.key as string, n);
        }
      });
      
      const searchQuery = this.uiState.searchQuery();
      const diagramData = this.configService.buildDiagramData(
        tasks.filter(t => !t.deletedAt),
        project,
        searchQuery,
        existingNodeMap
      );
      
      const selectedKeys = new Set<string>();
      this.diagram.selection.each((part: go.Part) => {
        if (part.data?.key) {
          selectedKeys.add(part.data.key);
        }
      });
      
      this.diagram.startTransaction('update');
      this.diagram.skipsUndoManager = true;
      
      model.mergeNodeDataArray(diagramData.nodeDataArray);
      
      const linkDataWithPorts = diagramData.linkDataArray.map(link => ({
        ...link,
        fromPortId: "",
        toPortId: ""
      }));
      
      model.mergeLinkDataArray(linkDataWithPorts);
      
      const nodeKeys = new Set(diagramData.nodeDataArray.map(n => n.key));
      const linkKeys = new Set(diagramData.linkDataArray.map(l => l.key));
      
      const nodesToRemove = model.nodeDataArray.filter((n: go.ObjectData) => !nodeKeys.has(n.key as string));
      nodesToRemove.forEach((n: go.ObjectData) => model.removeNodeData(n));
      
      const linksToRemove = model.linkDataArray.filter((l: go.ObjectData) => !linkKeys.has(l.key as string));
      linksToRemove.forEach((l: go.ObjectData) => model.removeLinkData(l));
      
      this.diagram.skipsUndoManager = false;
      this.diagram.commitTransaction('update');
      
      if (selectedKeys.size > 0) {
        this.diagram.nodes.each((node: go.Node) => {
          if (selectedKeys.has(node.data?.key)) {
            node.isSelected = true;
          }
        });
      }
      
      this.diagram.links.each((link: go.Link) => {
        link.invalidateRoute();
      });
      
      // Debug 日志
      const linkData = model.linkDataArray;
      if (linkData?.length > 0 && !this._familyColorLogged) {
        this._familyColorLogged = true;
        this.logger.info(`[LineageColor] 首条连线数据: ${JSON.stringify(linkData[0])}`);
      }
      
      if (this.overview?.observed) {
        this.overview.updateAllTargetBindings();
      }
      
      if (this.isFirstLoad && diagramData.nodeDataArray.length > 0) {
        this.isFirstLoad = false;
        setTimeout(() => {
          if (this.isDestroyed || !this.diagram) return;
          const viewState = this.projectState.getViewState();
          if (!viewState) {
            if (this.uiState.activeView() !== 'flow') {
              this.pendingAutoFitToContents = true;
              return;
            }
            this.zoomService.fitToContents();
          }
        }, 100);
      }
      
    } catch (error) {
      Sentry.captureException(error, { tags: { operation: 'updateDiagram' } });
      this.handleError('更新流程图失败', error);
    }
  }
  
  // ========== 拖放支持 ==========
  
  setupDropHandler(onDrop: (taskData: Task, docPoint: go.Point) => void): void {
    if (!this.diagramDiv) return;
    
    this.diagramDiv.addEventListener('dragover', (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'move';
      }
    });
    
    this.diagramDiv.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      const jsonData = e.dataTransfer?.getData("application/json");
      const textData = e.dataTransfer?.getData("text");
      const data = jsonData || textData;
      if (!data || !this.diagram || !this.diagramDiv) return;
      
      const trimmed = data.trim();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return;
      }
      
      try {
        const task = JSON.parse(data);
        // 使用 DragEvent 的坐标计算准确的拖放位置
        // diagram.lastInput.viewPoint 在拖放场景下可能不准确
        const rect = this.diagramDiv.getBoundingClientRect();
        const viewX = e.clientX - rect.left;
        const viewY = e.clientY - rect.top;
        const pt = new go.Point(viewX, viewY);
        const loc = this.diagram.transformViewToDoc(pt);
        onDrop(task, loc);
      } catch (err) {
        this.logger.error('Drop error:', err);
        Sentry.captureException(err, { tags: { operation: 'drop' } });
      }
    });
  }
  
  // ========== 私有方法 ==========
  
  /**
   * 【关键】拦截 GoJS 默认删除行为
   * 
   * 设计原则：强制单向数据流 (Store -> Signal -> Diagram)
   * - 禁止 GoJS 直接删除节点，避免"脑裂"问题
   * - Delete/Backspace 键触发自定义事件，由 Angular Service 处理
   * - 所有删除操作必须先更新 Store，再由 Store 变化驱动 GoJS 刷新
   */
  private setupDeleteKeyInterception(): void {
    if (!this.diagram) return;
    
    const diagram = this.diagram;
    const originalDoKeyDown = diagram.commandHandler.doKeyDown.bind(diagram.commandHandler);
    
    // 禁止 GoJS 默认的删除选中项行为
    diagram.commandHandler.canDeleteSelection = () => false;
    
    // 拦截 Delete/Backspace 键
    diagram.commandHandler.doKeyDown = () => {
      const e = diagram.lastInput;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // 触发自定义删除事件，由 FlowEventService 处理
        // 通过事件总线解耦，避免循环依赖
        this.logger.debug('拦截 Delete 键，触发自定义删除事件');
        flowTemplateEventHandlers.onDeleteKeyPressed?.();
        return; // 阻止 GoJS 默认删除
      }
      // 其他按键走默认逻辑
      originalDoKeyDown();
    };
    
    this.logger.info('Delete 键拦截已配置，GoJS 默认删除行为已禁用');
  }
  
  private setupResizeObserver(): void {
    if (!this.diagramDiv) return;
    
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeDebounceTimer) {
        clearTimeout(this.resizeDebounceTimer);
      }
      
      this.resizeDebounceTimer = setTimeout(() => {
        if (this.isDestroyed || !this.diagram || !this.diagramDiv) return;
        
        const width = this.diagramDiv.clientWidth;
        const height = this.diagramDiv.clientHeight;
        
        if (width > 0 && height > 0) {
          this.diagram.requestUpdate();
        }
      }, UI_CONFIG.RESIZE_DEBOUNCE_DELAY);
    });
    
    this.resizeObserver.observe(this.diagramDiv);
  }
  
  private saveViewState(): void {
    if (!this.diagram) return;
    
    if (this.viewStateSaveTimer) {
      clearTimeout(this.viewStateSaveTimer);
    }
    
    this.viewStateSaveTimer = setTimeout(() => {
      if (this.isDestroyed || !this.diagram) return;
      
      const projectId = this.projectState.activeProjectId();
      if (!projectId) return;
      
      const scale = this.diagram.scale;
      const pos = this.diagram.position;
      
      this.projectState.updateViewState(projectId, {
        scale,
        positionX: pos.x,
        positionY: pos.y
      });
      this.syncCoordinator.schedulePersist();
      
      this.viewStateSaveTimer = null;
    }, 1000);
  }
  
  private restoreViewState(): void {
    if (!this.diagram) return;

    const immediateViewState = this.projectState.getViewState();
    if (immediateViewState) {
      this.pendingAutoFitToContents = false;
      this.diagram.scale = immediateViewState.scale;
      this.diagram.position = new go.Point(immediateViewState.positionX, immediateViewState.positionY);
      return;
    }
    
    if (this.restoreViewStateTimer) {
      clearTimeout(this.restoreViewStateTimer);
      this.restoreViewStateTimer = null;
    }

    this.restoreViewStateTimer = setTimeout(() => {
      if (this.isDestroyed || !this.diagram) return;

      const viewState = this.projectState.getViewState();
      
      if (viewState) {
        this.pendingAutoFitToContents = false;
        this.diagram.scale = viewState.scale;
        this.diagram.position = new go.Point(viewState.positionX, viewState.positionY);
      } else {
        if (this.uiState.activeView() !== 'flow') {
          this.pendingAutoFitToContents = true;
          return;
        }

        if (this.autoFitTimer) {
          clearTimeout(this.autoFitTimer);
          this.autoFitTimer = null;
        }

        this.autoFitTimer = setTimeout(() => {
          if (this.isDestroyed || !this.diagram) return;
          this.zoomService.fitToContents();
          this.autoFitTimer = null;
        }, 300);
      }
      this.restoreViewStateTimer = null;
    }, 200);
  }
  
  private clearAllTimers(): void {
    if (this.resizeDebounceTimer) {
      clearTimeout(this.resizeDebounceTimer);
      this.resizeDebounceTimer = null;
    }
    if (this.viewStateSaveTimer) {
      clearTimeout(this.viewStateSaveTimer);
      this.viewStateSaveTimer = null;
    }
    if (this.restoreViewStateTimer) {
      clearTimeout(this.restoreViewStateTimer);
      this.restoreViewStateTimer = null;
    }
    if (this.autoFitTimer) {
      clearTimeout(this.autoFitTimer);
      this.autoFitTimer = null;
    }
  }
  
  private handleError(userMessage: string, error: unknown): void {
    const _errorStr = error instanceof Error ? error.message : String(error);
    this.logger.error(`❌ Flow diagram error: ${userMessage}`, error);
    this.error.set(userMessage);
    this.toast.error('流程图错误', `${userMessage}。请刷新页面重试。`);
  }

  // TS 类型定义不允许 null，这里集中处理为 any 写入
  private setOverviewFixedBounds(bounds: go.Rect | null): void {
    if (!this.overview) return;
    // GoJS 要求 fixedBounds 必须是 Rect 实例或 undefined，不能是 null
    // 使用类型断言绕过严格类型检查
    (this.overview as unknown as { fixedBounds: go.Rect | undefined }).fixedBounds = bounds ?? undefined;
  }
}
