import { Injectable, inject, NgZone, WritableSignal } from '@angular/core';
import { FlowEventService } from './flow-event.service';
import { FlowLinkService } from './flow-link.service';
import { FlowLinkRelinkService } from './flow-link-relink.service';
import { FlowDiagramService } from './flow-diagram.service';
import { FlowDragDropService } from './flow-drag-drop.service';
import { FlowSelectionService } from './flow-selection.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { LoggerService } from '../../../../services/logger.service';
import { flowTemplateEventHandlers } from './flow-template-events';
import * as go from 'gojs';

/**
 * 流程图事件注册服务
 * 
 * 负责注册所有 GoJS 图表事件回调：
 * - 节点点击
 * - 连接线点击
 * - 连接线删除
 * - 连接线手势
 * - 连接线重连
 * - 节点移动
 * - 背景点击
 * - Delete 键处理
 */
@Injectable({ providedIn: 'root' })
export class FlowEventRegistrationService {
  private readonly eventService = inject(FlowEventService);
  private readonly link = inject(FlowLinkService);
  private readonly relinkService = inject(FlowLinkRelinkService);
  private readonly diagram = inject(FlowDiagramService);
  private readonly dragDrop = inject(FlowDragDropService);
  private readonly selectionService = inject(FlowSelectionService);
  private readonly taskOpsAdapter = inject(TaskOperationAdapterService);
  private readonly uiState = inject(UiStateService);
  private readonly logger = inject(LoggerService).category('FlowEventReg');
  private readonly zone = inject(NgZone);

  /**
   * 注册节点点击事件
   */
  registerNodeClickHandler(
    isSelectMode: () => boolean,
    selectedTaskId: WritableSignal<string | null>,
    refreshDiagram: () => void,
    expandDrawerToOptimalHeight: () => void
  ): void {
    this.eventService.onNodeClick((taskId, isDoubleClick) => {
      if (this.link.isLinkMode()) {
        const created = this.link.handleLinkModeClick(taskId);
        if (created) {
          refreshDiagram();
        }
      } else if (isSelectMode()) {
        // 移动端框选模式：点击切换选中状态
        this.selectionService.toggleNodeSelection(taskId);
      } else {
        selectedTaskId.set(taskId);
        if (isDoubleClick) {
          this.uiState.isFlowDetailOpen.set(true);
          // 手机端：双击打开详情时，自动展开到最佳观看高度
          if (this.uiState.isMobile()) {
            expandDrawerToOptimalHeight();
          }
        }
      }
    });
  }

  /**
   * 注册连接线点击事件
   */
  registerLinkClickHandler(): void {
    this.eventService.onLinkClick((linkData, x, y, isDoubleClick = false) => {
      this.logger.debug('onLinkClick 回调触发', { 
        linkData, 
        isCrossTree: linkData?.isCrossTree,
        x, 
        y,
        isMobile: this.uiState.isMobile(),
        isDoubleClick
      });
      
      // 移动端：单击打开编辑器（仅跨树连接），双击/长按显示删除提示
      if (this.uiState.isMobile()) {
        if (isDoubleClick) {
          this.logger.debug('移动端长按/双击：显示删除提示');
          this.link.showLinkDeleteHint(linkData, x, y);
        } else if (linkData?.isCrossTree) {
          this.logger.debug('移动端单击：打开跨树连接编辑器');
          this.link.openConnectionEditor(linkData.from, linkData.to, linkData.description || '', x, y, linkData.title || '');
        }
        // 普通父子连接单击不做处理
      } else {
        // 桌面端：跨树连接线打开编辑器，普通连接线不处理（由右键菜单处理）
        if (linkData?.isCrossTree) {
          this.logger.debug('桌面端：打开跨树连接编辑器', { from: linkData.from, to: linkData.to });
          this.link.openConnectionEditor(linkData.from, linkData.to, linkData.description || '', x, y, linkData.title || '');
        }
      }
    });
  }

  /**
   * 注册连接线删除事件（右键菜单）
   */
  registerLinkDeleteHandler(refreshDiagram: () => void): void {
    this.eventService.onLinkDelete((linkData) => {
      this.logger.debug('onLinkDelete 回调触发（右键菜单）', { linkData });
      const result = this.link.deleteLink(linkData);
      if (result) {
        this.logger.debug('右键菜单删除成功', result);
        refreshDiagram();
      }
    });
  }

  /**
   * 注册连接线手势事件（拖拽创建连接）
   */
  registerLinkGestureHandler(refreshDiagram: () => void): void {
    this.eventService.onLinkGesture((sourceId, targetId, x, y, gojsLink) => {
      // 移除临时连接线
      this.diagram.removeLink(gojsLink);
      
      const action = this.link.handleLinkGesture(sourceId, targetId, x, y);
      if (action === 'create-cross-tree' || action === 'create-parent-child' || action === 'replace-subtree') {
        refreshDiagram();
      }
    });
  }

  /**
   * 注册连接线重连事件（子树迁移/跨树连接重连）
   */
  registerLinkRelinkHandler(refreshDiagram: () => void): void {
    this.eventService.onLinkRelink((linkType, relinkInfo, _x, _y, gojsLink) => {
      this.logger.debug('onLinkRelink 回调触发', { linkType, relinkInfo });
      
      // 移除 GoJS 中的临时连接线（实际数据由 store 管理）
      this.diagram.removeLink(gojsLink);
      
      const { changedEnd, oldFromId, oldToId, newFromId, newToId } = relinkInfo;
      
      if (linkType === 'parent-child') {
        // 父子连接重连
        if (changedEnd === 'from') {
          // from 端（父端）被改变：将子任务树迁移到新父任务下
          const result = this.relinkService.handleParentChildRelink(newToId, oldFromId, newFromId);
          if (result === 'success') {
            refreshDiagram();
          }
        } else {
          // to 端（子端/下游端点）被改变
          this.logger.debug('父子连接 to 端重连', { 
            parentId: newFromId, 
            oldChildId: oldToId, 
            newTargetId: newToId 
          });
          const result = this.relinkService.handleParentChildRelinkToEnd(newFromId, oldToId, newToId);
          if (result === 'success' || result === 'replace-subtree') {
            refreshDiagram();
          }
        }
      } else if (linkType === 'cross-tree') {
        // 跨树连接重连：删除旧连接，创建新连接
        const result = this.relinkService.handleCrossTreeRelink(
          oldFromId,
          oldToId,
          newFromId,
          newToId,
          changedEnd
        );
        if (result === 'success') {
          refreshDiagram();
        }
      }
    });
  }

  /**
   * 注册节点移动事件
   */
  registerSelectionMovedHandler(handleNodeMoved: (key: string, loc: go.Point, isUnassigned: boolean, diagram: go.Diagram) => void): void {
    this.eventService.onSelectionMoved((movedNodes) => {
      // 多节点移动时使用批处理模式，合并为单个撤销单元
      const needsBatch = movedNodes.length > 1;
      
      if (needsBatch) {
        this.taskOpsAdapter.beginPositionBatch();
      }
      
      try {
        movedNodes.forEach(node => {
          if (node.isUnassigned) {
            // 检测是否拖到连接线上
            const diagramInstance = this.diagram.diagramInstance;
            if (diagramInstance) {
              const loc = new go.Point(node.x, node.y);
              handleNodeMoved(node.key, loc, true, diagramInstance);
            }
          } else {
            // 单节点：带撤销的位置更新；批量：普通更新（由 endBatch 统一记录）
            if (needsBatch) {
              this.taskOpsAdapter.core.updateTaskPositionWithRankSync(node.key, node.x, node.y);
            } else {
              // 单节点拖拽完成，带撤销记录
              this.taskOpsAdapter.updateTaskPositionWithUndo(node.key, node.x, node.y);
            }
          }
        });
      } finally {
        if (needsBatch) {
          this.taskOpsAdapter.endPositionBatch();
        }
      }
    });
  }

  /**
   * 注册背景点击事件
   */
  registerBackgroundClickHandler(isPaletteOpen: WritableSignal<boolean>): void {
    this.eventService.onBackgroundClick(() => {
      this.logger.debug('backgroundClick 触发，关闭编辑器和删除提示');
      this.link.closeConnectionEditor();
      // 移动端：同时关闭删除提示
      if (this.uiState.isMobile()) {
        this.link.cancelLinkDelete();
        // 移动端：点击流程图画布时收缩左侧调色板（黑匣子栏）
        if (isPaletteOpen()) {
          isPaletteOpen.set(false);
        }
      }
    });
  }

  /**
   * 注册 Delete 键事件处理
   */
  registerDeleteKeyHandler(handleDeleteKeyPressed: () => void): void {
    flowTemplateEventHandlers.onDeleteKeyPressed = () => {
      this.zone.run(() => {
        handleDeleteKeyPressed();
      });
    };
  }

  /**
   * 注册所有事件（便捷方法）
   */
  registerAllEvents(options: {
    isSelectMode: () => boolean;
    selectedTaskId: WritableSignal<string | null>;
    refreshDiagram: () => void;
    expandDrawerToOptimalHeight: () => void;
    handleNodeMoved: (key: string, loc: go.Point, isUnassigned: boolean, diagram: go.Diagram) => void;
    isPaletteOpen: WritableSignal<boolean>;
    handleDeleteKeyPressed: () => void;
  }): void {
    this.registerNodeClickHandler(
      options.isSelectMode,
      options.selectedTaskId,
      options.refreshDiagram,
      options.expandDrawerToOptimalHeight
    );
    this.registerLinkClickHandler();
    this.registerLinkDeleteHandler(options.refreshDiagram);
    this.registerLinkGestureHandler(options.refreshDiagram);
    this.registerLinkRelinkHandler(options.refreshDiagram);
    this.registerSelectionMovedHandler(options.handleNodeMoved);
    this.registerBackgroundClickHandler(options.isPaletteOpen);
    this.registerDeleteKeyHandler(options.handleDeleteKeyPressed);
  }
}
