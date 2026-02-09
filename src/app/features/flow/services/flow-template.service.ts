/**
 * FlowTemplateService - GoJS 节点模板配置
 * 
 * 从 flow-diagram.service.ts (3000+ 行) 提取的模板配置逻辑
 * 
 * 核心设计：事件代理（Event Delegation via Event Bus）
 * - 模板只负责"我长什么样"和"我有点击交互"
 * - 点击时通过 flowTemplateEventHandlers 全局对象发送信号
 * - 不关心"点击后具体调用哪个 Service"
 * - FlowEventService 在初始化时注册处理器
 * 
 * 职责：
 * - 节点模板配置（颜色、大小、端口）
 * - Overview 节点模板配置
 * - 图层配置
 * 
 * 连接线模板已提取到 FlowLinkTemplateService
 */

import { Injectable, inject } from '@angular/core';
import { GOJS_CONFIG } from '../../../../config';
import { getFlowStyles, FlowTheme, FlowColorMode } from '../../../../config/flow-styles';
import { flowTemplateEventHandlers } from './flow-template-events';
import { FlowDiagramConfigService } from './flow-diagram-config.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { LoggerService } from '../../../../services/logger.service';
import { ThemeService } from '../../../../services/theme.service';
import * as go from 'gojs';
import {
  GojsClickHandler,
  PortConfig,
  NodeStyleConfig,
  GojsShapeBuilder
} from './flow-template.types';

// 重新导出类型以保持向后兼容
export type { PortConfig, NodeStyleConfig } from './flow-template.types';
export type { LinkStyleConfig } from './flow-template.types';

@Injectable({
  providedIn: 'root'
})
export class FlowTemplateService {
  private readonly uiState = inject(UiStateService);
  private readonly configService = inject(FlowDiagramConfigService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowTemplate');
  private readonly themeService = inject(ThemeService);
  
  // ========== 主题感知的样式获取 ==========
  
  /**
   * 获取当前主题的 GoJS 样式配置
   */
  private getCurrentFlowStyles() {
    const theme = this.themeService.theme() as FlowTheme;
    const colorMode: FlowColorMode = this.themeService.isDark() ? 'dark' : 'light';
    return getFlowStyles(theme, colorMode);
  }
  
  // ========== 样式配置 ==========
  
  getNodeStyleConfig(isMobile: boolean): NodeStyleConfig {
    const flowStyles = this.getCurrentFlowStyles();
    return {
      portSize: isMobile ? 24 : 10,
      assignedWidth: GOJS_CONFIG.ASSIGNED_NODE_WIDTH,
      unassignedWidth: GOJS_CONFIG.UNASSIGNED_NODE_WIDTH,
      defaultFill: flowStyles.node.background,
      defaultStroke: flowStyles.node.defaultBorder,
      selectedStroke: flowStyles.node.selectedBorder,
      cornerRadius: 10
    };
  }
  
  getPortConfigs(): PortConfig[] {
    return [
      { name: 'T', spot: go.Spot.Top, size: 10 },
      { name: 'B', spot: go.Spot.Bottom, size: 10 },
      { name: 'L', spot: go.Spot.Left, size: 10 },
      { name: 'R', spot: go.Spot.Right, size: 10 }
    ];
  }
  
  // ========== 图层配置 ==========
  
  /**
   * 确保图层顺序稳定：Links 永远在 Nodes 下方
   */
  ensureDiagramLayers(diagram: go.Diagram): void {
    const foregroundLayer = diagram.findLayer('Foreground');
    if (!foregroundLayer) return;

    let nodesLayer = diagram.findLayer('Nodes');
    if (!nodesLayer) {
      nodesLayer = new go.Layer();
      nodesLayer.name = 'Nodes';
      diagram.addLayerBefore(nodesLayer, foregroundLayer);
    }

    let linksLayer = diagram.findLayer('Links');
    if (!linksLayer) {
      linksLayer = new go.Layer();
      linksLayer.name = 'Links';
      diagram.addLayerBefore(linksLayer, nodesLayer);
    }
  }
  
  // ========== 节点模板 ==========
  
  /**
   * 设置节点模板
   * 
   * 事件代理模式：
   * - click/doubleClick 通过 flowTemplateEventHandlers 发送信号
   * - FlowEventService 统一监听和处理
   */
  setupNodeTemplate(diagram: go.Diagram): void {
    const $ = go.GraphObject.make;
    const isMobile = this.uiState.isMobile();
    const portSize = isMobile ? 24 : 10;
    
    const _allowedPortIds = ["T", "B", "L", "R"];
    
    /**
     * 创建边缘连接手柄
     * 使用 any 类型避免 GoJS 泛型类型不兼容问题
     */
    const makePort = (name: string, spot: go.Spot): GojsShapeBuilder => {
      return $(go.Shape, "Circle", {
        fill: "transparent",
        stroke: null,
        strokeWidth: isMobile ? 2 : 1,
        desiredSize: new go.Size(portSize, portSize),
        alignment: spot,
        alignmentFocus: go.Spot.Center,
        portId: name,
        fromLinkable: true,
        toLinkable: true,
        fromSpot: go.Spot.None,
        toSpot: go.Spot.None,
        isActionable: false,
        cursor: "crosshair",
        mouseEnter: (e: go.InputEvent, obj: go.GraphObject, _prev: go.GraphObject | null) => {
          if (e.diagram?.isReadOnly) return;
          (obj as go.Shape).fill = "#4A8C8C";
          (obj as go.Shape).stroke = "#44403C";
        },
        mouseLeave: (_e: go.InputEvent, obj: go.GraphObject, _next: go.GraphObject | null) => {
          (obj as go.Shape).fill = "transparent";
          (obj as go.Shape).stroke = null;
        }
      });
    };
    
    diagram.nodeTemplate = $(go.Node, "Spot",
      {
        locationSpot: go.Spot.Center,
        layerName: 'Nodes',
        selectionAdorned: true,
        movable: true,
        fromLinkable: false,
        toLinkable: true,
        fromLinkableDuplicates: false,
        toLinkableDuplicates: true,
        // 事件代理：通过全局事件总线发送信号
        click: ((e: go.InputEvent, node: go.GraphObject) => {
          // dragging 不是 go.InputEvent 的标准属性，使用 isTouchDevice + 检查 DraggingTool
          const diagram = e.diagram;
          if (diagram?.toolManager?.draggingTool?.isActive) return;
          if (e.diagram?.lastInput.clickCount >= 2) return;
          if (e.handled) return; // 已由 ClickSelectingTool 处理
          
          // 支持多选：检测 Shift/Ctrl/Cmd 键或框选模式
          const input = e;
          const lastInput = e.diagram?.lastInput as go.InputEvent;
          const domEvent = (input as go.InputEvent & { event?: MouseEvent | PointerEvent | KeyboardEvent })?.event;

          const shift = Boolean(input?.shift || lastInput?.shift || domEvent?.shiftKey);
          const ctrl = Boolean(input?.control || lastInput?.control || (domEvent as MouseEvent | undefined)?.ctrlKey);
          const meta = Boolean(input?.meta || lastInput?.meta || (domEvent as MouseEvent | undefined)?.metaKey); // Mac 的 Cmd 键
          const isSelectModifierPressed = shift || ctrl || meta;
          const isMobileMode = this.uiState.isMobile();
          
          // 框选模式（移动端切换）
          const dragSelectTool = e.diagram?.toolManager.dragSelectingTool;
          const isSelectModeActive = isMobileMode && Boolean(dragSelectTool && dragSelectTool.isEnabled);

          this.logger.debug('节点点击事件', {
            isSelectModeActive,
            isMobileMode,
            dragSelectToolEnabled: dragSelectTool?.isEnabled,
            nodeSelected: (node as go.Node).isSelected,
            nodeKey: (node as go.Node).key
          });

          // 移动端框选模式：点击节点立即切换选中状态
          if (isSelectModeActive) {
            this.logger.debug('框选模式激活 - 切换节点选中状态', { from: (node as go.Node).isSelected, to: !(node as go.Node).isSelected });
            e.handled = true;
            // 在事务中切换选中状态
            e.diagram?.startTransaction('toggle-selection');
            (node as go.Node).isSelected = !(node as go.Node).isSelected;
            e.diagram?.commitTransaction('toggle-selection');
            // 手动触发 ChangedSelection 事件
            e.diagram?.raiseDiagramEvent('ChangedSelection');
            this.logger.debug('选中状态已更新', { 
              nodeKey: (node as go.Node).key, 
              isSelected: (node as go.Node).isSelected,
              totalSelected: e.diagram?.selection.count
            });
            return;
          }

          // 桌面端修饰键多选：阻止详情面板，具体切换由 ClickSelectingTool 处理
          if (isSelectModifierPressed) {
            // 兼容：不同 GoJS 版本/工具链下，ClickSelectingTool 与 node.click 的执行顺序可能变化。
            // 若仅设置 e.handled=true 可能导致多选完全不生效；这里直接切换选中状态，保证 Shift/Ctrl/Cmd 点选稳定。
            e.handled = true;
            e.diagram?.startTransaction('toggle-selection');
            (node as go.Node).isSelected = !(node as go.Node).isSelected;
            e.diagram?.commitTransaction('toggle-selection');
            e.diagram?.raiseDiagramEvent('ChangedSelection');
            return;
          }

          // 普通点击：调用事件处理器（单选逻辑由事件服务处理）
          flowTemplateEventHandlers.onNodeClick?.(node as go.Node);
        }) as GojsClickHandler,
        doubleClick: ((e: go.InputEvent, node: go.GraphObject) => {
          e.handled = true;
          flowTemplateEventHandlers.onNodeDoubleClick?.(node as go.Node);
        }) as GojsClickHandler
      },
      new go.Binding("location", "loc", go.Point.parse).makeTwoWay(go.Point.stringify),
      
      // 主面板
      $(go.Panel, "Auto",
        {
          name: "BODY",
          portId: "",
          fromLinkable: false,
          toLinkable: true,
          fromSpot: go.Spot.AllSides,
          toSpot: go.Spot.AllSides,
          cursor: "move"
        },
        new go.Binding("width", "isUnassigned", (isUnassigned: boolean) => 
          isUnassigned ? GOJS_CONFIG.UNASSIGNED_NODE_WIDTH : GOJS_CONFIG.ASSIGNED_NODE_WIDTH),
        $(go.Shape, "RoundedRectangle", {
          name: "SHAPE",
          fill: "white",
          stroke: "#78716C",
          strokeWidth: 1,
          parameter1: 10,
          isPanelMain: true
        },
        new go.Binding("fill", "color"),
        new go.Binding("stroke", "", (data: go.ObjectData, obj: go.GraphObject) => {
          if ((obj.part as go.Node)?.isSelected) return (data as { selectedBorderColor?: string }).selectedBorderColor || "#4A8C8C";
          return (data as { borderColor?: string }).borderColor || "#78716C";
        }).ofObject(),
        new go.Binding("strokeWidth", "borderWidth")),
        
        $(go.Panel, "Vertical",
          new go.Binding("margin", "isUnassigned", (isUnassigned: boolean) => isUnassigned ? 10 : 16),
          $(go.TextBlock, { font: "bold 9px \"LXGW WenKai Screen\", sans-serif", stroke: "#78716C", alignment: go.Spot.Left },
            new go.Binding("text", "displayId"),
            new go.Binding("stroke", "displayIdColor"),
            new go.Binding("visible", "isUnassigned", (isUnassigned: boolean) => !isUnassigned)),
          $(go.TextBlock, { margin: new go.Margin(4, 0, 0, 0), font: "400 12px \"LXGW WenKai Screen\", sans-serif", stroke: "#44403C" },
            new go.Binding("text", "title"),
            new go.Binding("font", "isUnassigned", (isUnassigned: boolean) => 
              isUnassigned ? "500 11px \"LXGW WenKai Screen\", sans-serif" : "400 12px \"LXGW WenKai Screen\", sans-serif"),
            new go.Binding("stroke", "titleColor"),
            new go.Binding("maxSize", "isUnassigned", (isUnassigned: boolean) => 
              isUnassigned ? new go.Size(120, NaN) : new go.Size(160, NaN)))
        )
      ),
      
      // 边缘连接手柄
      makePort("T", go.Spot.Top),
      makePort("B", go.Spot.Bottom),
      makePort("L", go.Spot.Left),
      makePort("R", go.Spot.Right)
    );
    
    this.logger.debug('节点模板已设置');
  }
  
  // ========== Overview 模板 ==========
  
  /**
   * 设置 Overview 节点模板（简化版 - 性能优化）
   * 
   * 关键优化：
   * 1. 去掉文字渲染：Overview 只需显示节点位置和颜色
   * 2. 去掉阴影和复杂效果：减少渲染开销
   * 3. 使用固定尺寸：避免每帧计算
   */
  setupOverviewNodeTemplate(overview: go.Overview): void {
    const $ = go.GraphObject.make;
    const styles = this.configService.currentStyles();
    
    // 简化的节点模板 - 只有一个矩形
    overview.nodeTemplate = $(go.Node, "Auto",
      {
        locationSpot: go.Spot.Center,
        minSize: new go.Size(4, 4)
      },
      new go.Binding("location", "loc", go.Point.parse),
      $(go.Shape, "Rectangle",
        {
          name: "SHAPE",
          height: 80,
          // 增加边框以在小地图中更清晰，即使在极小比例下也能保持轮廓
          strokeWidth: 4,
          stroke: "rgba(255, 255, 255, 0.5)" // 增加不透明度从 0.2 到 0.5，边缘更锋利
        },
        new go.Binding("width", "isUnassigned", (isUnassigned: boolean) =>
          isUnassigned ? GOJS_CONFIG.UNASSIGNED_NODE_WIDTH : GOJS_CONFIG.ASSIGNED_NODE_WIDTH
        ),
        new go.Binding("fill", "color", (color: string) => color || styles.node.background)
      )
    );
    
    // Overview 更新延迟
    // 设置为 0 表示每帧都更新，确保小地图与主视图同步
    // GoJS 内部会自动进行合理的批处理
    overview.updateDelay = 0;
    
    this.logger.debug('Overview 节点模板已设置（简化版）');
  }
  
  /**
   * 设置 Overview 视口框样式
   * @param overview Overview 实例
   * @param _isMobile 是否为移动端（保留参数以保持接口兼容性）
   */
  setupOverviewBoxStyle(overview: go.Overview, _isMobile: boolean = false): void {
    const box = overview.box;
    if (box && box.elt(0)) {
      const shape = box.elt(0) as go.Shape;
      
      // 统一使用 2px 边框宽度
      // 由于现在所有设备都使用实际的 devicePixelRatio，边框会自动清晰
      shape.strokeWidth = 2;
      
      // 使用更明显的白色边框
      shape.stroke = "#ffffff";
      
      // 半透明白色填充
      shape.fill = "rgba(255, 255, 255, 0.15)";
    }
  }
  
}
