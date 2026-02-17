import { Component, inject, ChangeDetectionStrategy, ElementRef, input, output, viewChild, effect } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { ProjectStateService, TaskConnectionInfo } from '../../../../services/project-state.service';
import { LoggerService } from '../../../../services/logger.service';
import { Task } from '../../../../models';
import { SafeMarkdownPipe } from '../../../shared/pipes/safe-markdown.pipe';
import { TextTaskEditorComponent } from './text-task-editor.component';

/**
 * 任务卡片组件
 * 显示单个任务，支持收起/展开两种状态
 */
@Component({
  selector: 'app-text-task-card',
  standalone: true,
  imports: [CommonModule, DatePipe, TextTaskEditorComponent, SafeMarkdownPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      [attr.data-task-id]="task().id"
      (click)="onCardClick($event)"
      [attr.draggable]="!isSelected()"
      (dragstart)="onDragStart($event)"
      (dragend)="onDragEnd()"
      (dragover)="onDragOver($event)"
      (touchstart)="onTouchStart($event)"
      (touchmove)="onTouchMove($event)"
      (touchend)="onTouchEnd($event)"
      (touchcancel)="onTouchCancel($event)"
      class="text-task-card virtual-list-item relative bg-canvas/80 dark:bg-stone-800/80 backdrop-blur-sm border rounded-lg cursor-pointer hover:shadow-md hover:-translate-y-0.5 transition-all group stack-card overflow-hidden"
      [ngClass]="cardClasses">

      <!-- 头部信息 -->
      <div class="flex justify-between items-start"
           [ngClass]="{'mb-1': !isMobile(), 'mb-0.5': isMobile()}">
        <span class="font-mono font-medium text-retro-muted dark:text-stone-400"
              [ngClass]="{'text-[10px]': !isMobile(), 'text-[9px]': isMobile()}">
          {{projectState.compressDisplayId(task().displayId)}}
        </span>
        <span class="text-retro-muted/60 dark:text-stone-500 font-light"
              [ngClass]="{'text-[10px]': !isMobile(), 'text-[9px]': isMobile()}">
          {{task().createdDate | date:'yyyy/MM/dd HH:mm'}}
        </span>
      </div>

      @if (!isSelected()) {
        <!-- 收起状态 -->
        <div class="font-medium text-retro-dark dark:text-stone-200 leading-snug line-clamp-2 cursor-pointer"
             [ngClass]="{'text-sm mb-1': !isMobile(), 'text-xs mb-0.5': isMobile()}">
          {{task().title || '未命名任务'}}
        </div>
        @if (task().content) {
          <div class="text-stone-500 dark:text-stone-400 font-light leading-relaxed line-clamp-1 cursor-pointer min-h-[1em] markdown-preview-compact"
               [ngClass]="{'text-xs': !isMobile(), 'text-[10px]': isMobile()}"
               [innerHTML]="task().content | safeMarkdown">
          </div>
        } @else {
          <div class="text-stone-400 dark:text-stone-500 italic font-light leading-relaxed line-clamp-1 cursor-pointer min-h-[1em]"
               [ngClass]="{'text-xs': !isMobile(), 'text-[10px]': isMobile()}">
            暂无描述
          </div>
        }
      } @else {
        <!-- 展开编辑状态 -->
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
          (attachmentError)="attachmentError.emit($event)"
          (openLinkedTask)="openLinkedTask.emit($event)">
        </app-text-task-editor>
      }
    </div>
  `
})
export class TextTaskCardComponent {
  readonly projectState = inject(ProjectStateService);
  private readonly logger = inject(LoggerService);

  taskEditor = viewChild<TextTaskEditorComponent>('taskEditor');
  taskEditorElement = viewChild('taskEditor', { read: ElementRef });

  // 双击检测（手机端）
  private lastClickTime = 0;
  private lastClickWasNonEdit = false;
  private readonly DOUBLE_CLICK_DELAY = 300; // 300ms 内的连续点击视为双击

  // 桌面端展开冷却：防止双击触发 select→deselect 快速切换
  private lastSelectTime = 0;
  private readonly SELECT_COOLDOWN = 400; // 展开后 400ms 内忽略后续 click

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
  attachmentError = output<string>();
  openLinkedTask = output<{ task: Task; event: Event }>();

  // 拖拽事件
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
        const curr = this.task();
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
      // 【防御】SW chunk 不一致可能导致 DestroyRef/injection context 丢失
    }
  }

  get cardClasses() {
    return {
      'p-3': !this.isMobile(),
      'p-2': this.isMobile(),
      'shadow-sm border-retro-muted/20': !this.isSelected() && !this.isDragging(),
      'ring-1 ring-retro-gold shadow-md': this.isSelected(),
      // 拖拽时的视觉效果：半透明、缩小、虚线边框
      // 注意：不使用 pointer-events-none，因为会阻止 touchend 事件
      'opacity-40 scale-98 border-2 border-retro-teal border-dashed bg-retro-teal/5': this.isDragging()
    };
  }



  /**
   * 处理卡片点击
   * - 桌面端：单击非编辑区域切换展开/收起状态
   * - 手机端：连续两次点击非编辑区域切换展开/收起状态
   * - 点击编辑区域：不处理（让用户正常编辑）
   */
  onCardClick(event: Event) {
    const targetElement = event.target instanceof HTMLElement ? event.target : null;

    // 如果点击的是输入框、文本框或按钮，或者点击目标在这些元素内部，直接阻止冒泡并返回
    if (targetElement && (
        targetElement.tagName === 'INPUT' ||
        targetElement.tagName === 'TEXTAREA' ||
        targetElement.tagName === 'BUTTON' ||
        targetElement.closest('input, textarea, button'))
    ) {
      event.stopPropagation();
      // 重置双击状态（点击了编辑区域）
      this.lastClickWasNonEdit = false;
      return;
    }

    // 检查是否点击在编辑器区域内
    const clickedInEditor = this.isSelected() && this.isClickInsideEditor(event.target);

    if (clickedInEditor) {
      // 点击了编辑区域，重置双击状态
      event.stopPropagation();
      this.lastClickWasNonEdit = false;
      return;
    }

    // 点击了非编辑区域
    // 桌面端：单击直接切换（带冷却保护，防止双击导致 展开→立即收起）
    if (!this.isMobile()) {
      const now = Date.now();
      if (now - this.lastSelectTime < this.SELECT_COOLDOWN) {
        // 冷却期内，忽略此次点击（防止双击第二下把刚展开的卡片又收起）
        event.stopPropagation();
        return;
      }
      this.lastSelectTime = now;
      this.select.emit(this.task());
      event.stopPropagation();
      return;
    }

    // 手机端：需要双击才切换
    const currentTime = Date.now();
    const timeSinceLastClick = currentTime - this.lastClickTime;

    // 检测是否为有效的双击（连续两次点击非编辑区域，且在时间窗口内）
    if (this.lastClickWasNonEdit && timeSinceLastClick < this.DOUBLE_CLICK_DELAY) {
      // 双击成功，切换状态
      this.select.emit(this.task());
      // 重置状态
      this.lastClickWasNonEdit = false;
      this.lastClickTime = 0;
    } else {
      // 第一次点击或超时，记录状态
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
    // 只在未选中状态下允许鼠标拖拽
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
    // 只在未选中状态下允许触摸拖拽（与待分配区域一致）
    // 不在这里 preventDefault，让浏览器正常处理触摸开始
    if (!this.isSelected()) {
      this.touchStart.emit({ event, task: this.task() });
    }
  }

  onTouchMove(event: TouchEvent) {
    if (!this.isSelected()) {
      // 发射事件让父组件处理
      this.touchMove.emit(event);
      // 🔧 修复：在拖拽状态下或有待处理的触摸拖拽时都要阻止默认行为
      // 这样可以防止浏览器触发页面滚动，确保拖拽体验流畅
      // 注意：isDragging 属性由父组件传入，在拖拽激活后会变为 true
      if (this.isDragging()) {
        // 检查事件是否可取消（避免滚动进行中的 Intervention 警告）
        if (event.cancelable) {
          event.preventDefault();
        }
      }
      // 注意：在拖拽激活前的 touchmove 不阻止默认行为，
      // 这是为了让用户可以正常滚动页面（垂直方向的移动）
    }
  }

  onTouchEnd(event: TouchEvent) {
    if (!this.isSelected()) {
      // 不在这里 preventDefault，让事件正常冒泡到 document
      this.touchEnd.emit(event);
    }
  }

  onTouchCancel(event: TouchEvent) {
    if (!this.isSelected()) {
      this.touchCancel.emit(event);
    }
  }
}
