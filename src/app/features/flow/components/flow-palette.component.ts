import { Component, input, output, signal, inject, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { Task } from '../../../../models';
import { BlackBoxPanelComponent } from '../../focus/components/black-box/black-box-panel.component';

/**
 * 流程图顶部调色板组件
 * 包含待办事项和待分配任务区域
 */
@Component({
  selector: 'app-flow-palette',
  standalone: true,
  imports: [CommonModule, BlackBoxPanelComponent],
  styles: [`
    :host {
      position: absolute;
      top: 0;
      left: 0;
      bottom: 0;
      z-index: 40;
      pointer-events: none;
      display: flex;
      flex-direction: row;
    }
  `],
  template: `
    <!-- Sidebar Container -->
    <div class="pointer-events-auto h-full bg-stone-50/80 dark:bg-stone-900/80 backdrop-blur-xl border-r border-stone-200/50 dark:border-stone-800/50 flex flex-col transition-all duration-300 ease-in-out shadow-xl relative"
         [style.width.px]="isOpen() ? 260 : 0"
         [class.border-r-0]="!isOpen()"
         [class.overflow-hidden]="!isOpen()"
         [class.opacity-0]="!isOpen()">
         
        <!-- Scrollable Content -->
        <div class="flex-1 overflow-y-auto overflow-x-hidden p-3 flex flex-col gap-3 custom-scrollbar">
            
            <!-- 1. 待办事项 (To-Do) -->
            <div class="flex-none transition-all duration-300 overflow-hidden rounded-xl bg-orange-50/60 dark:bg-stone-800/60 border border-orange-100/50 dark:border-stone-700/50 backdrop-blur-md">
                <div (click)="uiState.isFlowUnfinishedOpen.set(!uiState.isFlowUnfinishedOpen())" 
                     class="px-3 py-2.5 cursor-pointer flex justify-between items-center group select-none hover:bg-orange-100/30 dark:hover:bg-stone-700/30 transition-colors">
                    <span class="font-bold text-stone-700 dark:text-stone-100 text-xs flex items-center gap-2">
                        <span class="w-1.5 h-1.5 rounded-full bg-orange-500 shadow-[0_0_6px_rgba(249,115,22,0.4)]"></span>
                        待办事项
                    </span>
                    <span class="text-stone-300 dark:text-stone-500 text-[10px] transition-transform duration-300 group-hover:text-stone-500 dark:group-hover:text-stone-400" [class.rotate-180]="!uiState.isFlowUnfinishedOpen()">▼</span>
                </div>
                
                @if (uiState.isFlowUnfinishedOpen()) {
                    <div class="px-2 pb-2 animate-slide-down">
                        <ul class="space-y-1.5">
                            @for (item of projectState.unfinishedItems(); track item.taskId + item.text) {
                                <li class="text-[11px] text-stone-600 dark:text-stone-300 flex items-center gap-2 bg-white/60 dark:bg-stone-800/80 border border-stone-100/50 dark:border-stone-700/50 p-1.5 rounded-md hover:border-orange-200 dark:hover:border-orange-700 cursor-pointer group shadow-sm transition-all active:scale-95" (click)="centerOnNode.emit(item.taskId)">
                                    <span class="w-1 h-1 rounded-full bg-stone-300 dark:bg-stone-600 group-hover:bg-orange-400 transition-colors shrink-0"></span>
                                    <span class="font-mono text-stone-400 dark:text-stone-500 text-[9px] shrink-0">{{projectState.compressDisplayId(item.taskDisplayId)}}</span>
                                    <span class="truncate flex-1 group-hover:text-stone-900 dark:group-hover:text-stone-100 transition-colors leading-tight">{{item.text}}</span>
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
                <div (click)="uiState.isFlowUnassignedOpen.set(!uiState.isFlowUnassignedOpen())" 
                     class="px-3 py-2.5 cursor-pointer flex justify-between items-center group select-none hover:bg-teal-100/30 dark:hover:bg-stone-700/30 transition-colors">
                    <span class="font-bold text-stone-700 dark:text-stone-100 text-xs flex items-center gap-2">
                        <span class="w-1.5 h-1.5 rounded-full bg-teal-500 shadow-[0_0_6px_rgba(20,184,166,0.4)]"></span>
                        待分配
                    </span>
                    <span class="text-stone-300 dark:text-stone-500 text-[10px] transition-transform duration-300 group-hover:text-stone-500 dark:group-hover:text-stone-400" [class.rotate-180]="!uiState.isFlowUnassignedOpen()">▼</span>
                </div>

                @if (uiState.isFlowUnassignedOpen()) {
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
                                    [ngClass]="{
                                      'bg-teal-100 dark:bg-teal-800 border-teal-400': draggingId() === task.id
                                    }">
                                    <span class="w-1 h-1 rounded-full bg-teal-300 dark:bg-teal-600 shrink-0"></span>
                                    <span class="truncate">{{task.title}}</span>
                                </div>
                            }
                            <button data-testid="create-unassigned-btn" (click)="createUnassigned.emit()" class="w-full px-2 py-1.5 bg-stone-100/50 dark:bg-stone-800/50 hover:bg-teal-50 dark:hover:bg-teal-900/30 text-stone-400 dark:text-stone-500 hover:text-teal-600 dark:hover:text-teal-400 rounded-md text-[10px] border border-transparent border-dashed hover:border-teal-300 dark:hover:border-teal-700 transition-all flex items-center justify-center gap-1">
                                <span>+</span> 新建待分配
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

            <!-- 3. 黑匣子快速录入 (Quick Capture) -->
            <app-black-box-panel></app-black-box-panel>
            
            <!-- 底部占位，防止内容被遮挡 -->
            <div class="h-4"></div>
        </div>
    </div>

    <!-- Toggle Button (Outside sidebar) -->
    <div class="pointer-events-auto relative z-50 flex flex-col justify-center sm:block sm:pt-4 h-full sm:h-auto">
        <button 
            (click)="toggleSidebar()"
            class="group flex items-center justify-center w-5 h-10 bg-white/90 dark:bg-stone-800/90 backdrop-blur border border-l-0 border-stone-200 dark:border-stone-700 rounded-r-lg shadow-md hover:bg-stone-50 dark:hover:bg-stone-700 hover:w-6 transition-all focus:outline-none"
            [title]="isOpen() ? '收起侧边栏' : '展开侧边栏'"
        >
            <span class="text-[8px] text-stone-400 group-hover:text-stone-600 dark:group-hover:text-stone-300 transform transition-transform duration-300" 
                  [class.rotate-180]="isOpen()">
                ▶
            </span>
        </button>
    </div>
  `
})
export class FlowPaletteComponent implements OnDestroy {
  // P2-1 迁移：直接注入子服务
  readonly uiState = inject(UiStateService);
  readonly projectState = inject(ProjectStateService);
  
  // 输入
  readonly height = input<number>(200);
  readonly isDropTargetActive = input<boolean>(false);
  
  // 输出事件
  readonly heightChange = output<number>();
  readonly centerOnNode = output<string>();
  readonly createUnassigned = output<void>();
  readonly taskClick = output<Task>();
  readonly taskDragStart = output<{ event: DragEvent; task: Task }>();
  readonly taskDrop = output<{ event: DragEvent }>();
  readonly taskTouchStart = output<{ event: TouchEvent; task: Task }>();
  readonly taskTouchMove = output<{ event: TouchEvent }>();
  readonly taskTouchEnd = output<{ event: TouchEvent }>();
  
  // 手势滑动事件
  readonly swipeToText = output<void>();      // 向右滑动切换到文本视图
  readonly swipeToSidebar = output<void>();   // 向左滑动打开侧边栏
  
  // 内部状态
  readonly draggingId = signal<string | null>(null);
  readonly isOpen = signal<boolean>(true);

  // 与 FlowToolbar 保持一致，但侧边栏默认展开
  readonly isOpenChange = output<boolean>();

  toggleSidebar() {
    this.isOpen.set(!this.isOpen());
    this.isOpenChange.emit(this.isOpen());
  }
  
  // 组件销毁状态
  private isDestroyed = false;
  
  // 触摸拖动状态
  private touchState = {
    task: null as Task | null,
    startX: 0,
    startY: 0,
    isDragging: false,
    longPressTimer: null as ReturnType<typeof setTimeout> | null,
    ghost: null as HTMLElement | null
  };
  
  /**
   * 组件销毁时清理所有资源
   */
  ngOnDestroy() {
    this.isDestroyed = true;
    
    // 清理长按定时器
    if (this.touchState.longPressTimer) {
      clearTimeout(this.touchState.longPressTimer);
      this.touchState.longPressTimer = null;
    }
    
    // 清理幽灵元素
    if (this.touchState.ghost) {
      this.touchState.ghost.remove();
      this.touchState.ghost = null;
    }

  }
  
  // 拖动事件
  onDragStart(event: DragEvent, task: Task) {
    if (event.dataTransfer) {
      event.dataTransfer.setData("text", JSON.stringify(task));
      event.dataTransfer.setData("application/json", JSON.stringify(task));
      event.dataTransfer.effectAllowed = "move";
    }
    this.taskDragStart.emit({ event, task });
  }
  
  onDragOver(event: DragEvent) {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  }
  
  onDrop(event: DragEvent) {
    event.preventDefault();
    this.taskDrop.emit({ event });
  }
  
  // 触摸事件
  onTouchStart(event: TouchEvent, task: Task) {
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
  
  onTouchMove(event: TouchEvent) {
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
      event.preventDefault();
      event.stopPropagation();
      
      // 更新幽灵元素位置
      if (this.touchState.ghost) {
        this.touchState.ghost.style.left = `${touch.clientX - 40}px`;
        this.touchState.ghost.style.top = `${touch.clientY - 20}px`;
      }
    }
    
    this.taskTouchMove.emit({ event });
  }
  
  onTouchEnd(event: TouchEvent) {
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
  
  private createGhost(task: Task, x: number, y: number) {
    const ghost = document.createElement('div');
    ghost.className = 'fixed z-[9999] px-3 py-2 bg-teal-500/90 text-white rounded-lg shadow-xl text-xs font-medium pointer-events-none whitespace-nowrap';
    ghost.textContent = task.title || '未命名';
    ghost.style.left = `${x - 40}px`;
    ghost.style.top = `${y - 20}px`;
    document.body.appendChild(ghost);
    this.touchState.ghost = ghost;
  }
  }