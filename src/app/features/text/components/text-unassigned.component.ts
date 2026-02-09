import { Component, inject, Input, Output, EventEmitter, signal, ChangeDetectionStrategy, ChangeDetectorRef, OnDestroy, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { Task } from '../../../../models';
import { renderMarkdownSafe } from '../../../../utils/markdown';

/**
 * 待分配区组件
 * 显示待分配任务列表，支持拖拽和编辑
 */
@Component({
  selector: 'app-text-unassigned',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section 
      class="flex-none transition-all duration-300 overflow-hidden"
      [ngClass]="{'mx-4 mt-2 mb-4 max-h-[1000px]': !isMobile && uiState.isTextSidebarVisible(), 'mx-2 mt-1 mb-2 max-h-[1000px]': isMobile && uiState.isTextSidebarVisible(), 'max-h-0 opacity-0 m-0 p-0 border-none pointer-events-none': !uiState.isTextSidebarVisible()}">
      
      <div class="px-2 pb-1 rounded-xl bg-retro-teal/10 dark:bg-retro-teal/5 border border-retro-teal/30 dark:border-retro-teal/20">
        <header 
          (click)="uiState.isTextUnassignedOpen.set(!uiState.isTextUnassignedOpen()); $event.stopPropagation()" 
          class="py-2 cursor-pointer flex justify-between items-center group select-none touch-manipulation"
          style="-webkit-tap-highlight-color: transparent;">
          <span class="font-bold text-retro-dark dark:text-stone-200 flex items-center gap-2 tracking-tight pointer-events-none"
                [ngClass]="{'text-sm': !isMobile, 'text-xs': isMobile}">
            <span class="w-1.5 h-1.5 rounded-full bg-retro-teal shadow-[0_0_6px_rgba(74,140,140,0.4)]"></span>
            待分配
          </span>
          <div class="flex items-center gap-2">
            <button 
              (click)="onCreateClick($event)"
              class="flex items-center gap-1 px-2 py-1 rounded-md border border-retro-teal/50 bg-retro-teal/10 text-retro-teal hover:bg-retro-teal hover:text-white transition-colors"
              [ngClass]="{'text-xs': !isMobile, 'text-[10px]': isMobile}">
              <span class="text-base leading-none">+</span>
              新建
            </button>
            <span class="text-stone-300 dark:text-stone-600 text-xs group-hover:text-stone-500 transition-transform pointer-events-none" 
                  [class.rotate-180]="!uiState.isTextUnassignedOpen()">▼</span>
          </div>
        </header>

        @if (uiState.isTextUnassignedOpen()) {
          <div class="pb-2 animate-collapse-open">
            <div class="flex flex-wrap" 
                 [ngClass]="{'gap-2': !isMobile, 'gap-1.5': isMobile}"
                 (dragover)="handleDragOverUnassigned($event)"
                 (dragleave)="handleDragLeaveUnassigned($event)"
                 (drop)="handleDropUnassigned($event)">
              @for (task of projectState.unassignedTasks(); track task.id) {
                @if (editingTaskId() === task.id) {
                  <!-- 编辑/预览模式 -->
                  <div 
                    [attr.data-unassigned-task]="task.id"
                    class="w-full rounded-lg shadow-sm animate-collapse-open"
                    [ngClass]="{
                      'p-2 bg-white dark:bg-stone-800 border border-retro-teal dark:border-retro-teal': isEditMode(),
                      'px-2 py-1.5 bg-retro-teal/5 dark:bg-retro-teal/10 border border-retro-teal/20 dark:border-retro-teal/30 hover:border-retro-teal/40': !isEditMode()
                    }">
                    @if (isEditMode()) {
                      <!-- 【修复】编辑容器需要防止事件冒泡导致缩小 -->
                      <div class="space-y-2" (click)="$event.stopPropagation()">
                        <input #editInput
                          data-title-input
                          class="w-full bg-transparent border-none focus:ring-0 text-retro-dark dark:text-stone-200 p-0 mb-1"
                          [ngClass]="{'text-sm': !isMobile, 'text-xs': isMobile}"
                          [value]="localTitle()"
                          (input)="localTitle.set(editInput.value)"
                          (keydown.enter)="saveTask(task)"
                          (keydown.escape)="cancelEdit()"
                          (blur)="onTitleBlur($event, task)"
                          placeholder="输入任务标题..."
                          (click)="$event.stopPropagation()">
                        <textarea
                          #contentInput
                          class="w-full border border-stone-200 dark:border-stone-700 rounded-md bg-white dark:bg-stone-700 text-stone-700 dark:text-stone-300 focus:ring-1 focus:ring-retro-teal focus:border-retro-teal outline-none resize-none"
                          [ngClass]="{'text-xs p-2 min-h-[90px]': !isMobile, 'text-[11px] p-1.5 min-h-[100px]': isMobile}"
                          [value]="localContent()"
                          (input)="localContent.set(contentInput.value)"
                          (keydown.meta.enter)="saveTask(task)"
                          (keydown.ctrl.enter)="saveTask(task)"
                          (click)="$event.stopPropagation()"
                          placeholder="输入任务内容 (Markdown)..."></textarea>
                        <div class="flex justify-end gap-2">
                          <button (click)="cancelEdit(); $event.stopPropagation()" class="text-[10px] text-stone-400 hover:text-stone-600">取消</button>
                          <button (click)="saveTask(task); $event.stopPropagation()" class="text-[10px] text-retro-teal hover:text-retro-teal/80 font-bold">保存</button>
                        </div>
                      </div>
                    } @else {
                      <div class="flex justify-between items-start gap-2 group/preview">
                        <!-- 【修复】点击内容区域直接进入编辑，不触发卡片切换逻辑 -->
                        <div class="flex-1 min-w-0 cursor-text" (click)="enterEdit(task); $event.stopPropagation()">
                          <div class="font-medium text-retro-dark dark:text-stone-200 truncate"
                               [ngClass]="{'text-sm': !isMobile, 'text-xs': isMobile}">
                            {{task.title}}
                          </div>
                          @if (task.content) {
                            <div class="prose prose-stone dark:prose-invert max-w-none mt-1 opacity-80"
                                 [ngClass]="{'text-xs': !isMobile, 'text-[10px] line-clamp-2': isMobile}"
                                 [innerHTML]="getSanitizedContent(task.content)">
                            </div>
                          }
                        </div>
                        <!-- 操作按钮组 -->
                        <div class="flex gap-1 shrink-0 mt-0.5 opacity-0 group-hover/preview:opacity-100 transition-opacity">
                          <button (click)="enterEdit(task); $event.stopPropagation()" 
                                  class="p-1 text-stone-400 hover:text-retro-teal transition-colors"
                                  title="编辑任务">
                            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>
                          </button>
                          <button (click)="deleteTask(task.id); $event.stopPropagation()" 
                                  class="p-1 text-stone-400 hover:text-retro-rust transition-colors"
                                  title="删除任务">
                            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                          </button>
                        </div>
                      </div>
                    }
                  </div>
                } @else {
                  <!-- 【修复】普通展示模式：卡片外框用于在场景间切换，内容区域专用于编辑 -->
                  <div 
                    [attr.data-unassigned-task]="task.id"
                    (click)="onTaskCardClick(task); $event.stopPropagation()"
                    [attr.draggable]="true"
                    (dragstart)="handleDragStart($event, task)"
                    (dragend)="handleDragEnd()"
                    (touchstart)="handleTouchStart($event, task)"
                    (touchmove)="handleTouchMove($event)"
                    (touchend)="handleTouchEnd($event)"
                    (touchcancel)="handleTouchCancel($event)"
                    class="px-2 py-1 bg-white/60 dark:bg-stone-800/60 rounded-lg border border-retro-teal/20 dark:border-retro-teal/40 hover:border-retro-teal/50 hover:bg-white dark:hover:bg-stone-800 transition-all cursor-move active:scale-[0.98] select-none touch-none"
                    [ngClass]="{
                      'text-xs': !isMobile, 
                      'text-[10px]': isMobile,
                      'opacity-40 scale-98 border border-retro-teal border-dashed bg-retro-teal/10': draggingTaskId === task.id
                    }">
                    <span class="text-retro-dark dark:text-stone-300">{{task.title || '未命名任务'}}
                      <span *ngIf="task.content" class="ml-1 text-[10px] text-stone-400">· 内容</span>
                    </span>
                  </div>
                }
              }
            </div>
            @if (projectState.unassignedTasks().length === 0) {
              <div class="px-3 py-4 text-center">
                <p class="text-stone-400 italic font-light" [ngClass]="{'text-xs': !isMobile, 'text-[10px]': isMobile}">无待分配任务</p>
              </div>
            }
          </div>
        }
      </div>
    </section>
  `,
  styles: [`
    :host { display: block; }
    .animate-collapse-open {
      animation: collapse-open 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      transform-origin: top;
    }
    @keyframes collapse-open {
      from { opacity: 0; transform: scaleY(0.95); }
      to { opacity: 1; transform: scaleY(1); }
    }
  `]
})
export class TextUnassignedComponent implements OnDestroy {
  @Input() isMobile = false;
  @Input() draggingTaskId: string | null = null;

  @Output() taskClick = new EventEmitter<Task>();
  @Output() createUnassigned = new EventEmitter<void>();
  @Output() dragStart = new EventEmitter<{ event: DragEvent; task: Task }>();
  @Output() dragEnd = new EventEmitter<void>();
  @Output() touchStart = new EventEmitter<{ event: TouchEvent; task: Task }>();
  @Output() touchMove = new EventEmitter<TouchEvent>();
  @Output() touchEnd = new EventEmitter<TouchEvent>();
  @Output() touchCancel = new EventEmitter<TouchEvent>();
  
  protected taskAdapter = inject(TaskOperationAdapterService);
  protected uiState = inject(UiStateService);
  protected projectState = inject(ProjectStateService);
  private sanitizer = inject(DomSanitizer);
  private cdr = inject(ChangeDetectorRef);

  protected editingTaskId = signal<string | null>(null);
  protected isEditMode = signal(false);
  protected localTitle = signal('');
  protected localContent = signal('');

  constructor() {
    effect(() => {
      if (!this.uiState.isTextSidebarVisible()) {
        this.cancelEdit();
      }
    });

    effect(() => {
      if (this.uiState.isTextSidebarVisible()) {
        this.cdr.markForCheck();
      }
    });
  }

  ngOnDestroy(): void {
    this.cancelEdit();
  }

  /**
   * TextViewComponent 调用的公开方法
   * 设置当前选中的编辑任务
   */
  public async setEditingTask(taskId: string, isEdit: boolean): Promise<void> {
    this.editingTaskId.set(taskId);
    this.isEditMode.set(isEdit);
    this.syncLocalState(taskId);
    this.cdr.markForCheck();
  }

  /**
   * TextViewComponent 调用的公开方法
   * 退出编辑态并重置为预览折叠
   */
  public resetEditState(): void {
    this.cancelEdit();
    this.cdr.markForCheck();
  }

  protected onTaskClick(task: Task): void {
    // 【修复】区分点击源：卡片外框(三段式切换) vs 内容区域(直接编辑)
    // - 点击卡片外框按钮：展开 -> 折叠 -> 展开
    // - 点击内容区域：直接进入编辑模式（符合编辑直觉）
    if (this.editingTaskId() === task.id) {
      if (this.isEditMode()) {
        this.isEditMode.set(false); // 编辑 -> 预览
      } else {
        this.cancelEdit(); // 预览 -> 折叠
      }
    } else {
      this.editingTaskId.set(task.id);
      this.isEditMode.set(false); // 默认进入预览态
      this.syncLocalState(task.id);
    }
    this.taskClick.emit(task);
  }

  /**
   * 【新增】处理普通展示模式卡片的点击
   * 点击卡片显示体验：展开卡片查看内容
   */
  protected onTaskCardClick(task: Task): void {
    // 如果没展开过，展开显示预览
    // 如果已经展开过，再次点击则进行下一步操作
    if (this.editingTaskId() === task.id) {
      // 再次点击已展开的卡片：进入编辑模式（而不是折叠）
      this.isEditMode.set(true);
      this.localTitle.set(task.title || '');
      this.localContent.set(task.content || '');
    } else {
      // 首次展开：显示预览
      this.editingTaskId.set(task.id);
      this.isEditMode.set(false);
      this.syncLocalState(task.id);
    }
  }

  protected enterEdit(task: Task): void {
    this.editingTaskId.set(task.id);
    this.isEditMode.set(true);
    this.localTitle.set(task.title || '');
    this.localContent.set(task.content || '');
  }

  /**
   * 【修复】标题输入框失焦处理 - 防止在编辑过程中意外保存
   * 只有当用户确实要结束编辑时（点击保存/取消或按 Escape）才保存
   * title 输入框之间的 tab/焦点切换不应触发保存
   */
  protected onTitleBlur(event: FocusEvent, task: Task): void {
    // 检查焦点是否移动到同一编辑框内的其他元素
    const relatedTarget = event.relatedTarget as HTMLElement;
    const editContainer = (event.target as HTMLElement).closest('[data-unassigned-task]');
    
    // 如果焦点仍在编辑容器内（比如移到 textarea），不保存
    if (relatedTarget && editContainer?.contains(relatedTarget)) {
      return;
    }
    
    // 焦点离开了编辑框容器，才进行保存
    this.saveTask(task);
  }

  protected cancelEdit(): void {
    this.editingTaskId.set(null);
    this.isEditMode.set(false);
    this.localTitle.set('');
    this.localContent.set('');
  }

  protected saveTask(task: Task): void {
    const title = this.localTitle().trim();
    const content = this.localContent();
    if (!title) {
       this.cancelEdit();
       return;
    }
    const titleChanged = title !== task.title;
    const contentChanged = content !== (task.content || '');
    
    if (titleChanged) {
      this.taskAdapter.updateTaskTitle(task.id, title);
    }
    if (contentChanged) {
      this.taskAdapter.updateTaskContent(task.id, content);
    }
    
    // 保存后默认折叠为最小块，方便继续浏览
    this.cancelEdit();
    this.cdr.markForCheck();
  }

  protected async deleteTask(taskId: string): Promise<void> {
    await this.taskAdapter.deleteTask(taskId);
    if (this.editingTaskId() === taskId) {
      this.cancelEdit();
    }
  }

  protected getSanitizedContent(content: string): SafeHtml {
    // 修复：renderMarkdownSafe 需要 sanitizer 参数
    return renderMarkdownSafe(content, this.sanitizer);
  }

  protected onCreateClick(event: Event): void {
    event.stopPropagation();
    this.createUnassigned.emit();
  }

  protected handleDragStart(event: DragEvent, task: Task): void {
    this.dragStart.emit({ event, task });
  }

  protected handleDragEnd(): void {
    this.dragEnd.emit();
  }

  protected handleTouchStart(event: TouchEvent, task: Task): void {
    this.touchStart.emit({ event, task });
  }

  protected handleTouchMove(event: TouchEvent): void {
    this.touchMove.emit(event);
  }

  protected handleTouchEnd(event: TouchEvent): void {
    this.touchEnd.emit(event);
  }

  protected handleTouchCancel(event: TouchEvent): void {
    this.touchCancel.emit(event);
  }

  /**
   * 待分配区域内的拖放事件处理
   * 支持待分配块之间的重新挂载（改变父子关系）
   */
  protected handleDragOverUnassigned(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  }

  protected handleDragLeaveUnassigned(_event: DragEvent): void {
    // 可选：添加视觉反馈
  }

  protected handleDropUnassigned(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();

    // 提取拖放数据
    const data = event.dataTransfer?.getData("application/json") || event.dataTransfer?.getData("text");
    if (!data) return;

    try {
      const draggedTask = JSON.parse(data) as Task;
      
      // 只处理待分配块之间的拖放（都是 stage === null）
      if (draggedTask?.id && draggedTask.stage === null) {
        // 获取所有待分配任务（排除拖动的任务本身）
        const unassignedTasks = this.projectState.unassignedTasks()
          .filter(t => t.id !== draggedTask.id);
        
        if (unassignedTasks.length > 0) {
          // 选择第一个待分配块作为新的父块
          // 实际应用中可以根据鼠标位置选择最近的块
          const targetTask = unassignedTasks[0];
          
          // 使用适配器执行重新挂载操作
          const result = this.taskAdapter.moveTaskToStage(draggedTask.id, null, undefined, targetTask.id);
          
          if (!result.ok) {
            // 操作失败，但不需要显示错误消息（已由适配器处理）
            return;
          }
          
          // 操作成功，emit 事件通知父组件更新视图
          this.dragStart.emit({ event: new DragEvent('drop'), task: draggedTask });
        }
      }
    } catch (err) {
      // 数据解析失败，忽略
    }
  }

  private syncLocalState(taskId: string): void {
    const target = this.projectState.getTask(taskId);
    this.localTitle.set(target?.title || '');
    this.localContent.set(target?.content || '');
  }
}
