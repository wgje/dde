/**
 * FlowEventService - GoJS 事件处理服务（事件代理模式）
 * 
 * 从 flow-diagram.service.ts (3000+ 行) 提取的事件处理逻辑
 * 
 * 核心设计：事件代理（Event Delegation via Event Bus）
 * - 模板通过 flowTemplateEventHandlers 全局对象发信号
 * - EventService 在 setDiagram 时注册处理器，收信号
 * - 完全解耦：模板不知道回调是谁，EventService 不知道模板长什么样
 * 
 * 职责：
 * - 事件回调注册和分发
 * - Diagram 级别事件监听
 * - 模板事件处理器注册
 * - 事件监听器生命周期管理
 * - 防止内存泄漏
 */

import { Injectable, inject, NgZone } from '@angular/core';
import { LoggerService } from '../../../../services/logger.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { flowTemplateEventHandlers } from './flow-template-events';
import {
  convertFlowViewPointToWindowCoords,
  getFlowClickPositionFromEvent,
  getFlowLinkClickPosition,
} from './flow-event-geometry.helpers';
import { GOJS_CONFIG } from '../../../../config';
import type { GoJSLinkData } from '../../../../types/gojs-extended';
import * as go from 'gojs';

/**
 * 节点点击回调
 */
export type NodeClickCallback = (taskId: string, isDoubleClick: boolean) => void;

export type SidecarToggleCallback = (taskId: string) => void;

/**
 * 连接线点击回调
 */
export type LinkClickCallback = (linkData: GoJSLinkData, x: number, y: number, isDoubleClick?: boolean) => void;

/**
 * 连接线删除回调
 */
export type LinkDeleteCallback = (linkData: GoJSLinkData) => void;

/**
 * 连接手势回调
 */
export type LinkGestureCallback = (sourceId: string, targetId: string, x: number, y: number, link: go.Link) => void;

/**
 * 选择移动完成回调
 */
export type SelectionMovedCallback = (movedNodes: Array<{ key: string; x: number; y: number; isUnassigned: boolean }>) => void;

/**
 * 背景点击回调
 */
export type BackgroundClickCallback = () => void;

/**
 * 连接线重连信息
 */
export interface LinkRelinkInfo {
  changedEnd: 'from' | 'to';
  oldFromId: string;
  oldToId: string;
  newFromId: string;
  newToId: string;
}

interface LinkRelinkContext {
  link: go.Link;
  disconnectedNodeId: string;
  newFromId: string;
  newToId: string;
  isCrossTree: boolean;
}

interface LinkGestureContext {
  link: go.Link;
  sourceId: string;
  targetId: string;
}

/**
 * 连接线重连回调
 */
export type LinkRelinkCallback = (
  linkType: 'parent-child' | 'cross-tree',
  relinkInfo: LinkRelinkInfo,
  x: number,
  y: number,
  gojsLink: go.Link
) => void;

/**
 * 已注册的监听器信息
 */
interface RegisteredListener {
  name: go.DiagramEventName | string;
  handler: (e: go.DiagramEvent) => void;
}

@Injectable({
  providedIn: 'root'
})
export class FlowEventService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowEvent');
  private readonly zone = inject(NgZone);
  private readonly projectState = inject(ProjectStateService);
  private readonly uiState = inject(UiStateService);
  
  // ========== Diagram 引用 ==========
  private diagram: go.Diagram | null = null;
  private diagramDiv: HTMLDivElement | null = null;
  
  // ========== 回调存储 ==========
  private nodeClickCallback: NodeClickCallback | null = null;
  private sidecarToggleCallback: SidecarToggleCallback | null = null;
  private linkClickCallback: LinkClickCallback | null = null;
  private linkDeleteCallback: LinkDeleteCallback | null = null;
  private linkRelinkCallback: LinkRelinkCallback | null = null;
  private linkGestureCallback: LinkGestureCallback | null = null;
  private selectionMovedCallback: SelectionMovedCallback | null = null;
  private backgroundClickCallback: BackgroundClickCallback | null = null;
  /** 拖拽节点出画布边界的回调（支持多选拖入停泊坞；单任务拖入停泊坞也走此路径） */
  private dragOutOfBoundsCallback: ((taskIds: string[], clientX: number, clientY: number) => void) | null = null;
  /**
   * Delete/Backspace 键回调。
   * 必须走本服务的回调注册表而不是让注册方直接写 flowTemplateEventHandlers：
   * 硬恢复（teardownDiagramForRecovery → 原地重建）会经 setDiagram(null) 清空全局模板处理器，
   * 只有 setupTemplateEventHandlers 在新 diagram 接入时重接的处理器才能在恢复后存活
   */
  private deleteKeyCallback: (() => void) | null = null;
  
  // ========== 监听器追踪 ==========
  private registeredListeners: RegisteredListener[] = [];
  
  // ========== 定时器 ==========
  private positionSaveTimer: ReturnType<typeof setTimeout> | null = null;
  
  // ========== 初始化 ==========
  
  /**
   * 设置 Diagram 引用并初始化事件监听
   */
  setDiagram(diagram: go.Diagram | null, diagramDiv?: HTMLDivElement | null): void {
    if (this.diagram !== diagram && this.positionSaveTimer !== null) {
      clearTimeout(this.positionSaveTimer);
      this.positionSaveTimer = null;
    }

    // 清理旧的监听器和事件处理器
    if (this.diagram) {
      this.removeAllListeners(this.diagram);
      this.clearTemplateEventHandlers();
    }
    
    this.diagram = diagram;
    this.diagramDiv = diagramDiv ?? null;
    
    if (diagram) {
      this.setupEventListeners();
      this.setupTemplateEventHandlers();
    }
  }
  
  /**
   * 注册模板事件处理器
   * 模板通过 flowTemplateEventHandlers 调用这些处理器
   * 【P2-29 修复】移除 zone.run 避免与 emit 方法中的 zone.run 双重嵌套
   */
  private setupTemplateEventHandlers(): void {
    // 节点点击
    flowTemplateEventHandlers.onNodeClick = (node: go.Node) => {
      if (!this.isCurrentTemplatePart(node)) return;
      this.emitNodeClick(node.data?.key, false);
    };
    
    // 节点双击
    flowTemplateEventHandlers.onNodeDoubleClick = (node: go.Node) => {
      if (!this.isCurrentTemplatePart(node)) return;
      this.emitNodeClick(node.data?.key, true);
    };

    flowTemplateEventHandlers.onSidecarToggle = (taskId: string, part?: go.Part) => {
      if (part && !this.isCurrentTemplatePart(part)) return;
      this.emitSidecarToggle(taskId);
    };
    
    // 连接线点击
    flowTemplateEventHandlers.onLinkClick = (link: go.Link) => {
      if (!this.isCurrentTemplatePart(link)) return;
      const viewPoint = this.diagram?.lastInput?.viewPoint;
      const x = viewPoint?.x ?? 0;
      const y = viewPoint?.y ?? 0;
      this.emitLinkClick(link.data, x, y, false);
    };
    
    // 连接线删除请求
    flowTemplateEventHandlers.onLinkDeleteRequest = (link: go.Link) => {
      if (!this.isCurrentTemplatePart(link)) return;
      this.emitLinkDelete(link.data);
    };
    
    // 跨树连接标签点击
    flowTemplateEventHandlers.onCrossTreeLabelClick = (link: go.Link, viewX: number, viewY: number) => {
      if (!this.isCurrentTemplatePart(link)) return;
      // 将 GoJS 视图坐标转换为浏览器窗口坐标
      const { windowX, windowY } = this.convertViewToWindowCoords(viewX, viewY);
      this.emitLinkClick(link.data, windowX, windowY, false);
    };

    // 拖拽节点出画布边界 — 多选拖入停泊坞
    flowTemplateEventHandlers.onNodesDragOutOfBounds = (taskIds: string[], clientX: number, clientY: number) => {
      const callback = this.dragOutOfBoundsCallback;
      if (!callback) return;
      this.runEventCallback('dragOutOfBounds', () => callback(taskIds, clientX, clientY));
    };

    // Delete/Backspace 键 — 透传给 deleteKeyCallback（硬恢复重建 diagram 后由 setDiagram 自动重接）
    flowTemplateEventHandlers.onDeleteKeyPressed = () => {
      const callback = this.deleteKeyCallback;
      if (!callback) return;
      this.runEventCallback('deleteKey', () => callback());
    };
    
    this.logger.debug('模板事件处理器已注册');
  }

  private isCurrentTemplatePart(part: go.Part | null | undefined): boolean {
    return !!this.diagram && part?.diagram === this.diagram;
  }
  
  /**
   * 清理模板事件处理器
   */
  private clearTemplateEventHandlers(): void {
    flowTemplateEventHandlers.onNodeClick = undefined;
    flowTemplateEventHandlers.onNodeDoubleClick = undefined;
    flowTemplateEventHandlers.onSidecarToggle = undefined;
    flowTemplateEventHandlers.onLinkClick = undefined;
    flowTemplateEventHandlers.onLinkDeleteRequest = undefined;
    flowTemplateEventHandlers.onCrossTreeLabelClick = undefined;
    flowTemplateEventHandlers.onNodesDragOutOfBounds = undefined;
    // 【修复 L-39】补充清理 onDeleteKeyPressed 和 onSelectionChanged
    flowTemplateEventHandlers.onDeleteKeyPressed = undefined;
    flowTemplateEventHandlers.onSelectionChanged = undefined;
    // 补充清理端口悬停处理器，防止模板全局对象泄漏
    flowTemplateEventHandlers.onPortMouseEnter = undefined;
    flowTemplateEventHandlers.onPortMouseLeave = undefined;
  }

  /**
   * 将 GoJS 视图坐标转换为浏览器窗口坐标
   * @param viewX GoJS 视图坐标 X
   * @param viewY GoJS 视图坐标 Y
   * @returns 浏览器窗口坐标
   */
  private convertViewToWindowCoords(viewX: number, viewY: number): { windowX: number; windowY: number } {
    return convertFlowViewPointToWindowCoords({
      diagramDiv: this.diagramDiv,
      viewX,
      viewY,
    });
  }
  
  // ========== 回调注册方法 ==========
  
  onNodeClick(callback: NodeClickCallback): void {
    this.nodeClickCallback = callback;
  }

  onSidecarToggle(callback: SidecarToggleCallback): void {
    this.sidecarToggleCallback = callback;
  }
  
  onLinkClick(callback: LinkClickCallback): void {
    this.linkClickCallback = callback;
  }
  
  onLinkDelete(callback: LinkDeleteCallback): void {
    this.linkDeleteCallback = callback;
  }
  
  onLinkRelink(callback: LinkRelinkCallback): void {
    this.linkRelinkCallback = callback;
  }
  
  onLinkGesture(callback: LinkGestureCallback): void {
    this.linkGestureCallback = callback;
  }
  
  onSelectionMoved(callback: SelectionMovedCallback): void {
    this.selectionMovedCallback = callback;
  }
  
  onBackgroundClick(callback: BackgroundClickCallback): void {
    this.backgroundClickCallback = callback;
  }

  /**
   * 注册 Delete/Backspace 键回调（GoJS commandHandler 拦截后触发）
   */
  onDeleteKey(callback: () => void): void {
    this.deleteKeyCallback = callback;
  }

  /**
   * 注册拖拽节点出画布边界回调（支持多选拖入停泊坞）
   */
  onDragOutOfBounds(callback: (taskIds: string[], clientX: number, clientY: number) => void): void {
    this.dragOutOfBoundsCallback = callback;
  }
  
  // ========== 事件监听器设置 ==========
  
  /**
   * 设置所有 Diagram 级别的事件监听器
   * 
   * 注意：自定义事件（NodeClicked 等）通过 flowTemplateEventHandlers 处理，
   * 不需要在这里注册，因为 GoJS 的 addDiagramListener 只接受内置事件名称。
   */
  private setupEventListeners(): void {
    if (!this.diagram) return;
    
    const isMobile = this.uiState.isMobile();
    
    // ========== GoJS 原生事件监听 ==========
    
    // 选择移动完成
    this.addTrackedListener('SelectionMoved', (e: go.DiagramEvent) => {
      this.handleSelectionMoved(e);
    });
    
    // 连接线绘制完成
    this.addTrackedListener('LinkDrawn', (e: go.DiagramEvent) => {
      const link = e.subject;
      if (link && link.data) {
        const model = this.diagram!.model as go.GraphLinksModel;
        model.setDataProperty(link.data, 'fromPortId', '');
        model.setDataProperty(link.data, 'toPortId', '');
        link.invalidateRoute();
      }
      this.handleLinkGesture(e);
    });
    
    // 连接线重连
    this.addTrackedListener('LinkRelinked', (e: go.DiagramEvent) => {
      this.handleLinkRelinked(e);
    });
    
    // 背景点击
    this.addTrackedListener('BackgroundSingleClicked', () => {
      this.emitBackgroundClick();
    });
    
    // 视口变化（用于保存视图状态，由 FlowDiagramService 处理）
    // 这里不处理，保留给 FlowDiagramService
    
    // 移动端特殊处理：通过 ObjectSingleClicked/ObjectDoubleClicked 事件处理连接线和关联块标签的点击
    if (isMobile) {
      this.setupMobileLinkClickListeners();
    }
    
    this.logger.debug('事件监听器已设置');
  }

  private setupMobileLinkClickListeners(): void {
    this.addTrackedListener('ObjectSingleClicked', (e: go.DiagramEvent) => {
      this.handleMobileObjectClicked(e, false);
    });

    this.addTrackedListener('ObjectDoubleClicked', (e: go.DiagramEvent) => {
      this.handleMobileObjectClicked(e, true);
    });
  }

  private handleMobileObjectClicked(e: go.DiagramEvent, isDoubleClick: boolean): void {
    const subject = e.subject;
    const part = subject?.part;

    this.logger.debug(isDoubleClick ? '移动端 ObjectDoubleClicked' : '移动端 ObjectSingleClicked', {
      subjectType: subject?.constructor?.name,
      partType: part?.constructor?.name,
      isLink: part instanceof go.Link,
      hasData: !!part?.data
    });

    if (!(part instanceof go.Link) || !part.data || !this.isCurrentTemplatePart(part)) return;

    const { x, y } = this.getClickPositionFromEvent(part);
    this.logger.debug(isDoubleClick ? '移动端连接线/关联块双击' : '移动端连接线/关联块单击', {
      x,
      y,
      linkData: part.data
    });
    this.emitLinkClick(part.data, x, y, isDoubleClick);
  }
  
  // ========== 事件处理方法 ==========
  
  /**
   * 处理选择移动完成
   */
  private handleSelectionMoved(e: go.DiagramEvent): void {
    const projectIdAtMove = this.projectState.activeProjectId();
    
    if (this.positionSaveTimer !== null) {
      clearTimeout(this.positionSaveTimer);
    }
    
    this.positionSaveTimer = setTimeout(() => {
      if (!this.diagram) return;
      if (this.projectState.activeProjectId() !== projectIdAtMove) return;
      
      const movedNodes: Array<{ key: string; x: number; y: number; isUnassigned: boolean }> = [];
      
      e.subject.each((part: go.Part) => {
        if (part instanceof go.Node) {
          const loc = part.location;
          const nodeData = part.data;
          
          movedNodes.push({
            key: nodeData.key,
            x: loc.x,
            y: loc.y,
            isUnassigned: nodeData?.isUnassigned || nodeData?.stage === null
          });
        }
      });
      
      if (movedNodes.length > 0) {
        this.emitSelectionMoved(movedNodes);
      }
    }, GOJS_CONFIG.POSITION_SAVE_DEBOUNCE);
  }
  
  /**
   * 处理连接手势
   */
  private handleLinkGesture(e: go.DiagramEvent): void {
    if (!this.diagram || !this.diagramDiv) return;

    const link = e.subject;
    if (!(link instanceof go.Link)) return;

    const context = this.createLinkGestureContext(e);
    if (!context) {
      // LinkDrawn 端点无法解析：新画的连接线没有 store 背书，留在模型里就是幽灵边。
      // 按自连接相同的拒绝路径移除，并留下告警痕迹（正常绘制流程不可达，属于防御边界）
      this.logger.warn('LinkDrawn 端点无法解析，已移除未持久化的连接线', {
        linkData: link.data ?? null,
      });
      this.rejectLinkData(link.data);
      return;
    }

    // 防止自连接
    if (context.sourceId === context.targetId) {
      this.rejectLinkData(context.link.data);
      return;
    }

    const { x, y } = this.getLinkClickPosition(context.link);
    this.emitLinkGesture(context.sourceId, context.targetId, x, y, context.link);
  }

  private createLinkGestureContext(e: go.DiagramEvent): LinkGestureContext | null {
    const diagram = this.diagram;
    if (!diagram) return null;

    const link = e.subject;
    if (!(link instanceof go.Link)) return null;

    const linkingTool = diagram.toolManager.linkingTool as go.LinkingTool & { _originNode?: go.Node | null };
    const originNode = linkingTool.isActive && linkingTool._originNode instanceof go.Node
      ? linkingTool._originNode
      : null;
    const fromNode = originNode ?? link?.fromNode;
    const toNode = link?.toNode;
    const sourceId = fromNode?.data?.key;
    const targetId = toNode?.data?.key;

    if (originNode && link?.fromNode && originNode !== link.fromNode) {
      this.logger.warn('LinkDrawn 源节点与本次手势起点不一致，已优先采用手势起点', {
        gestureSourceId: originNode.data?.key,
        linkSourceId: link.fromNode.data?.key,
        targetId,
      });
    }

    if (!sourceId || !targetId) return null;

    return {
      link,
      sourceId,
      targetId,
    };
  }
  
  /**
   * 处理连接线重连
   */
  private handleLinkRelinked(e: go.DiagramEvent): void {
    if (!this.diagram || !this.diagramDiv) return;

    const context = this.createLinkRelinkContext(e);
    if (!context) {
      // 端点/断开节点无法解析（正常 relink 工具流程不可达）：GoJS 模型已被 relink 工具变更，
      // 这里不做模型回滚（缺少可信的旧端点，回滚可能造成二次变更），只留下告警痕迹；
      // 画布会在下一次 store 驱动的 updateDiagram 刷新时与 store 对齐
      this.logger.warn('LinkRelinked 端点无法解析，跳过 store 变更（画布将在下次刷新时与 store 对齐）', {
        linkData: (e.subject instanceof go.Link ? e.subject.data : null) ?? null,
      });
      return;
    }

    this.logger.debug('LinkRelinked 事件', {
      disconnectedNodeId: context.disconnectedNodeId,
      newFromId: context.newFromId,
      newToId: context.newToId,
      isCrossTree: context.isCrossTree
    });

    // 防止自连接
    if (context.newFromId === context.newToId) {
      this.rejectLinkData(context.link.data);
      return;
    }

    const { x, y } = this.getLinkClickPosition(context.link);
    const linkType: 'parent-child' | 'cross-tree' = context.isCrossTree ? 'cross-tree' : 'parent-child';
    const relinkInfo = this.resolveLinkRelinkInfo(context);

    if (this.linkRelinkCallback) {
      this.emitLinkRelink(linkType, relinkInfo, x, y, context.link);
    } else {
      this.emitLinkGesture(context.newFromId, context.newToId, x, y, context.link);
    }
  }

  private createLinkRelinkContext(e: go.DiagramEvent): LinkRelinkContext | null {
    const link = e.subject;
    if (!(link instanceof go.Link)) return null;

    const disconnectedNodeId = e.parameter?.part?.data?.key;
    const newFromId = link.fromNode?.data?.key;
    const newToId = link.toNode?.data?.key;
    if (!newFromId || !newToId || !disconnectedNodeId) return null;

    return {
      link,
      disconnectedNodeId,
      newFromId,
      newToId,
      isCrossTree: Boolean(link.data?.isCrossTree),
    };
  }

  private resolveLinkRelinkInfo(context: LinkRelinkContext): LinkRelinkInfo {
    // 权威判定被改变的端点：RelinkingTool.isForwards（true = 正在拖拽 to 端手柄）。
    // 不能用"disconnectedNodeId 等于哪个新端点"倒推对端：手柄拖起又放回原端口时
    // （常见的"改主意"手势）disconnected 与同端新端点相同，旧逻辑会误判成对端变更，
    // 派发错误的迁移/替换操作并弹出虚假的失败/成功 toast。
    // 按 isForwards 推导同端旧 ID 后，下游 oldParentId===newParentId /
    // oldChildId===newTargetId / 跨树端点不变守卫会把同端口回放归类为 cancelled
    const relinkingTool = this.diagram?.toolManager?.relinkingTool;
    if (relinkingTool) {
      return relinkingTool.isForwards
        ? this.createRelinkInfo('to', context.newFromId, context.disconnectedNodeId, context)
        : this.createRelinkInfo('from', context.disconnectedNodeId, context.newToId, context);
    }

    // 工具不可用兜底：disconnected 与某个新端点相同说明该端被放回原端口（判定为同端，
    // 下游守卫会归类为 cancelled）；端点全不相同时保持旧兜底语义按 from 端处理
    if (context.disconnectedNodeId === context.newToId) {
      return this.createRelinkInfo('to', context.newFromId, context.disconnectedNodeId, context);
    }
    return this.createRelinkInfo('from', context.disconnectedNodeId, context.newToId, context);
  }

  private createRelinkInfo(
    changedEnd: 'from' | 'to',
    oldFromId: string,
    oldToId: string,
    context: LinkRelinkContext,
  ): LinkRelinkInfo {
    return {
      changedEnd,
      oldFromId,
      oldToId,
      newFromId: context.newFromId,
      newToId: context.newToId
    };
  }

  private rejectLinkData(linkData: go.ObjectData | null | undefined): void {
    if (!this.diagram || !linkData) return;

    const model = this.diagram.model as go.GraphLinksModel;
    this.diagram.startTransaction('reject-self-link');
    model.removeLinkData(linkData);
    this.diagram.commitTransaction('reject-self-link');
  }
  
  /**
   * 获取连接线点击位置（屏幕坐标）
   * 优先使用实际点击位置（lastInput），回退到连接线中点
   */
  private getClickPositionFromEvent(link: go.Link): { x: number; y: number } {
    return getFlowClickPositionFromEvent({
      diagram: this.diagram,
      diagramDiv: this.diagramDiv,
      link,
    });
  }
  
  /**
   * 获取连接线中点位置（屏幕坐标）
   */
  private getLinkClickPosition(link: go.Link): { x: number; y: number } {
    return getFlowLinkClickPosition({
      diagram: this.diagram,
      diagramDiv: this.diagramDiv,
      link,
    });
  }
  
  // ========== 事件分发方法 ==========
  
  emitNodeClick(taskId: string, isDoubleClick: boolean): void {
    const callback = this.nodeClickCallback;
    if (!callback) return;
    this.runEventCallback('nodeClick', () => callback(taskId, isDoubleClick));
  }
  
  emitLinkClick(linkData: GoJSLinkData, x: number, y: number, isDoubleClick?: boolean): void {
    const callback = this.linkClickCallback;
    if (!callback) return;
    this.runEventCallback('linkClick', () => callback(linkData, x, y, isDoubleClick));
  }
  
  emitLinkDelete(linkData: GoJSLinkData): void {
    const callback = this.linkDeleteCallback;
    if (!callback) return;
    this.runEventCallback('linkDelete', () => callback(linkData));
  }
  
  emitLinkRelink(
    linkType: 'parent-child' | 'cross-tree',
    relinkInfo: LinkRelinkInfo,
    x: number,
    y: number,
    gojsLink: go.Link
  ): void {
    const callback = this.linkRelinkCallback;
    if (!callback) return;
    this.runEventCallback('linkRelink', () => callback(linkType, relinkInfo, x, y, gojsLink));
  }

  emitLinkGesture(sourceId: string, targetId: string, x: number, y: number, link: go.Link): void {
    const callback = this.linkGestureCallback;
    if (!callback) return;
    this.runEventCallback('linkGesture', () => callback(sourceId, targetId, x, y, link));
  }

  emitSelectionMoved(movedNodes: Array<{ key: string; x: number; y: number; isUnassigned: boolean }>): void {
    const callback = this.selectionMovedCallback;
    if (!callback) return;
    this.runEventCallback('selectionMoved', () => callback(movedNodes));
  }

  emitBackgroundClick(): void {
    const callback = this.backgroundClickCallback;
    if (!callback) return;
    this.runEventCallback('backgroundClick', () => callback());
  }

  private emitSidecarToggle(taskId: string): void {
    const callback = this.sidecarToggleCallback;
    if (!callback || !taskId) return;
    this.runEventCallback('sidecarToggle', () => callback(taskId));
  }

  private runEventCallback(eventName: string, callback: () => unknown): void {
    let result: unknown;
    try {
      result = this.zone.run(callback);
    } catch (error) {
      this.logEventCallbackFailure(eventName, error);
      return;
    }

    if (this.isPromiseLike(result)) {
      void Promise.resolve(result).catch(error => {
        this.logEventCallbackFailure(eventName, error);
      });
    }
  }

  private isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return typeof value === 'object'
      && value !== null
      && 'then' in value
      && typeof (value as { then?: unknown }).then === 'function';
  }

  private logEventCallbackFailure(eventName: string, error: unknown): void {
    try {
      this.logger.warn('Flow 事件回调执行失败', { eventName, error });
    } catch {
      // Logger failures must not re-break event dispatch isolation.
    }
  }
  
  // ========== 监听器管理 ==========
  
  /**
   * 注册并追踪一个 Diagram 事件监听器
   */
  addTrackedListener(
    name: go.DiagramEventName | string,
    handler: (e: go.DiagramEvent) => void
  ): void {
    if (!this.diagram) return;
    this.diagram.addDiagramListener(name as go.DiagramEventName, handler);
    this.registeredListeners.push({ name, handler });
  }
  
  /**
   * 移除所有已追踪的监听器
   */
  removeAllListeners(diagram: go.Diagram | null): void {
    if (!diagram) return;
    
    for (const listener of this.registeredListeners) {
      try {
        diagram.removeDiagramListener(listener.name as go.DiagramEventName, listener.handler);
      } catch (e) {
        this.logger.warn('移除监听器失败', { name: listener.name, error: e });
      }
    }
    
    this.registeredListeners = [];
    this.logger.debug('已清除所有事件监听器');
  }
  
  /**
   * 清除所有回调
   */
  clearCallbacks(): void {
    this.nodeClickCallback = null;
    this.sidecarToggleCallback = null;
    this.linkClickCallback = null;
    this.linkDeleteCallback = null;
    this.linkRelinkCallback = null;
    this.linkGestureCallback = null;
    this.selectionMovedCallback = null;
    this.backgroundClickCallback = null;
    // 【修复 H-27】dragOutOfBoundsCallback 未在 clearCallbacks 中清除
    this.dragOutOfBoundsCallback = null;
  }
  
  /**
   * 完全清理
   */
  dispose(): void {
    if (this.positionSaveTimer !== null) {
      clearTimeout(this.positionSaveTimer);
      this.positionSaveTimer = null;
    }
    this.removeAllListeners(this.diagram);
    this.clearCallbacks();
    // 【修复 M-45】dispose 时清理模板事件处理器，防止全局对象残留回调
    this.clearTemplateEventHandlers();
    this.diagram = null;
    this.diagramDiv = null;
  }
}
