/**
 * 移动端待办抽屉组件
 *
 * 顶层抽屉内容：待办事项 + 待分配任务
 * 从 FlowPaletteComponent 中提取移动端专用内容
 */

import { Component, ChangeDetectionStrategy, computed, inject, signal, input, output, effect, OnDestroy, NgZone, viewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ProjectStateService, type ActiveProjectOwner } from '../../../../services/project-state.service';
import { SyncCoordinatorService } from '../../../../services/sync-coordinator.service';
import { Task } from '../../../../models';
import { UI_CONFIG } from '../../../../config/ui.config';
import {
  SwipeGestureState,
  SwipeDirection,
  startSwipeTracking,
  detectHorizontalSwipe
} from '../../../../utils/gesture';
import { writeTaskDragPayload } from '../../../../utils/task-drag-payload';

const TOUCH_TAP_SLOP_PX = 10;
const TOUCH_SCROLL_ACTIVATION_PX = 15;

type GlobalFinishListenerRegistration = {
  type: 'touchend' | 'touchcancel' | 'pointerup' | 'pointercancel';
  listener: EventListener;
  addOptions: AddEventListenerOptions;
  removeOptions: EventListenerOptions;
};

@Component({
  selector: 'app-mobile-todo-drawer',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './mobile-todo-drawer.component.html',
  styles: [`
    :host {
      display: block;
      height: 100%;
    }

    /*
     * 移动端待分配块必须独占 touch 手势：
     * - touch-action: none 阻止 Android Chrome 的 scroll/pan/长按 callout 仲裁，
     *   避免长按 250ms 刚触发拖拽就被系统发来的 touchcancel 撕掉。
     * - -webkit-touch-callout/-webkit-user-drag 关闭 iOS Safari 的 link preview、
     *   原生选择菜单与系统拖拽，防止长按后立即弹出选择/预览使 chip 从手指下消失。
     * - overscroll-behavior 避免拖动过程中被抽屉的滚动惯性接管。
     */
    .unassigned-chip {
      touch-action: none;
      -webkit-touch-callout: none;
      -webkit-user-drag: none;
      -webkit-tap-highlight-color: transparent;
      overscroll-behavior: contain;
    }

    .animate-slide-down {
      animation: slide-down 0.2s ease-out;
    }

    @keyframes slide-down {
      from {
        opacity: 0;
        transform: translateY(-10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
  `]
})
export class MobileTodoDrawerComponent implements OnDestroy {
  readonly projectState = inject(ProjectStateService);
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private readonly zone = inject(NgZone);
  private readonly scrollContainer = viewChild<ElementRef<HTMLElement>>('scrollContainer');
  private readonly boundGlobalTouchFinish = this.handleGlobalTouchFinish.bind(this);
  private readonly boundGlobalPointerFinish = this.handleGlobalPointerFinish.bind(this);
  private readonly globalFinishListenerRegistrations: GlobalFinishListenerRegistration[] = [];
  readonly nativeHtmlDragEnabled = typeof navigator === 'undefined' ? true : navigator.maxTouchPoints < 1;

  // 输入
  readonly isDropTargetActive = input<boolean>(false);
  readonly draggingTaskId = input<string | null>(null);
  readonly hasActiveDragSession = input<boolean>(false);

  // 输出事件
  readonly centerOnNode = output<string>();
  readonly createUnassigned = output<void>();
  readonly taskClick = output<Task>();
  readonly taskDragStart = output<{ event: DragEvent; task: Task }>();
  readonly taskDrop = output<{ event: DragEvent }>();
  readonly taskTouchStart = output<{ event: TouchEvent; task: Task }>();
  readonly taskTouchMove = output<{ event: TouchEvent }>();
  readonly taskTouchEnd = output<{ event: TouchEvent }>();
  readonly taskTouchCancel = output<{ event: TouchEvent }>();
  /** 滑动切换视图事件 */
  readonly swipeToSwitch = output<SwipeDirection>();

  // 内部状态
  readonly isUnfinishedOpen = signal(this.projectState.unfinishedItems().length > 0);
  readonly isUnassignedOpen = signal(this.projectState.unassignedTasks().length > 0);
  private lastUnfinishedCount: number | null = null;
  private lastUnassignedCount: number | null = null;
  private lastDraggedTaskClickGuard: { taskId: string; at: number } | null = null;
  private lastSyntheticTouchTapGuard: { taskId: string; at: number } | null = null;
  private pendingUnfinishedAutoCollapseRaf: number | null = null;
  private pendingUnassignedAutoCollapseRaf: number | null = null;
  private shouldAutoOpenUnfinishedOnFirstContent = this.projectState.unfinishedItems().length === 0;
  private shouldAutoOpenUnassignedOnFirstContent = this.projectState.unassignedTasks().length === 0;
  private preserveUnfinishedOpenAfterLoading = false;
  private preserveUnassignedOpenAfterLoading = false;
  private awaitingParentDragActivation = false;
  private unassignedTouchSession: {
    task: Task;
    owner: ActiveProjectOwner;
    startX: number;
    startY: number;
    startedAt: number;
    scrollTop: number;
    scrolled: boolean;
  } | null = null;
  private readonly unassignedDragSnapshot = signal<readonly Task[] | null>(null);
  readonly displayedUnassignedTasks = computed(() => this.unassignedDragSnapshot() ?? this.projectState.unassignedTasks());

  constructor() {
    this.setupUnfinishedAutoCollapseEffect();
    this.setupUnassignedAutoCollapseEffect();
    this.setupDragSnapshotCleanupEffect();
    this.setupDragActivationEffect();
    this.registerGlobalTouchListeners();
  }

  private setupUnfinishedAutoCollapseEffect(): void {
    // 没有待办/待分配任务时默认折叠；仅在“从有到无”时再次自动收起，避免用户手动展开空状态后被反复打断。
    effect(() => {
      const isLoadingRemote = this.syncCoordinator.isLoadingRemote();
      const currentCount = this.projectState.unfinishedItems().length;

      if (isLoadingRemote) {
        if (this.lastUnfinishedCount === null) {
          this.lastUnfinishedCount = currentCount;
        }
        this.cancelPendingAutoCollapse('unfinished');
        return;
      }

      if (currentCount === 0 && this.lastUnfinishedCount !== 0) {
        if (this.preserveUnfinishedOpenAfterLoading) {
          this.cancelPendingAutoCollapse('unfinished');
          this.lastUnfinishedCount = 0;
          this.preserveUnfinishedOpenAfterLoading = false;
          return;
        }
        this.scheduleAutoCollapse('unfinished');
      } else if (currentCount > 0) {
        this.cancelPendingAutoCollapse('unfinished');
        if (this.shouldAutoOpenUnfinishedOnFirstContent) {
          this.isUnfinishedOpen.set(true);
          this.shouldAutoOpenUnfinishedOnFirstContent = false;
        }
        this.preserveUnfinishedOpenAfterLoading = false;
      }

      this.lastUnfinishedCount = currentCount;
    });
  }

  private setupUnassignedAutoCollapseEffect(): void {
    effect(() => {
      const isLoadingRemote = this.syncCoordinator.isLoadingRemote();
      const currentCount = this.projectState.unassignedTasks().length;

      if (this.unassignedDragSnapshot()) {
        this.cancelPendingAutoCollapse('unassigned');
        return;
      }

      if (isLoadingRemote) {
        if (this.lastUnassignedCount === null) {
          this.lastUnassignedCount = currentCount;
        }
        this.cancelPendingAutoCollapse('unassigned');
        return;
      }

      if (currentCount === 0 && this.lastUnassignedCount !== 0) {
        if (this.preserveUnassignedOpenAfterLoading) {
          this.cancelPendingAutoCollapse('unassigned');
          this.lastUnassignedCount = 0;
          this.preserveUnassignedOpenAfterLoading = false;
          return;
        }
        this.scheduleAutoCollapse('unassigned');
      } else if (currentCount > 0) {
        this.cancelPendingAutoCollapse('unassigned');
        if (this.shouldAutoOpenUnassignedOnFirstContent) {
          this.isUnassignedOpen.set(true);
          this.shouldAutoOpenUnassignedOnFirstContent = false;
        }
        this.preserveUnassignedOpenAfterLoading = false;
      }

      this.lastUnassignedCount = currentCount;
    });
  }

  private setupDragSnapshotCleanupEffect(): void {
    effect(() => {
      const snapshot = this.unassignedDragSnapshot();
      if (!snapshot) {
        return;
      }

      if (this.hasActiveDragSession()) {
        this.awaitingParentDragActivation = false;
        return;
      }

      if (this.awaitingParentDragActivation) {
        return;
      }

      queueMicrotask(() => {
        if (!this.hasActiveDragSession() && !this.draggingTaskId()) {
          this.unassignedDragSnapshot.set(null);
        }
      });
    });
  }

  private setupDragActivationEffect(): void {
    // 长按真正进入拖拽时（draggingTaskId 由 FlowTouchService 在 250ms 长按 timer 中置位），
    // 才锁定 swipe 抑制位与未分配快照：
    // - swipe 抑制位防止拖拽收口时 slot 的 onSwipeTouchEnd 误判为视图切换；
    // - 快照防止 chip 在拖拽期间因 stage 变更从 unassignedTasks() 中消失。
    // 反之，未触发长按的纯横向滑动不会进入这里，slot 的 swipe 检测可以正常工作。
    effect(() => {
      if (!this.draggingTaskId()) {
        return;
      }
      this.suppressSwipeForCurrentTouch = true;
      this.awaitingParentDragActivation = true;
      if (!this.unassignedDragSnapshot()) {
        this.unassignedDragSnapshot.set(this.projectState.unassignedTasks().slice());
      }
      this.cancelPendingAutoCollapse('unassigned');
      this.isUnassignedOpen.set(true);
    });
  }

  private registerGlobalTouchListeners(): void {
    this.zone.runOutsideAngular(() => {
      try {
        for (const registration of this.createGlobalFinishListenerRegistrations()) {
          document.addEventListener(registration.type, registration.listener, registration.addOptions);
          this.globalFinishListenerRegistrations.push(registration);
        }
      } catch {
        this.unregisterGlobalFinishListeners();
      }
    });
  }

  private createGlobalFinishListenerRegistrations(): GlobalFinishListenerRegistration[] {
    return [
      {
        type: 'touchend',
        listener: this.boundGlobalTouchFinish as EventListener,
        addOptions: { capture: true, passive: false },
        removeOptions: { capture: true },
      },
      {
        type: 'touchcancel',
        listener: this.boundGlobalTouchFinish as EventListener,
        addOptions: { capture: true, passive: false },
        removeOptions: { capture: true },
      },
      {
        type: 'pointerup',
        listener: this.boundGlobalPointerFinish as EventListener,
        addOptions: { capture: true },
        removeOptions: { capture: true },
      },
      {
        type: 'pointercancel',
        listener: this.boundGlobalPointerFinish as EventListener,
        addOptions: { capture: true },
        removeOptions: { capture: true },
      },
    ];
  }

  private unregisterGlobalFinishListeners(): void {
    const registrations = this.globalFinishListenerRegistrations.splice(0);
    const retainedRegistrations: GlobalFinishListenerRegistration[] = [];

    for (const registration of registrations) {
      try {
        document.removeEventListener(registration.type, registration.listener, registration.removeOptions);
      } catch {
        retainedRegistrations.push(registration);
      }
    }

    this.globalFinishListenerRegistrations.push(...retainedRegistrations);
  }

  // 滑动手势状态（用于视图切换）
  private swipeState: SwipeGestureState = { startX: 0, startY: 0, startTime: 0, isActive: false };
  /** 同一次触摸若起点来自可拖拽卡片，则整次手势都禁止触发抽屉 swipe 切换。 */
  private suppressSwipeForCurrentTouch = false;
  /** 当前这次触摸的切页手势是否已经被本地或全局兜底消费。 */
  private swipeHandledForCurrentTouch = false;
  /** document 级 touchend/pointerup 兜底切页定时器。 */
  private pendingGlobalSwipeFallbackTimer: ReturnType<typeof setTimeout> | null = null;

  // 拖动事件
  onDragStart(event: DragEvent, task: Task): void {
    if (!this.nativeHtmlDragEnabled) {
      event.preventDefault();
      return;
    }

    if (event.dataTransfer) {
      writeTaskDragPayload(event.dataTransfer, {
        v: 1,
        type: 'task',
        taskId: task.id,
        projectId: this.projectState.activeProjectId(),
        fromProjectId: this.projectState.activeProjectId(),
        source: 'flow',
      });
      event.dataTransfer.effectAllowed = 'move';
    }
    this.taskDragStart.emit({ event, task });
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.taskDrop.emit({ event });
  }

  // chip touch 事件继续冒泡给 slot；只有确认长按拖拽后才抑制 swipe。
  onTouchStart(event: TouchEvent, task: Task): void {
    const touch = event.touches[0];
    this.unassignedTouchSession = {
      task,
      owner: this.projectState.captureActiveProjectOwner(),
      startX: touch?.clientX ?? 0,
      startY: touch?.clientY ?? 0,
      startedAt: performance.now(),
      scrollTop: this.scrollContainer()?.nativeElement.scrollTop ?? 0,
      scrolled: false,
    };
    this.clearPendingGlobalSwipeFallback();
    this.swipeHandledForCurrentTouch = false;

    // 阻止 Android 原生长按（文本选择/callout/链接预览）在 250ms 长按拖拽触发
    // 前后撕裂 touch 流。touch-action:none 已在 CSS 侧关闭系统手势仲裁，这里再
    // 显式阻止默认行为作为二道保险，确保整条 touch 流归 Angular 所有。
    if (event.cancelable) {
      event.preventDefault();
    }
    this.openUnassignedForInteraction();
    this.taskTouchStart.emit({ event, task });
  }

  onTouchMove(event: TouchEvent): void {
    this.updateUnassignedTouchSession(event);
    this.taskTouchMove.emit({ event });
  }

  onTouchEnd(event: TouchEvent, task: Task): void {
    const touchSession = this.unassignedTouchSession;
    const changedTouch = event.changedTouches[0] ?? null;
    const shouldEmitTap = this.shouldEmitTouchTap(changedTouch);
    // chip 本地识别 swipe，避免 Android 已处理 touch 不再冒泡时丢失切页。
    const swipeDirection = this.shouldEmitTouchSwipe(changedTouch);
    this.captureDraggedTaskClickGuard();
    this.taskTouchEnd.emit({ event });
    this.unassignedTouchSession = null;
    queueMicrotask(() => {
      this.suppressSwipeForCurrentTouch = false;
      if (swipeDirection && !this.swipeHandledForCurrentTouch) {
        this.emitSwipeToSwitch(swipeDirection);
        return;
      }
      if (!shouldEmitTap || !touchSession) return;
      this.lastSyntheticTouchTapGuard = { taskId: touchSession.task.id, at: performance.now() };
      if (
        touchSession.task === task
        && this.projectState.isActiveProjectOwnerCurrent(touchSession.owner)
        && this.projectState.unassignedTasks().includes(touchSession.task)
        && !this.draggingTaskId()
      ) {
        this.taskClick.emit(task);
      }
    });
  }

  onTouchCancel(event: TouchEvent): void {
    this.captureDraggedTaskClickGuard();
    this.taskTouchCancel.emit({ event });
    this.unassignedTouchSession = null;
    queueMicrotask(() => {
      this.suppressSwipeForCurrentTouch = false;
    });
  }

  onTaskClick(task: Task): void {
    const now = performance.now();
    if (
      this.lastDraggedTaskClickGuard?.taskId === task.id
      && now - this.lastDraggedTaskClickGuard.at < 500
    ) {
      this.lastDraggedTaskClickGuard = null;
      return;
    }

    if (
      this.lastSyntheticTouchTapGuard?.taskId === task.id
      && now - this.lastSyntheticTouchTapGuard.at < 500
    ) {
      this.lastSyntheticTouchTapGuard = null;
      return;
    }

    this.lastDraggedTaskClickGuard = null;
    this.lastSyntheticTouchTapGuard = null;
    this.taskClick.emit(task);
  }

  /**
   * 阻止 chip 的 contextmenu：长按 250ms 触发拖拽后若仍收到 contextmenu，
   * 系统会弹出选择/保存菜单并中断 touch 流。显式 preventDefault 切断该路径。
   */
  onContextMenu(event: Event): void {
    event.preventDefault();
  }

  toggleUnfinishedOpen(): void {
    const nextOpen = !this.isUnfinishedOpen();
    this.isUnfinishedOpen.set(nextOpen);

    if (!this.syncCoordinator.isLoadingRemote()) {
      if (!nextOpen) {
        this.preserveUnfinishedOpenAfterLoading = false;
      }
      return;
    }

    if (nextOpen && this.projectState.unfinishedItems().length === 0) {
      this.preserveUnfinishedOpenAfterLoading = true;
      return;
    }

    if (!nextOpen) {
      this.preserveUnfinishedOpenAfterLoading = false;
    }
  }

  toggleUnassignedOpen(): void {
    const nextOpen = !this.isUnassignedOpen();
    this.isUnassignedOpen.set(nextOpen);

    if (!this.syncCoordinator.isLoadingRemote()) {
      if (!nextOpen) {
        this.preserveUnassignedOpenAfterLoading = false;
      }
      return;
    }

    if (nextOpen && this.projectState.unassignedTasks().length === 0) {
      this.preserveUnassignedOpenAfterLoading = true;
      return;
    }

    if (!nextOpen) {
      this.preserveUnassignedOpenAfterLoading = false;
    }
  }

  ngOnDestroy(): void {
    this.cancelPendingAutoCollapse('unfinished');
    this.cancelPendingAutoCollapse('unassigned');
    this.clearPendingGlobalSwipeFallback();
    this.zone.runOutsideAngular(() => {
      this.unregisterGlobalFinishListeners();
    });
  }

  // ===============================================
  // 滑动切换视图手势处理
  // ===============================================

  /**
   * 滑动开始 - 在抽屉容器上调用
   * 用于检测水平滑动以切换视图
   */
  onSwipeTouchStart(event: TouchEvent): void {
    // 如果正在拖拽任务，不处理滑动
    if (this.draggingTaskId() || this.suppressSwipeForCurrentTouch) return;
    if (event.touches.length !== 1) return;

    this.clearPendingGlobalSwipeFallback();
    this.swipeHandledForCurrentTouch = false;
    this.swipeState = startSwipeTracking(event.touches[0]);
  }

  /**
   * 滑动结束 - 检测是否触发视图切换
   * 【重要】检测到有效滑动时阻止事件冒泡，避免 app.component 误打开侧边栏
   */
  onSwipeTouchEnd(event: TouchEvent): void {
    // 如果正在拖拽任务，不处理滑动
    if (this.draggingTaskId() || this.suppressSwipeForCurrentTouch || !this.swipeState.isActive) return;

    const touch = event.changedTouches[0];
    const direction = detectHorizontalSwipe(
      this.swipeState,
      touch.clientX,
      touch.clientY
    );

    if (direction) {
      // 阻止事件冒泡，避免 app.component 误判为侧边栏切换手势
      event.stopPropagation();
      this.emitSwipeToSwitch(direction);
      return;
    }

    this.resetSwipeState();
  }

  onSwipeTouchCancel(): void {
    this.resetSwipeState();
  }

  private handleGlobalTouchFinish(event: TouchEvent): void {
    if (event.type === 'touchend') {
      this.captureDraggedTaskClickGuard();
      const touch = event.changedTouches[0] ?? null;
      this.scheduleGlobalSwipeFallback(touch?.clientX ?? null, touch?.clientY ?? null, {
        suppressed: !!this.draggingTaskId() || this.suppressSwipeForCurrentTouch,
      });
    }

    queueMicrotask(() => {
      this.suppressSwipeForCurrentTouch = false;
      this.unassignedTouchSession = null;
      this.finalizeUnassignedDragSession();
    });

    // 中文注释：document 级 touchend 只做兜底收口，不再在 capture 阶段直接清空 swipeState。
    // 这样本地 chip/slot 处理器仍有机会优先消费；若手指已经滑出抽屉导致本地 touchend 丢失，
    // scheduleGlobalSwipeFallback 会在本轮事件结束后补一次统一判定，避免顶部抽屉左右滑动切页失效。
  }

  private handleGlobalPointerFinish(event: PointerEvent): void {
    if (event.pointerType !== 'touch') {
      return;
    }

    if (event.type === 'pointerup') {
      this.captureDraggedTaskClickGuard();
      this.scheduleGlobalSwipeFallback(event.clientX, event.clientY, {
        suppressed: !!this.draggingTaskId() || this.suppressSwipeForCurrentTouch,
      });
    }

    queueMicrotask(() => {
      this.suppressSwipeForCurrentTouch = false;
      this.unassignedTouchSession = null;
      this.finalizeUnassignedDragSession();
    });

    // 同上：pointercancel 不再同步清空 swipeState，避免误杀仍在进行中的滑动手势。
  }

  private captureDraggedTaskClickGuard(): void {
    const draggingTaskId = this.draggingTaskId();
    if (!draggingTaskId) return;
    this.lastDraggedTaskClickGuard = { taskId: draggingTaskId, at: performance.now() };
  }

  private resetSwipeState(): void {
    this.swipeState = { startX: 0, startY: 0, startTime: 0, isActive: false };
  }

  private emitSwipeToSwitch(direction: SwipeDirection): void {
    this.clearPendingGlobalSwipeFallback();
    this.swipeHandledForCurrentTouch = true;
    this.resetSwipeState();
    this.swipeToSwitch.emit(direction);
  }

  private scheduleGlobalSwipeFallback(
    clientX: number | null,
    clientY: number | null,
    options: { suppressed: boolean },
  ): void {
    if (clientX == null || clientY == null || options.suppressed || this.swipeHandledForCurrentTouch || !this.swipeState.isActive) {
      return;
    }

    this.clearPendingGlobalSwipeFallback();
    this.pendingGlobalSwipeFallbackTimer = setTimeout(() => {
      this.pendingGlobalSwipeFallbackTimer = null;
      if (this.swipeHandledForCurrentTouch || !this.swipeState.isActive) {
        return;
      }

      const direction = detectHorizontalSwipe(this.swipeState, clientX, clientY);
      if (!direction) {
        this.resetSwipeState();
        return;
      }

      this.emitSwipeToSwitch(direction);
    }, 0);
  }

  private clearPendingGlobalSwipeFallback(): void {
    if (!this.pendingGlobalSwipeFallbackTimer) {
      return;
    }

    clearTimeout(this.pendingGlobalSwipeFallbackTimer);
    this.pendingGlobalSwipeFallbackTimer = null;
  }

  /**
   * 单纯展开"待分配"区域，作为 chip touchstart 的轻量副作用。
   * 不立即拍快照、不抢占 swipe，确保用户在 chip 上做横向滑动时，slot 的
   * onSwipeTouchEnd 仍能识别为视图切换手势；只有真正进入长按拖拽（draggingTaskId
   * 变成 truthy）后，构造函数中的 effect 才会把快照与 swipe 抑制位一并锁住。
   */
  private openUnassignedForInteraction(): void {
    this.cancelPendingAutoCollapse('unassigned');
    this.isUnassignedOpen.set(true);
  }

  private updateUnassignedTouchSession(event: TouchEvent): void {
    const session = this.unassignedTouchSession;
    const touch = event.touches[0];
    if (!session || !touch || this.draggingTaskId()) {
      return;
    }

    const deltaX = touch.clientX - session.startX;
    const deltaY = touch.clientY - session.startY;
    const absDeltaX = Math.abs(deltaX);
    const absDeltaY = Math.abs(deltaY);

    if (absDeltaY < TOUCH_SCROLL_ACTIVATION_PX || absDeltaY <= absDeltaX) {
      return;
    }

    const scrollHost = this.scrollContainer()?.nativeElement;
    if (!scrollHost) {
      return;
    }

    session.scrolled = true;
    scrollHost.scrollTop = session.scrollTop - deltaY;
  }

  private shouldEmitTouchTap(touch: Touch | null): boolean {
    const session = this.unassignedTouchSession;
    if (!session || session.scrolled || this.draggingTaskId()) {
      return false;
    }

    if (performance.now() - session.startedAt >= UI_CONFIG.MOBILE_LONG_PRESS_DELAY) {
      return false;
    }

    const endX = touch?.clientX ?? session.startX;
    const endY = touch?.clientY ?? session.startY;
    return Math.abs(endX - session.startX) < TOUCH_TAP_SLOP_PX
      && Math.abs(endY - session.startY) < TOUCH_TAP_SLOP_PX;
  }

  /**
   * 在 chip 本地识别横向滑动切换视图手势，使 swipe 不再依赖事件冒泡到 slot。
   * 条件：未触发长按拖拽、未发生垂直滚动、水平位移 ≥ 50px 且为主导方向（≥ 垂直分量 × 1.5）、
   * 手势总时长 < 500ms。与 `src/utils/gesture.ts` 的 DEFAULT_SWIPE_CONFIG 对齐。
   */
  private shouldEmitTouchSwipe(touch: Touch | null): SwipeDirection | null {
    const session = this.unassignedTouchSession;
    if (!session || session.scrolled || this.draggingTaskId() || this.suppressSwipeForCurrentTouch) {
      return null;
    }
    if (!touch) {
      return null;
    }

    const duration = performance.now() - session.startedAt;
    if (duration > 500) {
      return null;
    }

    const deltaX = touch.clientX - session.startX;
    const deltaY = touch.clientY - session.startY;
    const absDeltaX = Math.abs(deltaX);
    const absDeltaY = Math.abs(deltaY);

    if (absDeltaX < 50) {
      return null;
    }
    if (absDeltaX < absDeltaY * 1.5) {
      return null;
    }

    return deltaX > 0 ? 'right' : 'left';
  }

  private finalizeUnassignedDragSession(): void {
    if (this.hasActiveDragSession() || this.draggingTaskId()) {
      return;
    }
    this.awaitingParentDragActivation = false;
    this.unassignedDragSnapshot.set(null);
  }

  private scheduleAutoCollapse(section: 'unfinished' | 'unassigned'): void {
    this.cancelPendingAutoCollapse(section);

    if (typeof window === 'undefined') {
      this.applyAutoCollapse(section);
      return;
    }

    const rafId = window.requestAnimationFrame(() => {
      if (section === 'unfinished') {
        this.pendingUnfinishedAutoCollapseRaf = null;
        if (this.syncCoordinator.isLoadingRemote() || this.projectState.unfinishedItems().length > 0) {
          return;
        }
      } else {
        this.pendingUnassignedAutoCollapseRaf = null;
        if (this.syncCoordinator.isLoadingRemote() || this.projectState.unassignedTasks().length > 0) {
          return;
        }
      }

      this.applyAutoCollapse(section);
    });

    if (section === 'unfinished') {
      this.pendingUnfinishedAutoCollapseRaf = rafId;
      return;
    }

    this.pendingUnassignedAutoCollapseRaf = rafId;
  }

  private cancelPendingAutoCollapse(section: 'unfinished' | 'unassigned'): void {
    if (typeof window === 'undefined') {
      return;
    }

    if (section === 'unfinished' && this.pendingUnfinishedAutoCollapseRaf !== null) {
      window.cancelAnimationFrame(this.pendingUnfinishedAutoCollapseRaf);
      this.pendingUnfinishedAutoCollapseRaf = null;
      return;
    }

    if (section === 'unassigned' && this.pendingUnassignedAutoCollapseRaf !== null) {
      window.cancelAnimationFrame(this.pendingUnassignedAutoCollapseRaf);
      this.pendingUnassignedAutoCollapseRaf = null;
    }
  }

  private applyAutoCollapse(section: 'unfinished' | 'unassigned'): void {
    if (section === 'unfinished') {
      this.isUnfinishedOpen.set(false);
      return;
    }

    this.isUnassignedOpen.set(false);
  }
}
