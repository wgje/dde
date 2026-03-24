import { Injectable, inject, signal, DestroyRef, OnDestroy } from '@angular/core';
import { ProjectStateService } from '../../../../services/project-state.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { FlowLayoutService } from './flow-layout.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { Task } from '../../../../models';
import { GOJS_CONFIG, UI_CONFIG } from '../../../../config';
import { getErrorMessage } from '../../../../utils/result';
import { readTaskDragPayload, writeTaskDragPayload } from '../../../../utils/task-drag-payload';
import * as go from 'gojs';

/**
 * 插入位置信息
 */
export interface InsertPositionInfo {
  /** 作为子节点插入的父节点ID */
  parentId?: string;
  /** 插入到该节点之前（同级） */
  beforeTaskId?: string;
  /** 插入到该节点之后（同级） */
  afterTaskId?: string;
  /** 插入到连接线上（两个节点之间） */
  insertOnLink?: {
    sourceId: string;
    targetId: string;
  };
}

/**
 * 拖放结果回调
 */
export interface DropResultCallback {
  (task: Task, position: InsertPositionInfo, docPoint: go.Point): void;
}

/**
 * FlowDragDropService - 拖放处理服务
 * 
 * 职责：
 * - 从待分配区域拖放到画布
 * - 从画布拖回待分配区域
 * - 拖放插入位置计算
 * - 连接线上的插入检测
 * 
 * 设计原则：
 * - 纯逻辑服务，不持有 DOM 引用
 * - 通过回调与组件通信
 * - 依赖 GoJS Diagram 实例通过参数传入
 */
@Injectable({
  providedIn: 'root'
})
export class FlowDragDropService implements OnDestroy {
  private readonly projectState = inject(ProjectStateService);
  private readonly taskOps = inject(TaskOperationAdapterService);
  private readonly layoutService = inject(FlowLayoutService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowDragDrop');
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);
  
  constructor() {
    // 服务销毁时确保清除残留的全局指针事件监听
    this.destroyRef.onDestroy(() => this.ngOnDestroy());
  }

  // ========== 状态 ==========
  
  /** 拖放目标是否激活（高亮待分配区域） */
  readonly isDropTargetActive = signal(false);
  
  /** 当前从流程图拖动的任务ID */
  private draggingFromDiagramId: string | null = null;
  
  // ========== 公开方法 ==========
  
  /**
   * 开始拖动（从待分配区域）
   * @param event 拖动事件
   * @param task 被拖动的任务
   */
  startDrag(event: DragEvent, task: Task): void {
    if (event.dataTransfer) {
      writeTaskDragPayload(event.dataTransfer, {
        v: 1,
        type: 'task',
        taskId: task.id,
        projectId: this.projectState.activeProjectId(),
        fromProjectId: this.projectState.activeProjectId(),
        source: 'flow',
      });
      event.dataTransfer.effectAllowed = "move";
    }
  }
  
  /**
   * 开始从流程图拖动节点（用于拖回待分配区域）
   */
  startDragFromDiagram(taskId: string): void {
    this.draggingFromDiagramId = taskId;
    this.isDropTargetActive.set(true);
  }
  
  /**
   * 结束从流程图拖动
   */
  endDragFromDiagram(): void {
    this.draggingFromDiagramId = null;
    this.isDropTargetActive.set(false);
  }
  
  /**
   * 待分配区域 dragover 事件处理
   */
  handleDragOver(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    this.isDropTargetActive.set(true);
  }
  
  /**
   * 待分配区域 dragleave 事件处理
   */
  handleDragLeave(): void {
    this.isDropTargetActive.set(false);
  }
  
  /**
   * 待分配区域 drop 事件处理
   * 将任务从流程图解除分配
   * @returns 是否成功处理
   */
  handleDropToUnassigned(event: DragEvent): boolean {
    event.preventDefault();
    this.isDropTargetActive.set(false);

    const task = this.resolveDroppedTask(event.dataTransfer);
    if (!task) return false;
    if (task.stage !== null) {
      this.taskOps.detachTask(task.id);
      this.toast.success('已移至待分配', `任务 "${task.title}" 已解除分配`);
      return true;
    }
    return false;
  }
  
  /**
   * 处理拖放到流程图画布
   * @param event 拖放事件
   * @param diagram GoJS Diagram 实例
   * @param callback 处理结果回调
   */
  handleDropToDiagram(
    event: DragEvent,
    diagram: go.Diagram,
    callback: DropResultCallback
  ): void {
    event.preventDefault();

    const task = this.resolveDroppedTask(event.dataTransfer);
    if (!task) return;
    const pt = diagram.lastInput.viewPoint;
    const loc = diagram.transformViewToDoc(pt);

    // 查找插入位置
    const insertInfo = this.findInsertPosition(loc, diagram);

    callback(task, insertInfo, loc);
  }
  
  /**
   * 根据位置查找插入点
   * 支持插入到连接线上（两个节点之间）
   */
  findInsertPosition(loc: go.Point, diagram: go.Diagram): InsertPositionInfo {
    const threshold = GOJS_CONFIG.LINK_CAPTURE_THRESHOLD;
    
    // 优先检测是否拖放到连接线上
    const linkInsertInfo = this.findLinkAtPosition(loc, diagram);
    if (linkInsertInfo) {
      this.logger.info('拖放位置匹配连接线', linkInsertInfo);
      return { insertOnLink: linkInsertInfo };
    }
    
    // 检测节点附近
    let closestNode = null as go.Node | null;
    let closestDistance = Infinity;
    let insertPosition: string = 'after';
    
    diagram.nodes.each((node: go.Node) => {
      // 跳过待分配节点
      const nodeData = node.data as go.ObjectData;
      if (nodeData?.isUnassigned || nodeData?.stage === null) {
        return;
      }
      
      const nodeLoc = node.location;
      const dx = loc.x - nodeLoc.x;
      const dy = loc.y - nodeLoc.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      if (distance < threshold && distance < closestDistance) {
        closestDistance = distance;
        closestNode = node;
        
        // 根据相对位置判断插入方式
        if (dx > 100) {
          insertPosition = 'child';
        } else if (dy < -30) {
          insertPosition = 'before';
        } else {
          insertPosition = 'after';
        }
      }
    });
    
    if (!closestNode) return {};
    
    const closestNodeData = closestNode.data as go.ObjectData;
    const nodeId = closestNodeData.key as string;
    
    if (insertPosition === 'child') {
      return { parentId: nodeId };
    } else if (insertPosition === 'before') {
      return { beforeTaskId: nodeId };
    } else {
      return { afterTaskId: nodeId };
    }
  }
  
  /**
   * 将任务插入到两个节点之间（连接线上）
   * @param taskId 要插入的任务ID
   * @param sourceId 原父节点ID
   * @param targetId 原子节点ID
   * @param loc 拖放位置
   */
  insertTaskBetweenNodes(
    taskId: string,
    sourceId: string,
    targetId: string,
    loc: go.Point
  ): boolean {
    const sourceTask = this.projectState.getTask(sourceId);
    const targetTask = this.projectState.getTask(targetId);
    
    if (!sourceTask || !targetTask) {
      this.logger.warn('insertTaskBetweenNodes: 找不到源或目标任务', { sourceId, targetId });
      return false;
    }
    
    // 确保 source 是 target 的直接父节点
    if (targetTask.parentId !== sourceId) {
      this.logger.warn('insertTaskBetweenNodes: 目标任务的父节点不是源节点', {
        targetParentId: targetTask.parentId,
        sourceId
      });
      return false;
    }
    
    this.logger.info('插入任务到连接线', { taskId, sourceId, targetId });
    
    // 使用 taskOps 的方法完成插入
    this.taskOps.insertTaskBetween(taskId, sourceId, targetId);
    
    // 更新拖放位置
    setTimeout(() => {
      this.taskOps.updateTaskPosition(taskId, loc.x, loc.y);
    }, UI_CONFIG.MEDIUM_DELAY);
    
    this.toast.success('任务已插入', '任务已插入到两个节点之间');
    return true;
  }
  
  /**
   * 处理节点移动（从待分配到已分配区域）
   */
  handleNodeMoved(
    nodeKey: string,
    loc: go.Point,
    _isUnassigned: boolean,
    _diagram: go.Diagram
  ): void {
    // 场景二：待分配节点在流程图内移动，仅更新位置。
    // 不再支持“拖到连接线上立即插入并任务化”，任务化只在“拉线”确认时发生。
    this.taskOps.core.updateTaskPositionWithRankSync(nodeKey, loc.x, loc.y);
  }
  
  // ========== 私有方法 ==========
  
  /**
   * 检测指定位置是否靠近某条父子连接线
   */
  private findLinkAtPosition(
    loc: go.Point,
    diagram: go.Diagram
  ): { sourceId: string; targetId: string } | null {
    const linkThreshold = 50;
    let closestLink = null as go.Link | null;
    let closestDistance = Infinity;
    
    diagram.links.each((link: go.Link) => {
      // 只处理父子连接线（非跨树连接）
      const linkData = link.data as go.ObjectData;
      if (linkData?.isCrossTree) return;
      
      // 确保连接线有有效数据
      if (!linkData?.from || !linkData?.to) return;
      
      // 计算点到连接线的距离
      const distance = this.pointToLinkDistance(loc, link);
      
      if (distance < linkThreshold && distance < closestDistance) {
        closestDistance = distance;
        closestLink = link;
      }
    });
    
    if (closestLink && closestLink.data) {
      const data = closestLink.data as go.ObjectData & { from?: string; to?: string };
      if (!data.from || !data.to) return null;
      this.logger.info('检测到靠近连接线', {
        from: data.from,
        to: data.to,
        distance: closestDistance
      });
      return {
        sourceId: data.from,
        targetId: data.to
      };
    }
    
    return null;
  }
  
  /**
   * 计算点到连接线的最近距离
   */
  private pointToLinkDistance(point: go.Point, link: go.Link): number {
    const fromNode = link.fromNode;
    const toNode = link.toNode;
    if (!fromNode || !toNode) return Infinity;
    
    const startPoint = fromNode.location;
    const endPoint = toNode.location;
    
    if (!startPoint || !endPoint) return Infinity;
    
    return this.pointToSegmentDistance(
      point.x, point.y,
      startPoint.x, startPoint.y,
      endPoint.x, endPoint.y
    );
  }
  
  /**
   * 计算点到线段的最短距离
   */
  private pointToSegmentDistance(
    px: number, py: number,
    x1: number, y1: number,
    x2: number, y2: number
  ): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSquared = dx * dx + dy * dy;
    
    if (lengthSquared === 0) {
      return Math.sqrt((px - x1) * (px - x1) + (py - y1) * (py - y1));
    }
    
    let t = ((px - x1) * dx + (py - y1) * dy) / lengthSquared;
    t = Math.max(0, Math.min(1, t));
    
    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    
    return Math.sqrt((px - projX) * (px - projX) + (py - projY) * (py - projY));
  }
  
  /**
   * 统一的拖放处理逻辑
   * 合并了桌面端 handleDiagramDrop 和移动端 handleTouchDrop 的共同逻辑
   * 
   * @param task 被拖放的任务
   * @param insertInfo 插入位置信息
   * @param docPoint 拖放位置（文档坐标）
   * @param delayMs 位置更新延迟（桌面端使用 100，移动端使用 UI_CONFIG.MEDIUM_DELAY）
   */
  processDrop(
    task: Task,
    insertInfo: InsertPositionInfo,
    docPoint: go.Point,
    delayMs: number = 100
  ): void {
    const tasks = this.projectState.tasks();
    
    // 场景：待分配块拖入画布仅更新位置，不立刻任务化
    if (task.stage === null) {
      this.taskOps.updateTaskPosition(task.id, docPoint.x, docPoint.y);
      this.layoutService.setNodePosition(task.id, docPoint.x, docPoint.y);
      return;
    }

    if (insertInfo.insertOnLink) {
      const { sourceId, targetId } = insertInfo.insertOnLink;
      this.insertTaskBetweenNodes(task.id, sourceId, targetId, docPoint);
    } else if (insertInfo.parentId) {
      const parentTask = this.projectState.getTask(insertInfo.parentId);
      if (parentTask) {
        const newStage = (parentTask.stage || 1) + 1;
        this.taskOps.moveTaskToStage(task.id, newStage, insertInfo.beforeTaskId, insertInfo.parentId);
        setTimeout(() => {
          this.taskOps.updateTaskPosition(task.id, docPoint.x, docPoint.y);
        }, delayMs);
      }
    } else if (insertInfo.beforeTaskId || insertInfo.afterTaskId) {
      const refTask = this.projectState.getTask(insertInfo.beforeTaskId || insertInfo.afterTaskId!);
      if (refTask?.stage) {
        if (insertInfo.afterTaskId) {
          const siblings = tasks
            .filter(t => t.stage === refTask.stage && t.parentId === refTask.parentId)
            .sort((a, b) => a.rank - b.rank);
          const afterIndex = siblings.findIndex(t => t.id === refTask.id);
          const nextSibling = siblings[afterIndex + 1];
          this.taskOps.moveTaskToStage(task.id, refTask.stage, nextSibling?.id || null, refTask.parentId);
        } else {
          this.taskOps.moveTaskToStage(task.id, refTask.stage, insertInfo.beforeTaskId, refTask.parentId);
        }
        setTimeout(() => {
          this.taskOps.updateTaskPosition(task.id, docPoint.x, docPoint.y);
        }, delayMs);
      }
    } else {
      this.taskOps.updateTaskPosition(task.id, docPoint.x, docPoint.y);
    }
  }
  
  /**
   * 处理待分配区域 drop 的完整逻辑
   * 包含：解除分配、待分配块之间重挂载
   * @returns 是否需要刷新图表
   */
  handleFullUnassignedDrop(event: DragEvent): boolean {
    event.preventDefault();

    const draggedTask = this.resolveDroppedTask(event.dataTransfer);
    if (!draggedTask) {
      return this.handleDropToUnassigned(event);
    }

    // 场景1：已分配任务拖回待分配区 → 解除分配
    if (draggedTask.stage !== null) {
      return this.handleDropToUnassigned(event);
    }

    // 场景2：待分配块之间拖放 → 改变父子关系
    if (draggedTask.stage === null) {
      const unassignedTasks = this.projectState.unassignedTasks();
      const targetCandidates = unassignedTasks.filter(t => t.id !== draggedTask.id);

      if (targetCandidates.length > 0) {
        const targetTask = targetCandidates[0];
        const result = this.taskOps.moveTaskToStage(draggedTask.id, null, undefined, targetTask.id);
        if (!result.ok) {
          this.toast.error('重新挂载失败', getErrorMessage(result.error));
        } else {
          this.toast.success('已重新挂载', `"${draggedTask.title}" 已移到 "${targetTask.title}" 下`);
        }
        return result.ok;
      }
    }
    return false;
  }

  private resolveDroppedTask(dataTransfer: DataTransfer | null | undefined): Task | null {
    if (!dataTransfer) return null;

    const payload = readTaskDragPayload(dataTransfer);
    if (payload) {
      const task = this.projectState.getTask(payload.taskId);
      if (task) return task;
    }

    const jsonData = dataTransfer.getData("application/json") || dataTransfer.getData("text");
    if (!jsonData) return null;

    try {
      const raw = JSON.parse(jsonData) as Partial<Task> & { id?: unknown };
      const candidateId = typeof raw.id === 'string' ? raw.id : null;
      if (candidateId) {
        return this.projectState.getTask(candidateId) ?? (raw as Task);
      }
      return null;
    } catch {
      // legacy plain task id
      return this.projectState.getTask(jsonData) ?? null;
    }
  }

  /**
   * 释放资源
   */
  dispose(): void {
    this.isDropTargetActive.set(false);
    this.draggingFromDiagramId = null;
    this.endAltDragToDock();
  }

  // ========== Alt+拖拽到停泊坞 ==========

  private readonly dockEngine = inject(DockEngineService);

  /** 拖拽到停泊坞状态：当前正在拖拽的任务ID（单个） */
  private altDragTaskId: string | null = null;
  /** 拖拽到停泊坞状态：当前正在拖拽的任务ID列表（多选） */
  private dragToDockTaskIds: string[] = [];
  /** 拖拽到停泊坞状态：幽灵指示元素 */
  private altDragGhost: HTMLElement | null = null;
  /** 拖拽到停泊坞激活信号（供停泊坞监听悬停状态） */
  readonly isAltDragActive = signal(false);

  private boundAltDragMove: ((e: PointerEvent) => void) | null = null;
  private boundAltDragUp: ((e: PointerEvent) => void) | null = null;

  /**
   * 开始 Alt+拖拽：从流程图节点拖到停泊坞（单个任务）
   * 使用指针跟踪代替 HTML5 DnD（GoJS 内部拖拽与 HTML5 DnD 不兼容）
   */
  startAltDragToDock(taskId: string, clientX: number, clientY: number): void {
    this.startDragToDock([taskId], clientX, clientY);
  }

  /**
   * 开始拖拽到停泊坞：支持多选任务
   * 当 GoJS 中的节点被拖出画布边界时触发，使用指针跟踪替代 HTML5 DnD
   */
  startDragToDock(taskIds: string[], clientX: number, clientY: number): void {
    // 清理可能残留的前一次拖拽
    this.endAltDragToDock();

    // 过滤有效任务
    const validTasks = taskIds
      .map(id => this.projectState.getTask(id))
      .filter((t): t is Task => t !== null && t !== undefined && t.status === 'active');

    if (validTasks.length === 0) return;

    this.dragToDockTaskIds = validTasks.map(t => t.id);
    this.altDragTaskId = this.dragToDockTaskIds[0];
    this.isAltDragActive.set(true);

    // 创建幽灵提示元素（使用 DOM API 构建，避免 innerHTML/XSS 风险）
    const ghost = document.createElement('div');
    ghost.setAttribute('data-alt-drag-ghost', 'true');
    ghost.className = 'fixed z-[9999] px-3 py-2 bg-indigo-500/90 text-white rounded-lg shadow-xl text-xs font-medium pointer-events-none whitespace-nowrap flex items-center gap-1.5';
    this.buildGhostContent(ghost, validTasks[0].title || '未命名任务', validTasks.length);
    ghost.style.left = `${clientX + 12}px`;
    ghost.style.top = `${clientY - 16}px`;
    document.body.appendChild(ghost);
    this.altDragGhost = ghost;

    // 自动展开停泊坞面板
    if (!this.dockEngine.dockExpanded()) {
      this.dockEngine.setDockExpanded(true);
    }

    // 绑定全局指针事件
    this.boundAltDragMove = (e: PointerEvent) => this.onAltDragMove(e);
    this.boundAltDragUp = (e: PointerEvent) => this.onAltDragUp(e);
    document.addEventListener('pointermove', this.boundAltDragMove, { passive: true });
    document.addEventListener('pointerup', this.boundAltDragUp);
    document.addEventListener('pointercancel', this.boundAltDragUp);

    this.logger.info('开始拖拽到停泊坞', {
      taskIds: this.dragToDockTaskIds,
      count: this.dragToDockTaskIds.length,
      firstTitle: validTasks[0].title,
    });
  }

  private onAltDragMove(e: PointerEvent): void {
    if (!this.altDragGhost) return;
    this.altDragGhost.style.left = `${e.clientX + 12}px`;
    this.altDragGhost.style.top = `${e.clientY - 16}px`;

    // 检测是否悬停在停泊坞 drop-zone 上方
    const dropZone = document.querySelector('[data-testid="dock-v3-drop-zone"]');
    if (dropZone) {
      const rect = dropZone.getBoundingClientRect();
      const isOver = e.clientX >= rect.left && e.clientX <= rect.right &&
                     e.clientY >= rect.top && e.clientY <= rect.bottom;
      // 使用 alt-drag-hover 类名提供视觉反馈（不与 Angular 的 [class.active] 绑定冲突）
      if (isOver) {
        dropZone.classList.add('alt-drag-hover');
      } else {
        dropZone.classList.remove('alt-drag-hover');
      }
    }

    // 检测是否悬停在停泊坞卡片区域（整个坞栏面板）
    const dockPanel = document.querySelector('[data-testid="dock-v3-panel"]');
    if (dockPanel) {
      const rect = dockPanel.getBoundingClientRect();
      const isOverPanel = e.clientX >= rect.left && e.clientX <= rect.right &&
                          e.clientY >= rect.top && e.clientY <= rect.bottom;
      if (isOverPanel) {
        const count = this.dragToDockTaskIds.length;
        const firstTitle = this.projectState.getTask(this.dragToDockTaskIds[0])?.title || '未命名任务';
        this.buildGhostContent(this.altDragGhost, firstTitle, count, '松开放入');
      }
    }
  }

  private onAltDragUp(e: PointerEvent): void {
    const taskIds = [...this.dragToDockTaskIds];
    if (taskIds.length === 0) {
      this.endAltDragToDock();
      return;
    }

    // 检测释放位置是否在停泊坞区域内（drop-zone 或整个坞栏面板）
    const dockPanel = document.querySelector('[data-testid="dock-v3-panel"]');
    const dropZone = document.querySelector('[data-testid="dock-v3-drop-zone"]');
    let isOverDock = false;

    if (dropZone) {
      const rect = dropZone.getBoundingClientRect();
      isOverDock = e.clientX >= rect.left && e.clientX <= rect.right &&
                   e.clientY >= rect.top && e.clientY <= rect.bottom;
    }
    if (!isOverDock && dockPanel) {
      const rect = dockPanel.getBoundingClientRect();
      isOverDock = e.clientX >= rect.left && e.clientX <= rect.right &&
                   e.clientY >= rect.top && e.clientY <= rect.bottom;
    }

    if (isOverDock) {
      let dockedCount = 0;
      for (const taskId of taskIds) {
        const task = this.projectState.getTask(taskId);
        if (!task) continue;
        this.dockEngine.dockTaskFromExternalDrag(taskId, 'flow');
        dockedCount++;
      }
      if (dockedCount > 0) {
        const msg = dockedCount === 1
          ? '任务已从流程图拖入停泊坞'
          : `${dockedCount} 个任务已从流程图拖入停泊坞`;
        this.toast.success('已加入停泊坞', msg);
      }
    }

    this.endAltDragToDock();
  }

  /** 结束拖拽到停泊坞，清理所有状态和 DOM */
  private endAltDragToDock(): void {
    this.altDragTaskId = null;
    this.dragToDockTaskIds = [];
    this.isAltDragActive.set(false);

    if (this.altDragGhost) {
      this.altDragGhost.remove();
      this.altDragGhost = null;
    }
    // 防御性清理残留幽灵
    document.querySelectorAll('[data-alt-drag-ghost="true"]').forEach(el => {
      try { el.remove(); } catch { /* 防御性忽略 */ }
    });

    // 清理 drop-zone 上被直接添加的 class
    const dropZone = document.querySelector('[data-testid="dock-v3-drop-zone"]');
    if (dropZone) {
      dropZone.classList.remove('alt-drag-hover');
    }

    if (this.boundAltDragMove) {
      document.removeEventListener('pointermove', this.boundAltDragMove);
      this.boundAltDragMove = null;
    }
    if (this.boundAltDragUp) {
      document.removeEventListener('pointerup', this.boundAltDragUp);
      document.removeEventListener('pointercancel', this.boundAltDragUp);
      this.boundAltDragUp = null;
    }
  }

  /** 使用 DOM API 安全构建幽灵元素内容（避免 innerHTML / XSS） */
  private buildGhostContent(container: HTMLElement, title: string, count: number, suffix?: string): void {
    container.textContent = '';

    const icon = document.createElement('span');
    icon.className = 'opacity-60';
    icon.textContent = '⏸';
    container.appendChild(icon);

    container.appendChild(document.createTextNode(` ${title}`));

    if (count > 1) {
      const badge = document.createElement('span');
      badge.className = 'bg-indigo-400/50 px-1.5 py-0.5 rounded-full text-[10px]';
      badge.textContent = `+${count - 1}`;
      container.appendChild(document.createTextNode(' '));
      container.appendChild(badge);
    }

    if (suffix) {
      const hint = document.createElement('span');
      hint.className = 'ml-1 text-indigo-200 text-[10px]';
      hint.textContent = suffix;
      container.appendChild(hint);
    }
  }

  ngOnDestroy(): void {
    this.endAltDragToDock();
  }
}
