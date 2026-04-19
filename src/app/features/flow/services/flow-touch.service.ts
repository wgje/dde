import { Injectable, inject, signal, NgZone } from '@angular/core';
import { LoggerService } from '../../../../services/logger.service';
import { FlowDragDropService, InsertPositionInfo } from './flow-drag-drop.service';
import { Task } from '../../../../models';
import { UnassignedTouchState, createInitialUnassignedTouchState } from '../../../../models/flow-view-state';
import { TIMEOUT_CONFIG, UI_CONFIG } from '../../../../config';
import * as go from 'gojs';

const POINTER_FALLBACK_GRACE_MS = TIMEOUT_CONFIG.QUICK;

/**
 * 触摸拖放回调
 */
export interface TouchDropCallback {
  (task: Task, position: InsertPositionInfo, docPoint: go.Point): void;
}

/**
 * FlowTouchService - 移动端触摸处理服务
 * 
 * 职责：
 * - 移动端触摸拖放（长按开始拖动）
 * - 幽灵元素管理
 * - 触摸事件节流
 * 
 * 设计原则：
 * - 封装所有触摸相关逻辑
 * - 管理触摸状态机
 * - 正确处理 NgZone
 */
@Injectable({
  providedIn: 'root'
})
export class FlowTouchService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowTouch');
  private readonly zone = inject(NgZone);
  private readonly dragDropService = inject(FlowDragDropService);
  private activeInteractionType: 'touch' | 'pointer' | null = null;
  
  // ========== 状态 ==========
  
  /** 当前正在拖动的待分配任务ID */
  readonly draggingId = signal<string | null>(null);
  /** 待分配移动端拖拽会话是否存在（含长按前预备态）。 */
  readonly hasActiveSession = signal(false);
  
  /** 触摸状态 */
  private touchState: UnassignedTouchState = createInitialUnassignedTouchState();
  /** 最近一次有效触点位置，用于 touchcancel / 丢失 touchend 兜底。 */
  private lastTouchClientX = 0;
  private lastTouchClientY = 0;
  /** 当前被追踪的触点 ID，避免多指场景下用错 changedTouches。 */
  private activeTouchId: number | null = null;
  /** Pointer 驱动拖拽时追踪的主指针 ID。 */
  private activePointerId: number | null = null;
  /** Pointer 驱动拖拽时的 capture 源元素，结束时释放。 */
  private pointerCaptureElement: HTMLElement | null = null;
  /** touchcancel 后等待 pointerup/pointercancel 兜底的短暂窗口。 */
  private pendingPointerFallbackCleanup: ReturnType<typeof setTimeout> | null = null;
  /** 进入 pointer fallback 后，由 pointermove 继续维持拖拽会话。 */
  private awaitingPointerFallback = false;

  // ========== 流程图节点拖拽幽灵（移动端） ==========

  /** 当前正在拖动的流程图节点任务ID（仅用于移动端视觉反馈） */
  private diagramDraggingTaskId: string | null = null;

  /** 流程图节点拖拽的幽灵元素（与待分配长按拖拽的 ghost 分离，互不干扰） */
  private diagramDragGhost: HTMLElement | null = null;
  
  /** 销毁标志 */
  private isDestroyed = false;
  
  /** 活动的全局事件监听器（用于清理） */
  private activeListeners: Array<{
    type: string;
    handler: EventListener;
    options?: boolean | AddEventListenerOptions;
  }> = [];
  
  // ========== 公开方法 ==========
  
  /**
   * 触摸开始（待分配块）
   * @param event 触摸事件
   * @param task 被触摸的任务
   */
  startTouch(event: TouchEvent, task: Task): void {
    if (event.touches.length !== 1 || this.isDestroyed) return;

    this.cleanup();

    const touch = event.touches[0];
    this.beginInteraction(task, touch.clientX, touch.clientY, 'touch');
    this.activeTouchId = touch.identifier ?? null;
  }

  /**
   * Pointer 驱动的移动端待分配拖拽入口。
   * 解决手指移出源卡片后 touch 流丢失、source DOM 被提前卸载的问题。
   */
  startPointer(event: PointerEvent, task: Task): boolean {
    if (event.pointerType !== 'touch' || !event.isPrimary || this.isDestroyed) {
      return false;
    }

    this.cleanup();
    this.beginInteraction(task, event.clientX, event.clientY, 'pointer');
    this.activePointerId = event.pointerId;

    const sourceElement = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    if (sourceElement) {
      try {
        sourceElement.setPointerCapture(event.pointerId);
        this.pointerCaptureElement = sourceElement;
      } catch {
        this.pointerCaptureElement = null;
      }
    }

    return true;
  }
  
  /**
   * 触摸移动
   * @param event 触摸事件
   * @returns 是否应该阻止默认行为
   */
  handleTouchMove(event: TouchEvent): boolean {
    if (this.activeInteractionType !== 'touch') return false;
    if (!this.touchState.task || event.touches.length < 1) return false;
    
    const touch = this.findTrackedTouch(event.touches);
    if (!touch) return false;
    return this.handleTrackedMove(touch.clientX, touch.clientY);
  }

  /**
   * Pointer 驱动会话的全局 move 处理。
   */
  handlePointerMove(event: PointerEvent): boolean {
    if (!this.isPointerSessionActive) return false;
    if (event.pointerType !== 'touch' || !event.isPrimary) return false;
    if (this.activePointerId !== null && event.pointerId !== this.activePointerId) return false;

    return this.handleTrackedMove(event.clientX, event.clientY);
  }
  
  /**
   * 触摸结束
   * @param event 触摸事件
   * @param diagramDiv 流程图容器元素
   * @param diagram GoJS Diagram 实例
   * @param callback 拖放结果回调
   */
  endTouch(
    event: TouchEvent,
    diagramDiv: HTMLElement | null,
    diagram: go.Diagram | null,
    callback: TouchDropCallback
  ): void {
    if (this.activeInteractionType !== 'touch') {
      return;
    }

    if (event.type === 'touchcancel') {
      this.cancelTouch(diagramDiv, diagram, callback);
      return;
    }

    const touch = this.findTrackedTouch(event.changedTouches);
    if (!touch && this.activeTouchId !== null) {
      return;
    }
    this.finishTouch(
      diagramDiv,
      diagram,
      callback,
      touch?.clientX,
      touch?.clientY,
    );
  }

  /** 使用显式坐标完成拖拽收口（pointerup 兜底）。 */
  endTouchAtPosition(
    diagramDiv: HTMLElement | null,
    diagram: go.Diagram | null,
    callback: TouchDropCallback,
    clientX: number,
    clientY: number,
  ): void {
    this.finishTouch(diagramDiv, diagram, callback, clientX, clientY);
  }

  /** Pointer 驱动会话在全局 pointerup 时完成 drop。 */
  endPointer(
    event: PointerEvent,
    diagramDiv: HTMLElement | null,
    diagram: go.Diagram | null,
    callback: TouchDropCallback,
  ): void {
    if (!this.isPointerSessionActive) {
      return;
    }
    if (event.pointerType !== 'touch' || !event.isPrimary) {
      return;
    }
    if (this.activePointerId !== null && event.pointerId !== this.activePointerId) {
      return;
    }

    this.finishTouch(diagramDiv, diagram, callback, event.clientX, event.clientY);
  }

  /** 使用最后一次已知坐标完成拖拽收口。 */
  endTouchFromLastPosition(
    diagramDiv: HTMLElement | null,
    diagram: go.Diagram | null,
    callback: TouchDropCallback,
  ): void {
    this.finishTouch(diagramDiv, diagram, callback, this.lastTouchClientX, this.lastTouchClientY);
  }

  /** cancel 只在刚刚发生过有效拖动时恢复 drop，否则只做清理。 */
  cancelTouch(
    diagramDiv: HTMLElement | null,
    diagram: go.Diagram | null,
    callback: TouchDropCallback,
  ): void {
    void diagramDiv;
    void diagram;
    void callback;
    this.cleanup();
  }

  /** Pointer 驱动会话的取消分支。 */
  cancelPointer(
    diagramDiv: HTMLElement | null,
    diagram: go.Diagram | null,
    callback: TouchDropCallback,
  ): void {
    void diagramDiv;
    void diagram;
    void callback;

    if (!this.isPointerSessionActive) {
      return;
    }

    this.cleanup();
  }

  /**
   * 某些移动端浏览器在手指拖出源区域时会先发 touchcancel，再补 pointerup。
   * 拖拽中遇到该场景时先保留会话，等待 pointer 兜底完成真正 drop。
   */
  deferCancelForPointerFallback(): boolean {
    if (this.activeInteractionType !== 'touch') {
      return false;
    }
    if (!this.touchState.task || !this.touchState.isDragging) {
      return false;
    }

    this.awaitingPointerFallback = true;
    this.armPointerFallbackCleanup();

    return true;
  }

  /**
   * touchcancel 后继续通过 pointermove 更新拖拽预览与坐标。
   * 只在 fallback 窗口中生效，避免和正常 touchmove 双重驱动。
   */
  handlePointerFallbackMove(clientX: number, clientY: number): boolean {
    if (this.activeInteractionType !== 'touch') {
      return false;
    }
    if (!this.awaitingPointerFallback || !this.touchState.task || !this.touchState.isDragging) {
      return false;
    }

    this.lastTouchClientX = clientX;
    this.lastTouchClientY = clientY;

    if (this.touchState.ghost) {
      this.touchState.ghost.style.left = `${clientX - 40}px`;
      this.touchState.ghost.style.top = `${clientY - 20}px`;
    }

    this.armPointerFallbackCleanup();
    return true;
  }

  get hasActiveTouchSession(): boolean {
    return this.hasActiveSession();
  }

  get isTouchDragging(): boolean {
    return this.touchState.isDragging;
  }

  get isPointerSessionActive(): boolean {
    return this.activeInteractionType === 'pointer';
  }

  get isAwaitingPointerFallback(): boolean {
    return this.awaitingPointerFallback;
  }

  private finishTouch(
    diagramDiv: HTMLElement | null,
    diagram: go.Diagram | null,
    callback: TouchDropCallback,
    clientX?: number,
    clientY?: number,
  ): void {
    if (this.touchState.longPressTimer) {
      clearTimeout(this.touchState.longPressTimer);
    }
    
    const { task, isDragging } = this.touchState;
    const resolvedClientX = clientX ?? this.lastTouchClientX;
    const resolvedClientY = clientY ?? this.lastTouchClientY;
    
    if (task && isDragging && diagram && diagramDiv) {
      const diagramRect = diagramDiv.getBoundingClientRect();
      
      // 检查是否在流程图区域内
      if (resolvedClientX >= diagramRect.left && resolvedClientX <= diagramRect.right &&
          resolvedClientY >= diagramRect.top && resolvedClientY <= diagramRect.bottom) {
        
        // 转换为流程图坐标
        const x = resolvedClientX - diagramRect.left;
        const y = resolvedClientY - diagramRect.top;
        const pt = new go.Point(x, y);
        const loc = diagram.transformViewToDoc(pt);
        
        // 查找插入位置
        const insertInfo = this.dragDropService.findInsertPosition(loc, diagram);
        
        this.zone.run(() => {
          callback(task, insertInfo, loc);
        });
      }
    }
    
    this.cleanup();
  }
  
  /**
   * 清理状态
   */
  cleanup(): void {
    const pointerCaptureElement = this.pointerCaptureElement;
    const activePointerId = this.activePointerId;

    if (this.touchState.longPressTimer) {
      clearTimeout(this.touchState.longPressTimer);
    }
    if (this.pendingPointerFallbackCleanup) {
      clearTimeout(this.pendingPointerFallbackCleanup);
      this.pendingPointerFallbackCleanup = null;
    }
    this.removeGhostElement();
    this.hasActiveSession.set(false);
    this.draggingId.set(null);
    this.awaitingPointerFallback = false;
    this.activeInteractionType = null;
    this.touchState = createInitialUnassignedTouchState();
    this.lastTouchClientX = 0;
    this.lastTouchClientY = 0;
    this.activeTouchId = null;
    this.activePointerId = null;
    this.pointerCaptureElement = null;

    if (pointerCaptureElement && activePointerId !== null) {
      try {
        if (pointerCaptureElement.hasPointerCapture(activePointerId)) {
          pointerCaptureElement.releasePointerCapture(activePointerId);
        }
      } catch {
        // capture 在元素已卸载或浏览器不支持时安全忽略
      }
    }
  }
  
  /**
   * 标记为已销毁并清理所有资源
   */
  dispose(): void {
    this.isDestroyed = true;
    this.cleanup();
    this.endDiagramNodeDragGhost();
    this.removeAllGlobalListeners();
  }
  
  /**
   * 重置销毁标志（重新激活）
   */
  activate(): void {
    this.isDestroyed = false;
  }

  // ========== 流程图节点拖拽幽灵（移动端） ==========

  /**
   * 开始显示流程图节点拖拽幽灵
   * 说明：GoJS 在移动端拖拽时，节点可能被手指遮挡；该幽灵用于提供明确的“拖拽中”反馈。
   */
  startDiagramNodeDragGhost(task: Task, clientX: number, clientY: number): void {
    if (this.isDestroyed) return;

    // 如果同一个任务已经在显示幽灵，只更新位置
    if (this.diagramDraggingTaskId === task.id && this.diagramDragGhost) {
      this.updateDiagramNodeDragGhostPosition(clientX, clientY);
      return;
    }

    this.endDiagramNodeDragGhost();
    this.diagramDraggingTaskId = task.id;

    const ghost = document.createElement('div');
    ghost.setAttribute('data-flow-diagram-drag-ghost', 'true');
    ghost.className = 'fixed z-[9999] px-3 py-2 bg-teal-500/90 text-white rounded-lg shadow-xl text-xs font-medium pointer-events-none whitespace-nowrap';
    ghost.textContent = task.title || '未命名任务';
    document.body.appendChild(ghost);
    this.diagramDragGhost = ghost;

    this.updateDiagramNodeDragGhostPosition(clientX, clientY);
  }

  /** 更新流程图节点拖拽幽灵位置 */
  updateDiagramNodeDragGhostPosition(clientX: number, clientY: number): void {
    if (!this.diagramDragGhost) return;
    // 与待分配幽灵一致：略微偏移，避免被手指遮挡
    this.diagramDragGhost.style.left = `${clientX - 40}px`;
    this.diagramDragGhost.style.top = `${clientY - 20}px`;
  }

  /** 结束流程图节点拖拽幽灵 */
  endDiagramNodeDragGhost(): void {
    this.diagramDraggingTaskId = null;
    if (this.diagramDragGhost) {
      this.diagramDragGhost.remove();
      this.diagramDragGhost = null;
    }

    // 防御性清理（避免异常情况下残留）
    const leftovers = document.querySelectorAll('[data-flow-diagram-drag-ghost="true"]');
    leftovers.forEach(el => {
      try { el.remove(); } catch { /* GoJS 事件/DOM 操作防御性忽略 */ }
    });
  }
  
  // ========== 抽屉拖动相关 ==========
  
  /**
   * 创建抽屉拖动处理器
   * @param onHeightChange 高度变化回调
   * @param onResizingChange 拖动状态变化回调
   * @param getInitialHeight 获取初始高度
   */
  createDrawerResizeHandler(
    onHeightChange: (height: number) => void,
    onResizingChange: (isResizing: boolean) => void,
    getInitialHeight: () => number
  ): {
    startResize: (event: TouchEvent) => void;
    cleanup: () => void;
  } {
    let isResizing = false;
    let startY = 0;
    let startHeight = 0;
    let onMove: ((ev: TouchEvent) => void) | null = null;
    let onEnd: (() => void) | null = null;
    
    const removeListeners = () => {
      if (onMove) {
        window.removeEventListener('touchmove', onMove as EventListener);
        this.untrackListener('touchmove', onMove as EventListener);
      }
      if (onEnd) {
        window.removeEventListener('touchend', onEnd);
        window.removeEventListener('touchcancel', onEnd);
        this.untrackListener('touchend', onEnd);
        this.untrackListener('touchcancel', onEnd);
      }
      onMove = null;
      onEnd = null;
    };
    
    return {
      startResize: (event: TouchEvent) => {
        if (event.touches.length !== 1) return;
        event.preventDefault();
        
        isResizing = true;
        onResizingChange(true);
        startY = event.touches[0].clientY;
        startHeight = getInitialHeight();
        
        onMove = (ev: TouchEvent) => {
          if (!isResizing || ev.touches.length !== 1) return;
          ev.preventDefault();
          
          const deltaY = startY - ev.touches[0].clientY;
          const deltaVh = (deltaY / window.innerHeight) * 100;
          const newHeight = Math.max(15, Math.min(70, startHeight + deltaVh));
          onHeightChange(newHeight);
        };
        
        onEnd = () => {
          isResizing = false;
          onResizingChange(false);
          removeListeners();
        };
        
        window.addEventListener('touchmove', onMove as EventListener, { passive: false });
        window.addEventListener('touchend', onEnd);
        window.addEventListener('touchcancel', onEnd);
        
        // 追踪监听器
        this.trackListener('touchmove', onMove as EventListener, { passive: false });
        this.trackListener('touchend', onEnd);
        this.trackListener('touchcancel', onEnd);
      },
      cleanup: removeListeners
    };
  }
  
  /**
   * 创建调色板拖动处理器
   * @param onHeightChange 高度变化回调
   * @param getInitialHeight 获取初始高度
   */
  createPaletteResizeHandler(
    onHeightChange: (height: number) => void,
    getInitialHeight: () => number
  ): {
    startResize: (event: TouchEvent) => void;
    cleanup: () => void;
  } {
    let isResizing = false;
    let startY = 0;
    let startHeight = 0;
    let onMove: ((ev: TouchEvent) => void) | null = null;
    let onEnd: (() => void) | null = null;
    
    const removeListeners = () => {
      if (onMove) {
        window.removeEventListener('touchmove', onMove as EventListener);
        this.untrackListener('touchmove', onMove as EventListener);
      }
      if (onEnd) {
        window.removeEventListener('touchend', onEnd);
        window.removeEventListener('touchcancel', onEnd);
        this.untrackListener('touchend', onEnd);
        this.untrackListener('touchcancel', onEnd);
      }
      onMove = null;
      onEnd = null;
    };
    
    return {
      startResize: (event: TouchEvent) => {
        if (event.touches.length !== 1) return;
        event.preventDefault();
        
        isResizing = true;
        startY = event.touches[0].clientY;
        startHeight = getInitialHeight();
        
        onMove = (ev: TouchEvent) => {
          if (!isResizing || ev.touches.length !== 1) return;
          ev.preventDefault();
          
          const delta = ev.touches[0].clientY - startY;
          const newHeight = Math.max(80, Math.min(500, startHeight + delta));
          onHeightChange(newHeight);
        };
        
        onEnd = () => {
          isResizing = false;
          removeListeners();
        };
        
        window.addEventListener('touchmove', onMove as EventListener, { passive: false });
        window.addEventListener('touchend', onEnd);
        window.addEventListener('touchcancel', onEnd);
        
        // 追踪监听器
        this.trackListener('touchmove', onMove as EventListener, { passive: false });
        this.trackListener('touchend', onEnd);
        this.trackListener('touchcancel', onEnd);
      },
      cleanup: removeListeners
    };
  }
  
  // ========== 私有方法 ==========
  
  /**
   * 创建幽灵元素
   */
  private createGhostElement(task: Task, x: number, y: number): void {
    const ghost = document.createElement('div');
    ghost.className = 'fixed z-[9999] px-3 py-2 bg-teal-500/90 text-white rounded-lg shadow-xl text-xs font-medium pointer-events-none whitespace-nowrap';
    ghost.textContent = task.title || '未命名';
    ghost.style.left = `${x - 40}px`;
    ghost.style.top = `${y - 20}px`;
    document.body.appendChild(ghost);
    this.touchState.ghost = ghost;
  }

  private beginInteraction(
    task: Task,
    clientX: number,
    clientY: number,
    interactionType: 'touch' | 'pointer',
  ): void {
    this.activeInteractionType = interactionType;
    this.hasActiveSession.set(true);
    this.recordPointerLikeActivity(clientX, clientY);
    this.touchState = {
      task,
      startX: clientX,
      startY: clientY,
      isDragging: false,
      longPressTimer: null,
      ghost: null,
    };

    this.touchState.longPressTimer = setTimeout(() => {
      if (this.isDestroyed || !this.touchState.task || this.touchState.task.id !== task.id) return;

      this.touchState.isDragging = true;
      this.draggingId.set(task.id);
      this.createGhostElement(task, this.lastTouchClientX || clientX, this.lastTouchClientY || clientY);
      navigator.vibrate?.(50);
    }, UI_CONFIG.MOBILE_LONG_PRESS_DELAY);
  }

  private handleTrackedMove(clientX: number, clientY: number): boolean {
    if (!this.touchState.task) return false;

    this.recordPointerLikeActivity(clientX, clientY);
    const deltaX = Math.abs(clientX - this.touchState.startX);
    const deltaY = Math.abs(clientY - this.touchState.startY);

    if (!this.touchState.isDragging && (deltaX > 15 || deltaY > 15)) {
      if (this.touchState.longPressTimer) {
        clearTimeout(this.touchState.longPressTimer);
        this.touchState.longPressTimer = null;
      }
      return false;
    }

    if (!this.touchState.isDragging) {
      return false;
    }

    if (this.touchState.ghost) {
      this.touchState.ghost.style.left = `${clientX - 40}px`;
      this.touchState.ghost.style.top = `${clientY - 20}px`;
    }
    return true;
  }

  private findTrackedTouch(touches: ArrayLike<Touch> | null | undefined): Touch | null {
    if (!touches || touches.length === 0) return null;
    if (this.activeTouchId === null) {
      return touches[0] ?? null;
    }
    for (let index = 0; index < touches.length; index += 1) {
      const touch = touches[index];
      if (touch?.identifier === this.activeTouchId) {
        return touch;
      }
    }
    return null;
  }

  private recordTouchActivity(touch: Touch): void {
    this.recordPointerLikeActivity(touch.clientX, touch.clientY);
  }

  private recordPointerLikeActivity(clientX: number, clientY: number): void {
    this.lastTouchClientX = clientX;
    this.lastTouchClientY = clientY;
  }

  private armPointerFallbackCleanup(): void {
    if (this.pendingPointerFallbackCleanup) {
      clearTimeout(this.pendingPointerFallbackCleanup);
    }

    this.pendingPointerFallbackCleanup = setTimeout(() => {
      this.pendingPointerFallbackCleanup = null;
      this.cleanup();
    }, POINTER_FALLBACK_GRACE_MS);
  }
  
  /**
   * 移除幽灵元素
   */
  private removeGhostElement(): void {
    if (this.touchState.ghost) {
      this.touchState.ghost.remove();
      this.touchState.ghost = null;
    }
  }
  
  /**
   * 追踪全局事件监听器
   */
  private trackListener(type: string, handler: EventListener, options?: boolean | AddEventListenerOptions): void {
    this.activeListeners.push({ type, handler, options });
  }
  
  /**
   * 取消追踪监听器
   */
  private untrackListener(type: string, handler: EventListener): void {
    const index = this.activeListeners.findIndex(l => l.type === type && l.handler === handler);
    if (index > -1) {
      this.activeListeners.splice(index, 1);
    }
  }
  
  /**
   * 移除所有活动的全局监听器
   */
  private removeAllGlobalListeners(): void {
    for (const listener of this.activeListeners) {
      window.removeEventListener(listener.type, listener.handler);
    }
    this.activeListeners = [];
  }

  // ========== GoJS SelectionMoved 幽灵清理监听 ==========

  /** 缓存监听器引用，以便移除 */
  private diagramSelectionMovedListener: ((e: go.DiagramEvent) => void) | null = null;

  /**
   * 安装 GoJS SelectionMoved 监听器，在移动端拖拽结束时清理幽灵元素
   * @param diagramInstance GoJS Diagram 实例
   * @param isMobile 是否为移动端
   */
  installDiagramDragGhostListeners(diagramInstance: go.Diagram | null, isMobile: boolean): void {
    if (!isMobile || !diagramInstance) return;
    if (this.diagramSelectionMovedListener) return;

    this.diagramSelectionMovedListener = () => {
      if (!isMobile) return;
      this.endDiagramNodeDragGhost();
    };
    diagramInstance.addDiagramListener('SelectionMoved', this.diagramSelectionMovedListener);
  }

  /**
   * 卸载 GoJS SelectionMoved 监听器
   */
  uninstallDiagramDragGhostListeners(diagramInstance: go.Diagram | null): void {
    if (!diagramInstance || !this.diagramSelectionMovedListener) return;
    try {
      diagramInstance.removeDiagramListener('SelectionMoved', this.diagramSelectionMovedListener);
    } catch {
      // 忽略图表已销毁时的错误
    }
    this.diagramSelectionMovedListener = null;
  }
}
