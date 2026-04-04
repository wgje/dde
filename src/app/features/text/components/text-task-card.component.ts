import { Component, inject, ChangeDetectionStrategy, ElementRef, input, output, signal, viewChild, effect } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { ProjectStateService, TaskConnectionInfo } from '../../../../services/project-state.service';
import { LoggerService } from '../../../../services/logger.service';
import { Task } from '../../../../models';
import { SafeMarkdownPipe } from '../../../shared/pipes/safe-markdown.pipe';
import { TextTaskEditorComponent } from './text-task-editor.component';

@Component({
  selector: 'app-text-task-card',
  standalone: true,
  imports: [CommonModule, DatePipe, TextTaskEditorComponent, SafeMarkdownPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      data-testid="task-card"
      [attr.data-task-id]="task().id"
      [attr.data-indent-level]="task().parentId ? '1' : '0'"
      (click)="onCardClick($event)"
      [attr.draggable]="!isSelected()"
      (dragstart)="onDragStart($event)"
      (dragend)="onDragEnd()"
      (dragover)="onDragOver($event)"
      (touchstart)="onTouchStart($event)"
      (touchmove)="onTouchMove($event)"
      (touchend)="onTouchEnd($event)"
      (touchcancel)="onTouchCancel($event)"
      class="text-task-card virtual-list-item relative min-w-0 bg-canvas/80 dark:bg-stone-800/80 backdrop-blur-sm border rounded-lg cursor-pointer hover:shadow-md hover:-translate-y-0.5 transition-all group stack-card overflow-hidden"
      [ngClass]="cardClasses">

      <div class="flex justify-between items-start"
           [ngClass]="{'mb-1': !isMobile(), 'mb-0.5': isMobile()}">
        <div class="flex items-center gap-1">
          <span class="font-mono font-medium text-retro-muted dark:text-stone-400"
                [ngClass]="{'text-[10px]': !isMobile(), 'text-[9px]': isMobile()}">
            {{ projectState.compressDisplayId(task().displayId) }}
          </span>
          @if (task().parkingMeta?.state === 'parked') {
            <span
              class="text-[8px] px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 font-medium"
              title="Parked">
              Parked
            </span>
          }
          @if (isDockFocused()) {
            <span
              class="text-[8px] px-1 py-0.5 rounded bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 font-medium"
              title="Focus task">
              Focus
            </span>
          } @else if (isDocked()) {
            <span
              class="text-[8px] px-1 py-0.5 rounded bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-300 font-medium"
              title="Docked task">
              Docked
            </span>
          }
          <span
            data-testid="text-task-status-badge"
            class="text-[8px] px-1 py-0.5 rounded font-medium"
            [ngClass]="{
              'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300': task().status === 'completed',
              'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300': task().status !== 'completed'
            }">
            {{ task().status === 'completed' ? 'Completed' : 'Active' }}
          </span>
        </div>
        <span class="text-retro-muted/60 dark:text-stone-500 font-light"
              [ngClass]="{'text-[10px]': !isMobile(), 'text-[9px]': isMobile()}">
          {{ task().createdDate | date:'yyyy/MM/dd HH:mm' }}
        </span>
      </div>

      @if (!isSelected()) {
        <div class="font-medium text-retro-dark dark:text-stone-200 leading-snug line-clamp-2 cursor-pointer"
             data-testid="task-title-label"
             [ngClass]="{'text-sm mb-1': !isMobile(), 'text-xs mb-0.5': isMobile()}">
          {{ task().title || 'Untitled task' }}
        </div>
        @if (task().content) {
          <div class="text-stone-500 dark:text-stone-400 font-light leading-relaxed line-clamp-1 cursor-pointer min-h-[1em] markdown-preview-compact"
               [ngClass]="{'text-xs': !isMobile(), 'text-[10px]': isMobile()}"
               [innerHTML]="task().content | safeMarkdown">
          </div>
        } @else {
          <div class="text-stone-400 dark:text-stone-500 italic font-light leading-relaxed line-clamp-1 cursor-pointer min-h-[1em]"
               [ngClass]="{'text-xs': !isMobile(), 'text-[10px]': isMobile()}">
            No description
          </div>
        }
      } @else {
        <app-text-task-editor
          #taskEditor
          [task]="task()"
          [isMobile]="isMobile()"
          [userId]="userId()"
          [projectId]="projectId()"
          [connections]="connections()"
          (addSibling)="addSibling.emit()"
          (addChild)="addChild.emit()"
          (deleteTask)="deleteTask.emit()"
          (parkTask)="parkTask.emit()"
          (attachmentError)="attachmentError.emit($event)"
          (openLinkedTask)="openLinkedTask.emit($event)"
          (previewModeChange)="onEditorPreviewChange($event)">
        </app-text-task-editor>
      }
    </div>
  `,
})
export class TextTaskCardComponent {
  readonly dockEngine = inject(DockEngineService);
  readonly projectState = inject(ProjectStateService);
  private readonly logger = inject(LoggerService);

  taskEditor = viewChild<TextTaskEditorComponent>('taskEditor');
  taskEditorElement = viewChild('taskEditor', { read: ElementRef });

  /** 编辑器是否处于预览模式（选中态子状态） */
  editorPreview = signal(true);

  private lastClickTime = 0;
  private lastClickWasNonEdit = false;
  private readonly DOUBLE_CLICK_DELAY = 300;

  private lastSelectTime = 0;
  private readonly SELECT_COOLDOWN = 400;

  task = input.required<Task>();
  isMobile = input(false);
  isSelected = input(false);
  isDragging = input(false);
  userId = input<string | null>(null);
  projectId = input<string | null>(null);
  connections = input<TaskConnectionInfo | null>(null);
  stageNumber = input(0);

  select = output<Task>();
  addSibling = output<void>();
  addChild = output<void>();
  deleteTask = output<void>();
  parkTask = output<void>();
  attachmentError = output<string>();
  openLinkedTask = output<{ task: Task; event: Event }>();

  dragStart = output<{ event: DragEvent; task: Task }>();
  dragEnd = output<void>();
  dragOver = output<{ event: DragEvent; task: Task; stageNumber: number }>();
  touchStart = output<{ event: TouchEvent; task: Task }>();
  touchMove = output<TouchEvent>();
  touchEnd = output<TouchEvent>();
  touchCancel = output<TouchEvent>();

  constructor() {
    try {
      let prevTask: Task | undefined;
      effect(() => {
        let curr: Task | undefined;
        try {
          curr = this.task();
        } catch {
          return;
        }
        if (prevTask?.displayId && prevTask.displayId !== '?' && curr?.displayId === '?') {
          this.logger.warn('TextTaskCard', 'displayId changed from valid to "?"', {
            taskId: curr?.id?.slice(-4) ?? 'unknown',
            prevDisplayId: prevTask.displayId,
            currDisplayId: curr.displayId,
            title: curr?.title || 'untitled',
            stage: curr?.stage,
            parentId: curr?.parentId?.slice(-4) ?? null,
          });
        }
        prevTask = curr;
      });
    } catch {
      // SW chunk mismatch can lose injection context in rare cases.
    }
  }

  get cardClasses() {
    const selected = this.isSelected();
    const preview = this.editorPreview();
    return {
      'p-3': !this.isMobile(),
      'p-2': this.isMobile(),
      'shadow-sm border-retro-muted/20': !selected && !this.isDragging(),
      // 预览态：去掉可见边框和金色ring，保持阴影区分层级
      'border-transparent shadow-sm': selected && preview,
      // 编辑态：保留金色ring和边框，作为编辑状态的视觉提示
      'ring-1 ring-retro-gold shadow-md': selected && !preview,
      'ring-2 ring-indigo-400/70 shadow-[0_0_0_1px_rgba(99,102,241,0.18),0_0_20px_rgba(99,102,241,0.16)]': this.isDockFocused(),
      'opacity-40 scale-98 border-2 border-retro-teal border-dashed bg-retro-teal/5': this.isDragging(),
    };
  }

  onEditorPreviewChange(isPreview: boolean) {
    this.editorPreview.set(isPreview);
  }

  isDocked(): boolean {
    return this.dockEngine.dockedTaskIds().has(this.task().id);
  }

  isDockFocused(): boolean {
    return this.dockEngine.focusingEntry()?.taskId === this.task().id;
  }

  onCardClick(event: Event) {
    const targetElement = event.target instanceof HTMLElement ? event.target : null;

    if (
      targetElement
      && (
        targetElement.tagName === 'INPUT'
        || targetElement.tagName === 'TEXTAREA'
        || targetElement.tagName === 'BUTTON'
        || !!targetElement.closest('input, textarea, button')
      )
    ) {
      event.stopPropagation();
      this.lastClickWasNonEdit = false;
      return;
    }

    const clickedInEditor = this.isSelected() && this.isClickInsideEditor(event.target);
    if (clickedInEditor) {
      event.stopPropagation();
      this.lastClickWasNonEdit = false;
      return;
    }

    if (!this.isMobile()) {
      const now = Date.now();
      if (now - this.lastSelectTime < this.SELECT_COOLDOWN) {
        event.stopPropagation();
        return;
      }
      this.lastSelectTime = now;
      this.select.emit(this.task());
      event.stopPropagation();
      return;
    }

    const currentTime = Date.now();
    const timeSinceLastClick = currentTime - this.lastClickTime;

    if (this.lastClickWasNonEdit && timeSinceLastClick < this.DOUBLE_CLICK_DELAY) {
      this.select.emit(this.task());
      this.lastClickWasNonEdit = false;
      this.lastClickTime = 0;
    } else {
      this.lastClickWasNonEdit = true;
      this.lastClickTime = currentTime;
    }

    event.stopPropagation();
  }

  private isClickInsideEditor(target: EventTarget | null): boolean {
    if (!target) return false;
    const editorElement = this.taskEditorElement()?.nativeElement;
    if (!editorElement) return false;

    if (target instanceof Node && editorElement.contains(target)) {
      return true;
    }

    if (target instanceof Element) {
      return !!target.closest('app-text-task-editor');
    }

    return false;
  }

  onDragStart(event: DragEvent) {
    if (!this.isSelected()) {
      this.dragStart.emit({ event, task: this.task() });
    } else {
      event.preventDefault();
    }
  }

  onDragEnd() {
    if (!this.isSelected()) {
      this.dragEnd.emit();
    }
  }

  onDragOver(event: DragEvent) {
    this.dragOver.emit({ event, task: this.task(), stageNumber: this.stageNumber() });
  }

  onTouchStart(event: TouchEvent) {
    if (!this.isSelected()) {
      this.touchStart.emit({ event, task: this.task() });
    }
  }

  onTouchMove(event: TouchEvent) {
    if (!this.isSelected()) {
      this.touchMove.emit(event);
      if (this.isDragging() && event.cancelable) {
        event.preventDefault();
      }
    }
  }

  onTouchEnd(event: TouchEvent) {
    if (!this.isSelected()) {
      this.touchEnd.emit(event);
    }
  }

  onTouchCancel(event: TouchEvent) {
    if (!this.isSelected()) {
      this.touchCancel.emit(event);
    }
  }
}
