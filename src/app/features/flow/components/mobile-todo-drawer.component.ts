/**
 * 移动端待办抽屉组件
 * 
 * 顶层抽屉内容：待办事项 + 待分配任务
 * 从 FlowPaletteComponent 中提取移动端专用内容
 */

import { Component, ChangeDetectionStrategy, inject, signal, input, output, OnDestroy, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ProjectStateService } from '../../../../services/project-state.service';
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
         (touchend)="onSwipeTouchEnd($event)">
      <!-- 标题区域（紧靠把手） -->
      <div class="shrink-0 px-4 pt-2 pb-2">
        <h2 class="text-base font-bold text-stone-700 dark:text-stone-200">待办与分配</h2>
      </div>
      
      <!-- 滚动内容区域 -->
      <div class="flex-1 overflow-y-auto overflow-x-hidden px-3 pb-8 flex flex-col gap-3 custom-scrollbar">
        
        <!-- 1. 待办事项 (To-Do) -->
        <div class="flex-none transition-all duration-300 overflow-hidden rounded-xl bg-orange-50/60 dark:bg-stone-800/60 border border-orange-100/50 dark:border-stone-700/50 backdrop-blur-md">
          <div (click)="isUnfinishedOpen.set(!isUnfinishedOpen())" 
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
          <div (click)="isUnassignedOpen.set(!isUnassignedOpen())" 
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
                    draggable="true" 
                    (dragstart)="onDragStart($event, task)"
                    (touchstart)="onTouchStart($event, task)"
                    (touchmove)="onTouchMove($event)"
                    (touchend)="onTouchEnd($event)"
                    (click)="taskClick.emit(task)"
                    class="w-full px-2 py-1.5 bg-white/60 dark:bg-stone-800/80 border border-stone-200/50 dark:border-stone-600/50 rounded-md text-[11px] font-medium hover:border-teal-300 dark:hover:border-teal-600 hover:text-teal-700 dark:hover:text-teal-300 cursor-grab active:cursor-grabbing shadow-sm transition-all active:scale-95 text-stone-600 dark:text-stone-300 select-none flex items-center gap-2"
                    [class.bg-teal-100]="draggingId() === task.id"
                    [class.dark:bg-teal-800]="draggingId() === task.id"
                    [class.border-teal-400]="draggingId() === task.id">
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
  
  // 输入
  readonly isDropTargetActive = input<boolean>(false);
  
  // 输出事件
  readonly centerOnNode = output<string>();
  readonly createUnassigned = output<void>();
  readonly taskClick = output<Task>();
  readonly taskDragStart = output<{ event: DragEvent; task: Task }>();
  readonly taskDrop = output<{ event: DragEvent }>();
  readonly taskTouchStart = output<{ event: TouchEvent; task: Task }>();
  readonly taskTouchMove = output<{ event: TouchEvent }>();
  readonly taskTouchEnd = output<{ event: TouchEvent }>();
  /** 滑动切换视图事件 */
  readonly swipeToSwitch = output<SwipeDirection>();
  
  // 内部状态
  readonly isUnfinishedOpen = signal(true);
  readonly isUnassignedOpen = signal(true);
  readonly draggingId = signal<string | null>(null);

  constructor() {
    // 没有待办/待分配任务时自动折叠，减少移动端空白区域
    effect(() => {
      if (this.projectState.unfinishedItems().length === 0) {
        this.isUnfinishedOpen.set(false);
      }
    });
    effect(() => {
      if (this.projectState.unassignedTasks().length === 0) {
        this.isUnassignedOpen.set(false);
      }
    });
  }
  
  // 触摸拖动状态
  private touchState = {
    task: null as Task | null,
    startX: 0,
    startY: 0,
    isDragging: false,
    longPressTimer: null as ReturnType<typeof setTimeout> | null,
    ghost: null as HTMLElement | null
  };
  
  // 滑动手势状态（用于视图切换）
  private swipeState: SwipeGestureState = { startX: 0, startY: 0, startTime: 0, isActive: false };
  
  ngOnDestroy(): void {
    // 清理长按定时器
    if (this.touchState.longPressTimer) {
      clearTimeout(this.touchState.longPressTimer);
    }
    // 清理幽灵元素
    if (this.touchState.ghost) {
      this.touchState.ghost.remove();
    }
  }
  
  // 拖动事件
  onDragStart(event: DragEvent, task: Task): void {
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
    if (event.touches.length !== 1) return;
    
    const touch = event.touches[0];
    this.touchState = {
      task,
      startX: touch.clientX,
      startY: touch.clientY,
      isDragging: false,
      longPressTimer: null,
      ghost: null
    };
    
    // 长按 250ms 后开始拖拽
    this.touchState.longPressTimer = setTimeout(() => {
      this.touchState.isDragging = true;
      this.draggingId.set(task.id);
      this.createGhost(task, touch.clientX, touch.clientY);
      if (navigator.vibrate) navigator.vibrate(50);
    }, 250);
    
    this.taskTouchStart.emit({ event, task });
  }
  
  onTouchMove(event: TouchEvent): void {
    if (!this.touchState.task || event.touches.length !== 1) return;
    
    const touch = event.touches[0];
    const deltaX = Math.abs(touch.clientX - this.touchState.startX);
    const deltaY = Math.abs(touch.clientY - this.touchState.startY);
    
    // 如果移动超过阈值但还没开始拖拽，取消长按
    if (!this.touchState.isDragging && (deltaX > 15 || deltaY > 15)) {
      if (this.touchState.longPressTimer) {
        clearTimeout(this.touchState.longPressTimer);
        this.touchState.longPressTimer = null;
      }
      return;
    }
    
    if (this.touchState.isDragging) {
      // 检查事件是否可取消（避免滚动进行中的 Intervention 警告）
      if (event.cancelable) {
        event.preventDefault();
      }
      event.stopPropagation();
      
      // 更新幽灵元素位置
      if (this.touchState.ghost) {
        this.touchState.ghost.style.left = `${touch.clientX - 40}px`;
        this.touchState.ghost.style.top = `${touch.clientY - 20}px`;
      }
    }
    
    this.taskTouchMove.emit({ event });
  }
  
  onTouchEnd(event: TouchEvent): void {
    if (this.touchState.longPressTimer) {
      clearTimeout(this.touchState.longPressTimer);
    }
    
    // 移除幽灵元素
    if (this.touchState.ghost) {
      this.touchState.ghost.remove();
    }
    
    this.draggingId.set(null);
    this.taskTouchEnd.emit({ event });
    
    this.touchState = {
      task: null, startX: 0, startY: 0, isDragging: false, longPressTimer: null, ghost: null
    };
  }
  
  private createGhost(task: Task, x: number, y: number): void {
    const ghost = document.createElement('div');
    ghost.className = 'fixed z-[9999] px-3 py-2 bg-teal-500/90 text-white rounded-lg shadow-xl text-xs font-medium pointer-events-none whitespace-nowrap';
    ghost.textContent = task.title || '未命名';
    ghost.style.left = `${x - 40}px`;
    ghost.style.top = `${y - 20}px`;
    document.body.appendChild(ghost);
    this.touchState.ghost = ghost;
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
    if (this.touchState.isDragging) return;
    if (event.touches.length !== 1) return;
    
    this.swipeState = startSwipeTracking(event.touches[0]);
  }
  
  /**
   * 滑动结束 - 检测是否触发视图切换
   * 【重要】检测到有效滑动时阻止事件冒泡，避免 app.component 误打开侧边栏
   */
  onSwipeTouchEnd(event: TouchEvent): void {
    // 如果正在拖拽任务，不处理滑动
    if (this.touchState.isDragging || !this.swipeState.isActive) return;
    
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
    
    this.swipeState = { startX: 0, startY: 0, startTime: 0, isActive: false };
  }
}
