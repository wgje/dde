import { inject, Injectable, signal } from '@angular/core';
import { Task } from '../../../../models';
import { LoggerService } from '../../../../services/logger.service';
import { TouchDragState, DragExpandState, AutoScrollState, DropTargetInfo, TouchDragGestureMode } from '../components/text-view.types';
import {
  applyAutoScrollAmount,
  applyDragGhostFeedback,
  calculateDragGhostPosition,
  createDragGhostElement,
  createInitialTouchDragState,
  createTouchMoveMetrics,
  getAutoScrollAmount,
  getNestedAutoScrollAmount,
  getNextAutoScrollContainer,
  removeDragGhostElement,
  type TouchMoveMetrics,
} from './text-view-drag-drop.helpers';

interface TouchDragStartOptions {
  gestureMode?: TouchDragGestureMode;
}

/** 拖拽服务：统一管理鼠标/触摸拖拽状态和逻辑 */
@Injectable({ providedIn: 'root' })
export class TextViewDragDropService {
  private readonly logger = inject(LoggerService).category('TextDragDrop');

  /** 当前拖拽的任务ID */
  readonly draggingTaskId = signal<string | null>(null);
  
  /** 当前悬停的阶段 */
  readonly dragOverStage = signal<number | null>(null);
  
  /** 放置目标信息 */
  readonly dropTargetInfo = signal<DropTargetInfo | null>(null);
  
  /** 是否正在进行 DOM 更新（折叠/展开阶段），此时忽略 pointerup/pointercancel */
  private isUpdatingDOM = false;
  private domUpdateTimer: ReturnType<typeof setTimeout> | null = null;

  /** 鼠标拖拽展开状态 */
  private dragExpandState: DragExpandState = {
    previousHoverStage: null,
    expandedDuringDrag: new Set<number>()
  };
  
  /** 触摸拖拽状态 */
  private touchState: TouchDragState = createInitialTouchDragState();
  
  /** 自动滚动状态 */
  private autoScrollState: AutoScrollState = {
    animationId: null,
    scrollContainer: null,
    lastClientY: 0,
    stickyScrollAmount: null,
  };
  
  /** 拖拽来源阶段 */
  private dragSourceStage: number | null = null;

  /** 因拖拽自动折叠的阶段（用于拖拽结束后恢复） */
  private autoCollapsedSourceStage: number | null = null;

  /** dragover 事件处理器绑定 */
  private boundHandleDragAutoScroll = this.handleDragAutoScroll.bind(this);
  
  /** 拖拽激活时间戳 - 用于防止 pointerup 过早触发 */
  private dragActivationTime: number | null = null;

  /**
   * 鼠标拖拽丢失看门狗：拖拽源节点在拖拽中被移除（远端同步删移/项目切换重渲染）时
   * Chrome 不会派发 dragend，document dragover 监听与 rAF 自动滚动会一直滞留。
   * 以 dragover 心跳（活跃拖拽在窗口内每 ~350ms 持续触发）静默 + 源节点缺失双条件自愈，
   * 避免把「拖出窗口」（源节点仍在）误判为拖拽丢失
   */
  private mouseDragWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly MOUSE_DRAG_WATCHDOG_MS = 1500;

  /** 开始鼠标拖拽 */
  startDrag(task: Task) {
    this.draggingTaskId.set(task.id);
    this.setDragSourceStage(task.stage ?? null);
  }
  
  /** 结束拖拽（鼠标和触摸通用），返回拖拽期间临时展开但尚未折叠的阶段 */
  endDrag(): number[] {
    const pendingCollapseStages = Array.from(this.dragExpandState.expandedDuringDrag);

    this.draggingTaskId.set(null);
    this.dragOverStage.set(null);
    this.dropTargetInfo.set(null);
    
    // 清理鼠标拖拽展开状态
    this.dragExpandState.previousHoverStage = null;
    this.dragExpandState.expandedDuringDrag.clear();
    
    // 停止自动滚动
    this.stopAutoScroll();

    this.dragSourceStage = null;

    return pendingCollapseStages;
  }
  
  /** 更新放置目标 */
  updateDropTarget(stageNumber: number, beforeTaskId: string | null) {
    this.dropTargetInfo.set({ stageNumber, beforeTaskId });
  }
  
  /** 处理阶段悬停（返回需要展开/折叠的阶段） */
  handleStageDragOver(stageNumber: number, isCollapsed: boolean): { expand?: number; collapse?: number } {
    const result: { expand?: number; collapse?: number } = {};
    
    // 如果切换到新阶段，需要闭合之前因拖拽而展开的阶段
    const prevStage = this.dragExpandState.previousHoverStage;
    if (prevStage !== null && prevStage !== stageNumber && this.dragExpandState.expandedDuringDrag.has(prevStage)) {
      result.collapse = prevStage;
      this.dragExpandState.expandedDuringDrag.delete(prevStage);
    }
    
    this.dragOverStage.set(stageNumber);
    
    // 只有当阶段是折叠状态时才展开并记录
    if (isCollapsed) {
      result.expand = stageNumber;
      this.dragExpandState.expandedDuringDrag.add(stageNumber);
    }
    
    this.dragExpandState.previousHoverStage = stageNumber;
    
    const dropInfo = this.dropTargetInfo();
    if (!dropInfo || dropInfo.stageNumber !== stageNumber) {
      this.dropTargetInfo.set({ stageNumber, beforeTaskId: null });
    }
    
    return result;
  }
  
  /** 处理阶段离开（返回需要折叠的阶段） */
  handleStageDragLeave(stageNumber: number): number | null {
    this.dragOverStage.set(null);
    
    // 如果这个阶段是因为拖拽而临时展开的，返回它以便折叠
    if (this.dragExpandState.expandedDuringDrag.has(stageNumber)) {
      this.dragExpandState.expandedDuringDrag.delete(stageNumber);
      this.dragExpandState.previousHoverStage = null;
      return stageNumber;
    }
    
    this.dragExpandState.previousHoverStage = null;
    return null;
  }

  /** 普通触摸长按延迟 - 保持滚动优先，降低正文区域误拖概率 */
  private readonly DEFAULT_LONG_PRESS_DELAY = 500;

  /** 显式拖拽抓手延迟 - 用户已明确表达拖拽意图，可更快响应 */
  private readonly HANDLE_LONG_PRESS_DELAY = 180;

  /** 普通触摸移动阈值 */
  private readonly DEFAULT_MOVE_THRESHOLD = 15;

  /** 抓手触摸移动阈值 */
  private readonly HANDLE_MOVE_THRESHOLD = 6;

  /** 普通卡片触摸判定为纵向滚动的斜率阈值 */
  private readonly DEFAULT_VERTICAL_SCROLL_RATIO = 3.5;
  
  /** 长按回调 - 用于通知组件拖拽已开始 */
  private onDragStartCallback: (() => void) | null = null;
  
  /** 开始触摸拖拽准备（长按检测） */
  startTouchDrag(task: Task, touch: Touch, onDragStart: () => void, options: TouchDragStartOptions = {}): void {
    const gestureMode = options.gestureMode ?? 'default';
    this.logger.debug('startTouchDrag', {
      taskId: task?.id?.slice(-4) ?? '?',
      stage: task?.stage,
      gestureMode,
    });
    
    this.resetTouchState();
    
    this.touchState.task = task;
    this.touchState.startX = touch.clientX;
    this.touchState.startY = touch.clientY;
    this.touchState.currentX = touch.clientX;
    this.touchState.currentY = touch.clientY;
    this.touchState.gestureMode = gestureMode;
    this.touchState.originalStage = task.stage ?? null;  // 记录任务原始阶段
    this.onDragStartCallback = onDragStart;

    const longPressDelay = gestureMode === 'handle'
      ? this.HANDLE_LONG_PRESS_DELAY
      : this.DEFAULT_LONG_PRESS_DELAY;
    
    // 使用长按延迟来区分点击和拖拽
    this.touchState.longPressTimer = setTimeout(() => {
      this.logger.debug('Long press fired, task:', !!this.touchState.task);
      if (this.touchState.task) {
        this.activateDrag();
      }
    }, longPressDelay);
  }
  
  /** 激活拖拽状态（长按后或移动距离足够后） */
  private activateDrag(): void {
    this.logger.debug('activateDrag', { isDragging: this.touchState.isDragging, hasTask: !!this.touchState.task });
    
    if (this.touchState.isDragging || !this.touchState.task) {
      this.logger.debug('activateDrag skip');
      return;
    }
    
    this.touchState.isDragging = true;
    // 🔧 记录拖拽激活时间，防止 pointerup 过早触发
    this.dragActivationTime = Date.now();
    this.setDragSourceStage(this.touchState.originalStage);
    this.draggingTaskId.set(this.touchState.task.id);
    
    // 设置 previousHoverStage 为原始阶段，这样离开时可以触发折叠
    this.touchState.previousHoverStage = this.touchState.originalStage;
    if (this.touchState.originalStage !== null) {
      this.dragOverStage.set(this.touchState.originalStage);
    }
    
    this.logger.debug('Creating ghost', { x: this.touchState.currentX, y: this.touchState.currentY });
    
    this.createDragGhost(this.touchState.task, this.touchState.currentX, this.touchState.currentY);
    this.onDragStartCallback?.();
    navigator.vibrate?.(50);
  }
  
  /** 获取拖拽激活时间 */
  getDragActivationTime(): number | null {
    return this.dragActivationTime;
  }
  
  /** touchmove 超时检测器 */
  private moveTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private lastMoveTime: number = 0;
  
  private startMoveTimeoutDetector() {
    this.clearMoveTimeout();
    this.lastMoveTime = Date.now();
    
    // 1.5 秒没有 touchmove 活动，认为用户已经松手但 touchend 丢失
    this.moveTimeoutId = setTimeout(() => {
      const timeSinceLastMove = Date.now() - this.lastMoveTime;
      if (this.touchState.isDragging && this.touchState.task && timeSinceLastMove >= 1300) {
        this.logger.warn('[TouchDrag] Move timeout - no activity for 1.5s, touchend may have been lost');
        // 触发一个自定义事件，让组件处理
        document.dispatchEvent(new CustomEvent('touchDragTimeout', {
          detail: {
            task: this.touchState.task,
            targetStage: this.touchState.targetStage,
            targetBeforeId: this.touchState.targetBeforeId
          }
        }));
      }
    }, 1500); // 1.5 秒没有活动
  }
  
  private clearMoveTimeout() {
    if (this.moveTimeoutId !== null) {
      clearTimeout(this.moveTimeoutId);
      this.moveTimeoutId = null;
    }
  }
  
  /** 处理触摸移动 */
  handleTouchMove(touch: Touch): boolean {
    if (!this.touchState.task) {
      this.logger.debug('handleTouchMove: no task');
      return false;
    }
    
    // 更新当前触摸位置（即使拖拽未激活也要更新，以便激活时使用最新位置）
    this.touchState.currentX = touch.clientX;
    this.touchState.currentY = touch.clientY;
    
    // 如果还没开始拖拽，检查移动距离是否超过阈值
    if (!this.touchState.isDragging && !this.handlePendingTouchMove(touch)) {
      return false;
    }
    
    // 重置超时检测器 - 有活动说明还在正常拖拽
    this.startMoveTimeoutDetector();
    
    if (this.touchState.isDragging) {
      this.updateDragGhostForTouch(touch);
      return true;
    }
    
    return false;
  }

  private handlePendingTouchMove(touch: Touch): boolean {
    const metrics = this.createTouchMoveMetrics(touch);
    this.logger.debug('Move check:', {
      deltaX: metrics.deltaX.toFixed(1),
      deltaY: metrics.deltaY.toFixed(1),
      totalDistance: metrics.totalDistance.toFixed(1),
      isVerticalScroll: metrics.isVerticalScroll,
      threshold: metrics.threshold,
      gestureMode: metrics.gestureMode,
    });

    if (metrics.totalDistance <= metrics.threshold) {
      return false;
    }

    if (metrics.isVerticalScroll) {
      this.cancelLongPress();
      this.resetTouchState();
      return false;
    }

    this.cancelLongPress();
    this.activateDrag();
    return true;
  }

  private createTouchMoveMetrics(touch: Touch): TouchMoveMetrics {
    return createTouchMoveMetrics({
      touch,
      startX: this.touchState.startX,
      startY: this.touchState.startY,
      gestureMode: this.touchState.gestureMode,
      defaultMoveThreshold: this.DEFAULT_MOVE_THRESHOLD,
      handleMoveThreshold: this.HANDLE_MOVE_THRESHOLD,
      defaultVerticalScrollRatio: this.DEFAULT_VERTICAL_SCROLL_RATIO,
    });
  }

  private updateDragGhostForTouch(touch: Touch): void {
    if (!this.touchState.dragGhost) {
      this.logger.warn('Ghost missing during move, recreating at', {
        x: touch.clientX,
        y: touch.clientY
      });
      this.createDragGhost(this.touchState.task!, touch.clientX, touch.clientY);
      return;
    }

    const position = calculateDragGhostPosition({
      x: touch.clientX,
      y: touch.clientY,
      width: 200,
      height: 50,
      margin: 5,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    this.touchState.dragGhost.style.left = `${position.x}px`;
    this.touchState.dragGhost.style.top = `${position.y}px`;
  }
  
  /** 更新触摸目标阶段
   * 仅折叠“拖拽过程中自动展开”的阶段，避免把原本就展开的阶段折叠掉
   */
  /** 切换到新阶段（处理阶段展开/折叠逻辑） */
  switchToStage(stageNumber: number, options?: { autoExpanded?: boolean }): number | null {
    const prevStage = this.touchState.previousHoverStage;
    const autoExpanded = options?.autoExpanded ?? false;
    
    // 检查是否需要折叠之前的阶段
    let stageToCollapse: number | null = null;
    if (
      prevStage !== null &&
      prevStage !== stageNumber &&
      this.touchState.expandedDuringDrag.has(prevStage)
    ) {
      stageToCollapse = prevStage;
    }
    
    // 更新当前阶段
    this.touchState.previousHoverStage = stageNumber;
    this.dragOverStage.set(stageNumber);
    
    if (autoExpanded) {
      this.touchState.expandedDuringDrag.add(stageNumber);
    }
    
    return stageToCollapse;
  }
  
  /** 更新触摸目标位置（只更新任务位置，不改变阶段追踪） */
  updateTouchTarget(stageNumber: number | null, beforeTaskId: string | null, _options?: { autoExpanded?: boolean }): number | null {
    // 只更新任务位置，不修改阶段追踪状态
    if (stageNumber !== null) {
      this.touchState.targetStage = stageNumber;
      this.touchState.targetBeforeId = beforeTaskId;
      this.dropTargetInfo.set({ stageNumber, beforeTaskId });
    } else {
      // ⚠️ 离开所有阶段时的特殊处理
      const prevStage = this.touchState.previousHoverStage;
      let stageToCollapse: number | null = null;
      
      if (prevStage !== null && this.touchState.expandedDuringDrag.has(prevStage)) {
        // 移动端体验：当手指拖到“所有阶段之外”时，不折叠来源阶段。
        // 否则原任务卡会被折叠隐藏，用户会误以为“拖出失败”。
        if (prevStage !== this.dragSourceStage) {
          stageToCollapse = prevStage;
        }
      }
      
      // ⚠️ 不要清除 targetStage 和 targetBeforeId！
      // 保留之前的目标，这样当用户在阶段外松手时，任务仍会移动到最后一个有效目标
      // 只清除视觉状态和 previousHoverStage
      this.touchState.previousHoverStage = null;
      this.dragOverStage.set(null);
      this.dropTargetInfo.set(null);
      
      return stageToCollapse;
    }
    
    return null;
  }

  /** 
   * 更新待分配块目标（用于待分配块间的拖放）
   * @param targetTaskId 目标待分配任务的ID（将成为被拖动任务的新父节点）
   */
  updateUnassignedTarget(targetTaskId: string | null): void {
    this.touchState.targetUnassignedId = targetTaskId;
    // 当进入待分配区域时，清除阶段目标
    if (targetTaskId !== null) {
      this.touchState.targetStage = null;
      this.touchState.targetBeforeId = null;
      this.dragOverStage.set(null);
      this.dropTargetInfo.set(null);
    }
    this.logger.debug('updateUnassignedTarget', { targetTaskId: targetTaskId?.slice(-4) ?? null });
  }

  /** 清除待分配块目标 */
  clearUnassignedTarget(): void {
    this.touchState.targetUnassignedId = null;
  }
  
  /** 结束触摸拖拽，返回目标信息以及需要折叠的阶段 */
  endTouchDrag(): { task: Task | null; targetStage: number | null; targetBeforeId: string | null; targetUnassignedId: string | null; wasDragging: boolean; autoExpandedStages: number[] } {
    this.logger.debug('🟣 endTouchDrag called', {
      hadTask: !!this.touchState.task,
      wasDragging: this.touchState.isDragging,
      hadGhost: !!this.touchState.dragGhost,
      activationTime: this.dragActivationTime,
      elapsed: this.dragActivationTime ? Date.now() - this.dragActivationTime : null,
      targetUnassignedId: this.touchState.targetUnassignedId
    });
    // 取消长按定时器
    // 清除超时检测器
    this.clearMoveTimeout();
    this.cancelLongPress();
    
    // 🔧 清除拖拽激活时间
    this.dragActivationTime = null;
    
    // 停止自动滚动
    this.stopTouchAutoScroll();

    const autoExpandedStages = Array.from(this.touchState.expandedDuringDrag);
    
    const result = {
      task: this.touchState.task,
      targetStage: this.touchState.targetStage,
      targetBeforeId: this.touchState.targetBeforeId,
      targetUnassignedId: this.touchState.targetUnassignedId,
      wasDragging: this.touchState.isDragging,
      autoExpandedStages
    };
    
    // 强制清理幽灵元素（必须在重置状态之前）
    this.removeDragGhost();
    
    // 重置触摸状态
    this.resetTouchState();
    
    // 清理拖拽相关的全局状态
    this.draggingTaskId.set(null);
    this.dragOverStage.set(null);
    this.dropTargetInfo.set(null);
    
    return result;
  }
  
  /** 获取触摸拖拽状态 */
  get isTouchDragging(): boolean {
    return this.touchState.isDragging;
  }
  
  /** 获取触摸拖拽的任务 */
  get touchDragTask(): Task | null {
    return this.touchState.task;
  }
  
  /** 检查是否正在 DOM 更新 */
  get isDOMUpdating(): boolean {
    return this.isUpdatingDOM;
  }
  
  /** 开始 DOM 更新（在折叠/展开阶段前调用） */
  beginDOMUpdate(): void {
    this.clearDOMUpdateTimer();
    this.isUpdatingDOM = true;
    // 100ms 后自动恢复，防止卡住
    // 需要足够时间让 Angular 完成变更检测并让浏览器完成 DOM 更新
    const domUpdateTimer = setTimeout(() => {
      if (this.domUpdateTimer !== domUpdateTimer) return;
      this.domUpdateTimer = null;
      this.isUpdatingDOM = false;
    }, 100);
    this.domUpdateTimer = domUpdateTimer;
  }
  
  /** 结束 DOM 更新 */
  endDOMUpdate(): void {
    this.clearDOMUpdateTimer();
    this.isUpdatingDOM = false;
  }

  private clearDOMUpdateTimer(): void {
    if (this.domUpdateTimer !== null) {
      clearTimeout(this.domUpdateTimer);
      this.domUpdateTimer = null;
    }
  }

  private createDragGhost(task: Task, x: number, y: number) {
    this.removeDragGhost();

    const ghost = createDragGhostElement({
      taskId: task.id,
      title: task.title,
      x,
      y,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      timestamp: Date.now(),
      logger: this.logger,
    });
    this.touchState.dragGhost = ghost;
  }

  /** 更新幽灵元素的视觉反馈（根据是否在有效目标上） */
  updateGhostVisualFeedback(isOverValidTarget: boolean) {
    const ghost = this.touchState.dragGhost;
    if (ghost) {
      applyDragGhostFeedback(ghost, isOverValidTarget);
    }
  }
  
  private removeDragGhost() {
    this.logger.debug('🗑️ removeDragGhost called', {
      hasGhost: !!this.touchState.dragGhost,
      stack: new Error().stack?.split('\n')?.slice(1, 5)?.join(' <- ')
    });
    
    const ghost = this.touchState.dragGhost;
    this.touchState.dragGhost = null;
    removeDragGhostElement({
      ghost,
      getActiveGhostId: () => this.touchState.dragGhost?.id,
      logger: this.logger,
    });
  }

  /** 启动自动滚动 */
  startAutoScroll(container: HTMLElement, clientY: number) {
    document.removeEventListener('dragover', this.boundHandleDragAutoScroll);
    this.autoScrollState.scrollContainer = container;
    this.autoScrollState.lastClientY = clientY;
    this.autoScrollState.stickyScrollAmount = null;
    document.addEventListener('dragover', this.boundHandleDragAutoScroll);
    this.armMouseDragWatchdog();
    this.ensureAutoScrollLoop();
  }

  updateAutoScrollContainer(container: HTMLElement | null, clientY?: number) {
    this.autoScrollState.scrollContainer = container;
    this.autoScrollState.stickyScrollAmount = null;
    if (clientY !== undefined) {
      this.autoScrollState.lastClientY = clientY;
    }
  }
  
  /** 执行触摸自动滚动 */
  performTouchAutoScroll(container: HTMLElement, clientY: number) {
    this.autoScrollState.scrollContainer = container;
    this.autoScrollState.lastClientY = clientY;
    this.autoScrollState.stickyScrollAmount = null;
    this.ensureAutoScrollLoop();
  }

  /** 执行嵌套容器自动滚动（例如阶段内的任务列表） */
  performNestedAutoScroll(nestedContainer: HTMLElement, clientY: number): boolean {
    const rect = nestedContainer.getBoundingClientRect();
    const scrollAmount = getNestedAutoScrollAmount(clientY, rect);

    if (scrollAmount !== 0) {
      nestedContainer.scrollTop += scrollAmount;
      return true; // 已处理滚动
    }

    return false; // 未处理滚动
  }
  
  private handleDragAutoScroll(e: DragEvent) {
    this.autoScrollState.lastClientY = e.clientY;
    // dragover 心跳：拖拽仍存活，重置丢失看门狗
    this.armMouseDragWatchdog();
  }

  private armMouseDragWatchdog(): void {
    this.clearMouseDragWatchdog();
    this.mouseDragWatchdogTimer = setTimeout(() => {
      this.mouseDragWatchdogTimer = null;
      this.checkMouseDragStillAlive();
    }, TextViewDragDropService.MOUSE_DRAG_WATCHDOG_MS);
  }

  private clearMouseDragWatchdog(): void {
    if (this.mouseDragWatchdogTimer !== null) {
      clearTimeout(this.mouseDragWatchdogTimer);
      this.mouseDragWatchdogTimer = null;
    }
  }

  private checkMouseDragStillAlive(): void {
    const draggingTaskId = this.draggingTaskId();
    if (!draggingTaskId || this.touchState.isDragging) {
      return;
    }

    // 源节点仍在 DOM：dragover 静默大概率只是拖出了浏览器窗口（跨窗口拖拽），
    // dragend 之后仍会送达源节点，继续等待而不是误清理
    if (this.isDragSourceElementPresent(draggingTaskId)) {
      this.armMouseDragWatchdog();
      return;
    }

    this.logger.warn('[MouseDrag] 拖拽源节点已被移除且 dragover 静默，dragend 可能已丢失，触发自愈清理', {
      draggingTaskId,
    });
    document.dispatchEvent(new CustomEvent('mouseDragLost'));
  }

  private isDragSourceElementPresent(taskId: string): boolean {
    if (typeof document === 'undefined') {
      return true;
    }

    const escapedId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(taskId)
      : taskId;
    return document.querySelector(`[data-task-id="${escapedId}"], [data-unassigned-task="${escapedId}"]`) !== null;
  }
  
  private ensureAutoScrollLoop() {
    if (this.autoScrollState.animationId) {
      return;
    }
    const step = () => {
      if (!this.shouldContinueAutoScroll()) {
        this.stopAutoScrollLoop(true);
        return;
      }
      this.performAutoScrollStep();
      this.autoScrollState.animationId = requestAnimationFrame(step);
    };
    this.autoScrollState.animationId = requestAnimationFrame(step);
  }
  
  private shouldContinueAutoScroll(): boolean {
    if (!this.autoScrollState.scrollContainer) {
      return false;
    }
    return this.touchState.isDragging || !!this.draggingTaskId();
  }
  
  private performAutoScrollStep() {
    const clientY = this.autoScrollState.lastClientY;
    const initialContainer = this.autoScrollState.scrollContainer;
    let container = initialContainer;
    if (!container) return;

    const scrollAmount = this.autoScrollState.stickyScrollAmount ?? this.getAutoScrollAmount(container, clientY);
    if (scrollAmount === 0) {
      this.autoScrollState.stickyScrollAmount = null;
      return;
    }

    while (container) {
      if (this.applyAutoScrollAmount(container, scrollAmount)) {
        this.autoScrollState.scrollContainer = container;
        this.autoScrollState.stickyScrollAmount = container !== initialContainer || this.autoScrollState.stickyScrollAmount !== null
          ? scrollAmount
          : null;
        return;
      }

      container = this.getNextAutoScrollContainer(container);
    }

    this.autoScrollState.stickyScrollAmount = null;
  }

  private getAutoScrollAmount(container: HTMLElement, clientY: number): number {
    return getAutoScrollAmount(clientY, container.getBoundingClientRect());
  }

  private applyAutoScrollAmount(container: HTMLElement, scrollAmount: number): boolean {
    return applyAutoScrollAmount(container, scrollAmount);
  }

  private getNextAutoScrollContainer(container: HTMLElement): HTMLElement | null {
    return getNextAutoScrollContainer(container);
  }
  
  private stopAutoScroll() {
    document.removeEventListener('dragover', this.boundHandleDragAutoScroll);
    this.clearMouseDragWatchdog();
    this.stopAutoScrollLoop(true);
  }
  
  /** 停止触摸自动滚动 */
  private stopTouchAutoScroll() {
    this.stopAutoScrollLoop(true);
  }
  
  private stopAutoScrollLoop(clearContainer = true) {
    if (this.autoScrollState.animationId) {
      cancelAnimationFrame(this.autoScrollState.animationId);
      this.autoScrollState.animationId = null;
    }
    this.autoScrollState.stickyScrollAmount = null;
    if (clearContainer) {
      this.autoScrollState.scrollContainer = null;
    }
  }

  private cancelLongPress() {
    if (this.touchState.longPressTimer !== null) {
      clearTimeout(this.touchState.longPressTimer);
      this.touchState.longPressTimer = null;
    }
  }
  
  /** 请求在离开来源阶段时折叠它 */
  requestSourceStageCollapse(currentStageNumber: number | null): number | null {
    if (this.dragSourceStage === null) {
      return null;
    }
    // 移动端体验：当拖拽到"阶段外空白区域"时，不折叠来源阶段，保留原位置的半透明占位。
    // 只有真正进入另一个阶段时才折叠来源阶段。
    if (currentStageNumber === null) {
      return null;
    }
    if (currentStageNumber === this.dragSourceStage) {
      return null;
    }
    // 每次都检查是否需要折叠。组件层会检查实际展开状态，避免重复折叠。
    return this.dragSourceStage;
  }

  /** 标记源阶段是由拖拽自动折叠的，方便事后恢复 */
  markSourceStageAutoCollapsed(stageNumber: number) {
    if (this.dragSourceStage === stageNumber) {
      this.autoCollapsedSourceStage = stageNumber;
    }
  }

  /** 读取并清空自动折叠的源阶段 */
  consumeAutoCollapsedSourceStage(): number | null {
    const stage = this.autoCollapsedSourceStage;
    this.autoCollapsedSourceStage = null;
    return stage;
  }

  private resetTouchState() {
    this.logger.debug('🔴 resetTouchState called', {
      hadTask: !!this.touchState.task,
      wasDragging: this.touchState.isDragging,
      hadGhost: !!this.touchState.dragGhost,
      stack: new Error().stack?.split('\n')?.slice(1, 4)?.join('\n')
    });
    this.clearMoveTimeout();
    this.cancelLongPress();
    // 在重置前先确保幽灵元素被清理
    if (this.touchState.dragGhost) {
      this.logger.warn('Ghost still exists during resetTouchState, removing it');
      this.removeDragGhost();
    }
    this.onDragStartCallback = null;
    this.touchState = createInitialTouchDragState();
  }

  private setDragSourceStage(stageNumber: number | null) {
    this.dragSourceStage = stageNumber;
  }
  
  /** 清理所有资源（组件销毁时调用） */
  cleanup() {
    this.endDOMUpdate();
    this.resetTouchState();
    this.removeDragGhost();
    this.stopAutoScroll();
    this.endDrag();
  }
}
