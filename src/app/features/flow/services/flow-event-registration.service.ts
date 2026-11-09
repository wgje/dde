import { Injectable, Injector, inject, WritableSignal } from '@angular/core';
import { FlowEventService } from './flow-event.service';
import { FlowLinkService } from './flow-link.service';
import { FlowLinkRelinkService } from './flow-link-relink.service';
import { FlowDiagramService } from './flow-diagram.service';
import { FlowDiagramDataService } from './flow-diagram-data.service';
import { FlowDragDropService } from './flow-drag-drop.service';
import { FlowSelectionService } from './flow-selection.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { ToastService } from '../../../../services/toast.service';
import { LoggerService } from '../../../../services/logger.service';
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
  private readonly injector = inject(Injector);
  private readonly eventService = inject(FlowEventService);
  private readonly link = inject(FlowLinkService);
  private readonly relinkService = inject(FlowLinkRelinkService);
  private readonly diagram = inject(FlowDiagramService);
  private readonly diagramData = inject(FlowDiagramDataService);
  private readonly dragDrop = inject(FlowDragDropService);
  private readonly selectionService = inject(FlowSelectionService);
  private readonly uiState = inject(UiStateService);
  private readonly toast = inject(ToastService);
  private readonly logger = inject(LoggerService).category('FlowEventReg');

  private get taskOpsAdapter(): TaskOperationAdapterService {
    return this.injector.get(TaskOperationAdapterService);
  }

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
        void this.link.handleLinkModeClick(taskId)
          .then(created => {
            if (created) {
              refreshDiagram();
            }
          })
          .catch(error => this.logger.warn('连接模式点击处理失败', error));
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
      
      // 移动端：单击打开编辑器（预览模式），长按/双击显示操作菜单
      if (this.uiState.isMobile()) {
        if (isDoubleClick) {
          // 长按/双击：显示操作菜单（编辑 + 删除）
          this.logger.debug('移动端长按/双击：显示操作菜单', { isCrossTree: linkData?.isCrossTree });
          this.link.showLinkActionMenu(linkData, x, y);
        } else {
          // 单击：打开编辑器，先进入预览模式
          // 用户在预览模式下点击预览区域才会进入编辑模式
          this.logger.debug('移动端单击：打开连接编辑器（预览模式）', { 
            isCrossTree: linkData?.isCrossTree,
            from: linkData.from,
            to: linkData.to
          });
          this.link.openConnectionEditor(linkData.from, linkData.to, linkData.description || '', x, y, linkData.title || '', {
            isCrossTree: !!linkData?.isCrossTree,
            mode: 'preview',  // 移动端单击先进入预览模式，再次点击预览区域或同一关联块才进入编辑模式
          });
        }
      } else {
        // 桌面端：跨树连接线打开编辑器，普通连接线不处理（由右键菜单处理）
        if (linkData?.isCrossTree) {
          this.logger.debug('桌面端：打开跨树连接编辑器', { from: linkData.from, to: linkData.to });
          this.link.openConnectionEditor(linkData.from, linkData.to, linkData.description || '', x, y, linkData.title || '', {
            isCrossTree: true,
            mode: 'preview',
          });
        }
      }
    });
  }

  registerSidecarToggleHandler(): void {
    this.eventService.onSidecarToggle((taskId) => {
      this.diagramData.toggleSidecarExpanded(taskId);
    });
  }

  /**
   * 注册连接线删除事件（右键菜单）
   */
  registerLinkDeleteHandler(refreshDiagram: () => void): void {
    this.eventService.onLinkDelete((linkData) => {
      this.logger.debug('onLinkDelete 回调触发（右键菜单）', { linkData });
      void this.link.deleteLink(linkData)
        .then(result => {
          if (result) {
            this.logger.debug('右键菜单删除成功', result);
            refreshDiagram();
          }
        })
        .catch(error => this.logger.warn('右键菜单删除失败', error));
    });
  }

  /**
   * 注册连接线手势事件（拖拽创建连接）
   */
  registerLinkGestureHandler(refreshDiagram: () => void): void {
    this.eventService.onLinkGesture((sourceId, targetId, x, y, gojsLink) => {
      // 移除临时连接线
      this.diagram.removeLink(gojsLink);

      void this.link.handleLinkGesture(sourceId, targetId, x, y)
        .then(action => {
          if (action === 'create-cross-tree' || action === 'create-parent-child' || action === 'replace-subtree') {
            refreshDiagram();
          }
        })
        .catch(error => this.logger.warn('连接手势处理失败', error));
    });
  }

  /**
   * 注册连接线重连事件（子树迁移/跨树连接重连）
   */
  registerLinkRelinkHandler(refreshDiagram: () => void): void {
    this.eventService.onLinkRelink(async (linkType, relinkInfo, _x, _y, gojsLink) => {
      this.logger.debug('onLinkRelink 回调触发', { linkType, relinkInfo });
      
      // 移除 GoJS 中的临时连接线（实际数据由 store 管理）
      this.diagram.removeLink(gojsLink);
      
      const { changedEnd, oldFromId, oldToId, newFromId, newToId } = relinkInfo;
      
      // GoJS 连接线已被移除：无论 store 变更结果是 success/cancelled/error 还是抛出异常，
      // 都必须从 store 重新渲染，否则失败路径会让原有连接线从画布上凭空消失（图/store 漂移）
      try {
        if (linkType === 'parent-child') {
          // 父子连接重连
          if (changedEnd === 'from') {
            // from 端（父端）被改变：将子任务树迁移到新父任务下
            await this.relinkService.handleParentChildRelink(newToId, oldFromId, newFromId);
          } else {
            // to 端（子端/下游端点）被改变
            this.logger.debug('父子连接 to 端重连', { 
              parentId: newFromId, 
              oldChildId: oldToId, 
              newTargetId: newToId 
            });
            await this.relinkService.handleParentChildRelinkToEnd(newFromId, oldToId, newToId);
          }
        } else if (linkType === 'cross-tree') {
          // 跨树连接重连：删除旧连接，创建新连接
          await this.relinkService.handleCrossTreeRelink(
            oldFromId,
            oldToId,
            newFromId,
            newToId,
            changedEnd
          );
        }
      } finally {
        refreshDiagram();
      }
    });
  }

  /**
   * 注册节点移动事件
   */
  registerSelectionMovedHandler(
    handleNodeMoved: (key: string, loc: go.Point, isUnassigned: boolean, diagram: go.Diagram) => void | Promise<unknown>
  ): void {
    this.eventService.onSelectionMoved((movedNodes) => {
      void this.handleSelectionMovedPersistence(movedNodes, handleNodeMoved);
    });
  }

  private async handleSelectionMovedPersistence(
    movedNodes: Array<{ key: string; x: number; y: number; isUnassigned: boolean }>,
    handleNodeMoved: (key: string, loc: go.Point, isUnassigned: boolean, diagram: go.Diagram) => void | Promise<unknown>,
  ): Promise<void> {
    if (this.rollbackSelectionMovedWhenReadOnly(movedNodes)) {
      return;
    }

    await this.persistSelectionMovedPositions(movedNodes, handleNodeMoved);
  }

  private rollbackSelectionMovedWhenReadOnly(
    movedNodes: Array<{ key: string; x: number; y: number; isUnassigned: boolean }>,
  ): boolean {
    if (!this.taskOpsAdapter.isHintOnlyStartupReadOnly()) return false;

    this.refreshDiagramFromStore();
    if (movedNodes.length > 0) {
      this.toast.info('会话确认中', '移动节点暂不可用，owner 确认完成前保持只读');
    }
    return true;
  }

  private refreshDiagramFromStore(): void {
    const diagramInstance = this.diagram.diagramInstance;
    if (diagramInstance) {
      diagramInstance.updateAllTargetBindings();
      diagramInstance.requestUpdate();
    }
  }

  private async persistSelectionMovedPositions(
    movedNodes: Array<{ key: string; x: number; y: number; isUnassigned: boolean }>,
    handleNodeMoved: (key: string, loc: go.Point, isUnassigned: boolean, diagram: go.Diagram) => void | Promise<unknown>,
  ): Promise<void> {
    const needsBatch = movedNodes.length > 1;
    if (needsBatch) {
      this.taskOpsAdapter.beginPositionBatch();
    }

    let allWritesSaved = false;
    try {
      const results = await Promise.all(
        this.createSelectionMovedPositionWrites(movedNodes, handleNodeMoved, needsBatch),
      );
      if (results.some(result => result === false)) {
        throw new Error('Node position local persistence failed');
      }
      allWritesSaved = true;
    } catch (error) {
      this.logger.warn('节点位置本地持久化失败', error);
      this.refreshDiagramFromStore();
    } finally {
      this.closeSelectionMovedPositionBatch(needsBatch, allWritesSaved);
    }
  }

  private createSelectionMovedPositionWrites(
    movedNodes: Array<{ key: string; x: number; y: number; isUnassigned: boolean }>,
    handleNodeMoved: (key: string, loc: go.Point, isUnassigned: boolean, diagram: go.Diagram) => void | Promise<unknown>,
    needsBatch: boolean,
  ): Array<Promise<unknown>> {
    const diagramInstance = this.diagram.diagramInstance;
    return movedNodes.flatMap(node => {
      if (node.isUnassigned) {
        if (!diagramInstance) return [];
        const loc = new go.Point(node.x, node.y);
        return [Promise.resolve(handleNodeMoved(node.key, loc, true, diagramInstance))];
      }
      if (needsBatch) {
        return [this.taskOpsAdapter.updateTaskPositionWithRankSync(node.key, node.x, node.y, { toast: false })];
      }
      return [this.taskOpsAdapter.updateTaskPositionWithUndo(node.key, node.x, node.y)];
    });
  }

  private closeSelectionMovedPositionBatch(needsBatch: boolean, allWritesSaved: boolean): void {
    if (!needsBatch) return;
    if (allWritesSaved) {
      this.taskOpsAdapter.endPositionBatch();
    } else {
      this.taskOpsAdapter.cancelPositionBatch();
    }
  }

  /**
   * 注册背景点击事件
   */
  registerBackgroundClickHandler(isPaletteOpen: WritableSignal<boolean>): void {
    this.eventService.onBackgroundClick(() => {
      this.logger.debug('backgroundClick 触发，关闭编辑器和菜单');
      const currentEditor = this.link.connectionEditorData();

      // 移动端编辑模式下点击背景：先保存并切换到预览模式，而不是关闭编辑器
      // 这样用户可以继续查看内容，再次点击背景才会关闭
      if (
        currentEditor &&
        this.uiState.isMobile() &&
        currentEditor.mode === 'edit' &&
        !this.link.shouldIgnoreConnectionEditorBackgroundClose()
      ) {
        this.link.setConnectionEditorMode('preview');
      } else if (
        !currentEditor ||
        !this.uiState.isMobile() ||
        (currentEditor.mode === 'preview' && !this.link.shouldIgnoreConnectionEditorBackgroundClose())
      ) {
        // 非移动端、无编辑器、或预览模式下点击背景：直接关闭
        this.link.closeConnectionEditor();
      }
      // 其他情况（如保护窗口期内）：不做任何操作

      // 移动端：同时关闭操作菜单和删除提示
      if (this.uiState.isMobile()) {
        this.link.cancelActionMenu();
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
   *
   * 必须经 FlowEventService 的回调注册表（内部 runEventCallback 已含 zone.run 与异常隔离），
   * 不能直接写 flowTemplateEventHandlers：硬恢复原地重建 diagram 时会清空全局处理器，
   * 只有注册表中的回调才会被新 diagram 的 setupTemplateEventHandlers 重接，
   * 否则恢复后 Delete/Backspace 静默失效（GoJS 原生删除已被禁用，无兜底）
   */
  registerDeleteKeyHandler(handleDeleteKeyPressed: () => void): void {
    this.eventService.onDeleteKey(handleDeleteKeyPressed);
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
    this.registerSidecarToggleHandler();
    this.registerLinkClickHandler();
    this.registerLinkDeleteHandler(options.refreshDiagram);
    this.registerLinkGestureHandler(options.refreshDiagram);
    this.registerLinkRelinkHandler(options.refreshDiagram);
    this.registerSelectionMovedHandler(options.handleNodeMoved);
    this.registerBackgroundClickHandler(options.isPaletteOpen);
    this.registerDeleteKeyHandler(options.handleDeleteKeyPressed);
    this.registerDragOutOfBoundsHandler();
  }

  /**
   * 注册拖拽出画布边界事件（多选拖入停泊坞；单任务拖入停泊坞由同一路径覆盖）
   */
  private registerDragOutOfBoundsHandler(): void {
    this.eventService.onDragOutOfBounds((taskIds, clientX, clientY) => {
      this.dragDrop.startDragToDock(taskIds, clientX, clientY);
    });
  }
}
