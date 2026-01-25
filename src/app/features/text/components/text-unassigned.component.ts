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
            <div class="flex flex-wrap" [ngClass]="{'gap-2': !isMobile, 'gap-1.5': isMobile}">
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
                      <div class="space-y-2">
                        <input #editInput
                          data-title-input
                          class="w-full bg-transparent border-none focus:ring-0 text-retro-dark dark:text-stone-200 p-0 mb-1"
                          [ngClass]="{'text-sm': !isMobile, 'text-xs': isMobile}"
                          [value]="localTitle()"
                          (input)="localTitle.set(editInput.value)"
                          (keydown.enter)="saveTask(task)"
                          (keydown.escape)="cancelEdit()"
                          (blur)="saveTask(task)"
                          placeholder="输入任务标题...">
                        <textarea
                          #contentInput
                          class="w-full border border-stone-200 dark:border-stone-700 rounded-md bg-white dark:bg-stone-700 text-stone-700 dark:text-stone-300 focus:ring-1 focus:ring-retro-teal focus:border-retro-teal outline-none resize-none"
                          [ngClass]="{'text-xs p-2 min-h-[90px]': !isMobile, 'text-[11px] p-1.5 min-h-[100px]': isMobile}"
                          [value]="localContent()"
                          (input)="localContent.set(contentInput.value)"
                          (keydown.meta.enter)="saveTask(task)"
                          (keydown.ctrl.enter)="saveTask(task)"
                          placeholder="输入任务内容 (Markdown)..."></textarea>
                        <div class="flex justify-end gap-2">
                          <button (click)="cancelEdit(); $event.stopPropagation()" class="text-[10px] text-stone-400 hover:text-stone-600">取消</button>
                          <button (click)="saveTask(task); $event.stopPropagation()" class="text-[10px] text-retro-teal hover:text-retro-teal/80 font-bold">保存</button>
                        </div>
                      </div>
                    } @else {
                      <div class="flex justify-between items-start gap-2">
                        <div class="flex-1 min-w-0" (click)="enterEdit(task); $event.stopPropagation()">
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
                        <div class="flex gap-1 shrink-0 mt-0.5">
                          <button (click)="enterEdit(task); $event.stopPropagation()" 
                                  class="p-1 text-stone-400 hover:text-retro-teal transition-colors">
                            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>
                          </button>
                          <button (click)="deleteTask(task.id); $event.stopPropagation()" 
                                  class="p-1 text-stone-400 hover:text-retro-rust transition-colors">
                            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                          </button>
                        </div>
                      </div>
                    }
                  </div>
                } @else {
                  <!-- 普通展示模式 -->
                  <div 
                    [attr.data-unassigned-task]="task.id"
                    (click)="onTaskClick(task)"
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
                <div class="mt-2 text-[10px] text-stone-300 dark:text-stone-500 uppercase tracking-widest">NanoFlow</div>
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

  protected onTaskClick(task: Task): void {
    // 点击同一任务时：编辑态 -> 预览态 -> 折叠态 三段式切换
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

  protected enterEdit(task: Task): void {
    this.editingTaskId.set(task.id);
    this.isEditMode.set(true);
    this.localTitle.set(task.title || '');
    this.localContent.set(task.content || '');
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

  private syncLocalState(taskId: string): void {
    const target = this.projectState.tasks().find(t => t.id === taskId);
    this.localTitle.set(target?.title || '');
    this.localContent.set(target?.content || '');
  }
}
