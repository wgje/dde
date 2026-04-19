/**
 * 移动端待办抽屉组件
 * 
 * 顶层抽屉内容：待办事项 + 待分配任务
 * 从 FlowPaletteComponent 中提取移动端专用内容
 */

import { Component, ChangeDetectionStrategy, inject, signal, input, output, effect, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ProjectStateService } from '../../../../services/project-state.service';
import { SyncCoordinatorService } from '../../../../services/sync-coordinator.service';
import { Task } from '../../../../models';
import { 
  SwipeGestureState, 
  SwipeDirection, 
  startSwipeTracking, 
  detectHorizontalSwipe 
} from '../../../../utils/gesture';
import { writeTaskDragPayload } from '../../../../utils/task-drag-payload';

@Component({
  selector: 'app-mobile-todo-drawer',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col h-full"
         (touchstart)="onSwipeTouchStart($event)"
         (touchend)="onSwipeTouchEnd($event)"
         (touchcancel)="onSwipeTouchCancel()">
      <!-- 标题区域（紧靠把手） -->
      <div class="shrink-0 px-4 pt-2 pb-2">
        <h2 class="text-base font-bold text-stone-700 dark:text-stone-200">待办与分配</h2>
      </div>
      
      <!-- 滚动内容区域 -->
      <div class="flex-1 overflow-y-auto overflow-x-hidden px-3 pb-8 flex flex-col gap-3 custom-scrollbar">
        
        <!-- 1. 待办事项 (To-Do) -->
        <div class="flex-none transition-all duration-300 overflow-hidden rounded-xl bg-orange-50/60 dark:bg-stone-800/60 border border-orange-100/50 dark:border-stone-700/50 backdrop-blur-md">
          <div (click)="toggleUnfinishedOpen()" 
               class="px-3 py-2.5 cursor-pointer flex justify-between items-center group select-none hover:bg-orange-100/30 dark:hover:bg-stone-700/30 transition-colors">
            <span class="font-bold text-stone-700 dark:text-stone-100 text-xs flex items-center gap-2">
              <span class="w-1.5 h-1.5 rounded-full bg-orange-500 shadow-[0_0_6px_rgba(249,115,22,0.4)]"></span>
              待办事项
              @if (projectState.unfinishedItems().length > 0) {
                <span class="bg-orange-500/80 text-white text-[9px] px-1.5 py-0.5 rounded-full font-mono">
                  {{ projectState.unfinishedItems().length }}
                </span>
              }
            </span>
            <span class="text-stone-300 dark:text-stone-500 text-[10px] transition-transform duration-300 group-hover:text-stone-500 dark:group-hover:text-stone-400" 
                  [class.rotate-180]="!isUnfinishedOpen()">▼</span>
          </div>
          
          @if (isUnfinishedOpen()) {
            <div class="px-2 pb-2 animate-slide-down">
              <ul class="space-y-1.5">
                @for (item of projectState.unfinishedItems(); track item.taskId + '-' + item.todoIndex) {
                  <li class="text-[11px] text-stone-600 dark:text-stone-300 flex items-center gap-2 bg-white/60 dark:bg-stone-800/80 border border-stone-100/50 dark:border-stone-700/50 p-1.5 rounded-md hover:border-orange-200 dark:hover:border-orange-700 cursor-pointer group shadow-sm transition-all active:scale-95" 
                      (click)="centerOnNode.emit(item.taskId)">
                    <span class="w-1 h-1 rounded-full bg-stone-300 dark:bg-stone-600 group-hover:bg-orange-400 transition-colors shrink-0"></span>
                    <span class="font-mono text-stone-400 dark:text-stone-500 text-[9px] shrink-0">
                      {{ projectState.compressDisplayId(item.taskDisplayId) }}
                    </span>
                    <span class="truncate flex-1 group-hover:text-stone-900 dark:group-hover:text-stone-100 transition-colors leading-tight">
                      {{ item.text }}
                    </span>
                  </li>
                }
                @if (projectState.unfinishedItems().length === 0) {
                  <li class="text-[10px] text-stone-400 dark:text-stone-500 italic px-2 py-1 text-center">空空如也</li>
                }
              </ul>
            </div>
          }
        </div>

        <!-- 2. 待分配区域 (To-Assign) -->
        <div class="flex-none transition-all duration-300 overflow-hidden rounded-xl bg-teal-50/60 dark:bg-stone-800/60 border border-teal-100/50 dark:border-stone-700/50 backdrop-blur-md">
          <div (click)="toggleUnassignedOpen()" 
               class="px-3 py-2.5 cursor-pointer flex justify-between items-center group select-none hover:bg-teal-100/30 dark:hover:bg-stone-700/30 transition-colors">
            <span class="font-bold text-stone-700 dark:text-stone-100 text-xs flex items-center gap-2">
              <span class="w-1.5 h-1.5 rounded-full bg-teal-500 shadow-[0_0_6px_rgba(20,184,166,0.4)]"></span>
              待分配
              @if (projectState.unassignedTasks().length > 0) {
                <span class="bg-teal-500/80 text-white text-[9px] px-1.5 py-0.5 rounded-full font-mono">
                  {{ projectState.unassignedTasks().length }}
                </span>
              }
            </span>
            <span class="text-stone-300 dark:text-stone-500 text-[10px] transition-transform duration-300 group-hover:text-stone-500 dark:group-hover:text-stone-400" 
                  [class.rotate-180]="!isUnassignedOpen()">▼</span>
          </div>

          @if (isUnassignedOpen()) {
            <div class="px-2 pb-2 animate-slide-down">
              <div class="flex flex-wrap gap-1.5" 
                   id="unassignedPalette"
                   (dragover)="onDragOver($event)"
                   (drop)="onDrop($event)">
                @for (task of projectState.unassignedTasks(); track task.id) {
                  <div 
                    [draggable]="nativeHtmlDragEnabled"
                    (dragstart)="onDragStart($event, task)"
                    (touchstart)="onTouchStart($event, task)"
                    (touchmove)="onTouchMove($event)"
                    (touchend)="onTouchEnd($event)"
                    (touchcancel)="onTouchCancel($event)"
                    (click)="onTaskClick(task)"
                    class="w-full px-2 py-1.5 bg-white/60 dark:bg-stone-800/80 border border-stone-200/50 dark:border-stone-600/50 rounded-md text-[11px] font-medium hover:border-teal-300 dark:hover:border-teal-600 hover:text-teal-700 dark:hover:text-teal-300 cursor-grab active:cursor-grabbing shadow-sm transition-all active:scale-95 text-stone-600 dark:text-stone-300 select-none flex items-center gap-2"
                    [class.bg-teal-100]="draggingTaskId() === task.id"
                    [class.dark:bg-teal-800]="draggingTaskId() === task.id"
                    [class.border-teal-400]="draggingTaskId() === task.id">
                    <span class="w-1 h-1 rounded-full bg-teal-300 dark:bg-teal-600 shrink-0"></span>
                    <span class="truncate">{{ task.title }}</span>
                  </div>
                }
                <button 
                  data-testid="create-unassigned-btn" 
                  (click)="createUnassigned.emit()" 
                  class="w-full px-2 py-1.5 bg-stone-100/50 dark:bg-stone-800/50 hover:bg-teal-50 dark:hover:bg-teal-900/30 text-stone-400 dark:text-stone-500 hover:text-teal-600 dark:hover:text-teal-400 rounded-md text-[10px] border border-transparent border-dashed hover:border-teal-300 dark:hover:border-teal-700 transition-all flex items-center justify-center gap-1">
                  <span class="text-base leading-none">+</span> 新建待分配
                </button>
              </div>
              
              <!-- 拖回提示 -->
              @if (isDropTargetActive()) {
                <div class="mt-2 p-3 border-2 border-dashed border-teal-300 dark:border-teal-600 rounded-lg bg-teal-50/50 dark:bg-teal-900/30 text-center text-[10px] text-teal-600 dark:text-teal-400 animate-pulse font-medium">
                  <div class="mb-1 pointer-events-none">📥</div>
                  拖放到此处<br>解除分配
                </div>
              }
            </div>
          }
        </div>
        
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      height: 100%;
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
  private readonly boundGlobalTouchFinish = this.handleGlobalTouchFinish.bind(this);
  private readonly boundGlobalPointerFinish = this.handleGlobalPointerFinish.bind(this);
  readonly nativeHtmlDragEnabled = typeof navigator === 'undefined' ? true : navigator.maxTouchPoints < 1;
  
  // 输入
  readonly isDropTargetActive = input<boolean>(false);
  readonly draggingTaskId = input<string | null>(null);
  
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
  private pendingUnfinishedAutoCollapseRaf: number | null = null;
  private pendingUnassignedAutoCollapseRaf: number | null = null;
  private shouldAutoOpenUnfinishedOnFirstContent = this.projectState.unfinishedItems().length === 0;
  private shouldAutoOpenUnassignedOnFirstContent = this.projectState.unassignedTasks().length === 0;
  private preserveUnfinishedOpenAfterLoading = false;
  private preserveUnassignedOpenAfterLoading = false;

  constructor() {
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

    effect(() => {
      const isLoadingRemote = this.syncCoordinator.isLoadingRemote();
      const currentCount = this.projectState.unassignedTasks().length;

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

    this.zone.runOutsideAngular(() => {
      document.addEventListener('touchend', this.boundGlobalTouchFinish, { capture: true, passive: false });
      document.addEventListener('touchcancel', this.boundGlobalTouchFinish, { capture: true, passive: false });
      document.addEventListener('pointerup', this.boundGlobalPointerFinish, { capture: true });
      document.addEventListener('pointercancel', this.boundGlobalPointerFinish, { capture: true });
    });
  }
  
  // 滑动手势状态（用于视图切换）
  private swipeState: SwipeGestureState = { startX: 0, startY: 0, startTime: 0, isActive: false };
  /** 同一次触摸若起点来自可拖拽卡片，则整次手势都禁止触发抽屉 swipe 切换。 */
  private suppressSwipeForCurrentTouch = false;
  
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
  
  // 触摸事件
  onTouchStart(event: TouchEvent, task: Task): void {
    event.stopPropagation();
    this.suppressSwipeForCurrentTouch = true;
    this.taskTouchStart.emit({ event, task });
  }
  
  onTouchMove(event: TouchEvent): void {
    event.stopPropagation();
    this.taskTouchMove.emit({ event });
  }
  
  onTouchEnd(event: TouchEvent): void {
    event.stopPropagation();
    this.captureDraggedTaskClickGuard();
    this.taskTouchEnd.emit({ event });
    queueMicrotask(() => {
      this.suppressSwipeForCurrentTouch = false;
    });
  }

  onTouchCancel(event: TouchEvent): void {
    event.stopPropagation();
    this.captureDraggedTaskClickGuard();
    this.taskTouchCancel.emit({ event });
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

    this.lastDraggedTaskClickGuard = null;
    this.taskClick.emit(task);
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
    this.zone.runOutsideAngular(() => {
      document.removeEventListener('touchend', this.boundGlobalTouchFinish, { capture: true } as EventListenerOptions);
      document.removeEventListener('touchcancel', this.boundGlobalTouchFinish, { capture: true } as EventListenerOptions);
      document.removeEventListener('pointerup', this.boundGlobalPointerFinish, { capture: true } as EventListenerOptions);
      document.removeEventListener('pointercancel', this.boundGlobalPointerFinish, { capture: true } as EventListenerOptions);
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
      this.swipeToSwitch.emit(direction);
    }
    
    this.resetSwipeState();
  }

  onSwipeTouchCancel(): void {
    this.resetSwipeState();
  }

  private handleGlobalTouchFinish(event: TouchEvent): void {
    if (event.type === 'touchend') {
      this.captureDraggedTaskClickGuard();
    }

    queueMicrotask(() => {
      this.suppressSwipeForCurrentTouch = false;
    });

    if (event.type === 'touchcancel') {
      this.resetSwipeState();
    }
  }

  private handleGlobalPointerFinish(event: PointerEvent): void {
    if (event.pointerType !== 'touch') {
      return;
    }

    if (event.type === 'pointerup') {
      this.captureDraggedTaskClickGuard();
    }

    queueMicrotask(() => {
      this.suppressSwipeForCurrentTouch = false;
    });

    if (event.type === 'pointercancel') {
      this.resetSwipeState();
    }
  }

  private captureDraggedTaskClickGuard(): void {
    const draggingTaskId = this.draggingTaskId();
    if (!draggingTaskId) return;
    this.lastDraggedTaskClickGuard = { taskId: draggingTaskId, at: performance.now() };
  }

  private resetSwipeState(): void {
    this.swipeState = { startX: 0, startY: 0, startTime: 0, isActive: false };
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
