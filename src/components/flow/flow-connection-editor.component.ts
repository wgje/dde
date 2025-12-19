import { Component, input, output, signal, ElementRef, ViewChild, computed, OnInit, OnDestroy, HostListener, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Task } from '../../models';

export interface ConnectionEditorData {
  sourceId: string;
  targetId: string;
  description: string;
  x: number;
  y: number;
}

export interface ConnectionTasks {
  source: Task | null;
  target: Task | null;
}

/**
 * 联系块编辑器组件
 * 浮动在连接线附近，可拖动，用于编辑连接描述
 * 
 * 改进：
 * - 点击编辑区域进入编辑模式
 * - 点击外部或非编辑区域自动保存并退出编辑模式
 * - 实时保存输入内容
 * - 标题栏整体可拖动
 * - 压缩信息密度
 * - 支持删除关联连接
 */
@Component({
  selector: 'app-flow-connection-editor',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    @if (data(); as connData) {
      <div class="fixed z-[100] animate-scale-in"
           #editorContainer
           [style.left.px]="clampedPosition().x"
           [style.top.px]="clampedPosition().y">
        <div class="bg-white rounded-lg shadow-xl border border-violet-200 overflow-hidden w-44 max-w-[calc(100vw-1.5rem)]"
             (click)="$event.stopPropagation()">
          <!-- 可拖动标题栏 - 整个标题栏都可拖动 -->
          <div class="px-2 py-1.5 bg-gradient-to-r from-violet-50 to-indigo-50 border-b border-violet-100 flex items-center gap-1.5 cursor-move select-none"
               (mousedown)="onDragStart($event)"
               (touchstart)="onDragStart($event)">
            <span class="text-[10px]">🔗</span>
            <span class="text-[10px] font-medium text-violet-700 flex-1">关联</span>
            <!-- 删除按钮 -->
            <button 
              (click)="onDeleteClick($event)"
              (touchend)="onDeleteClick($event)"
              class="text-stone-400 hover:text-red-500 p-0.5 transition-colors"
              title="删除关联">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
            <span class="text-[8px] text-violet-300 ml-0.5">☰</span>
          </div>
          
          <!-- 连接的两个任务 - 超紧凑显示 -->
          <div class="px-2 py-1 bg-stone-50/50 border-b border-stone-100">
            <div class="flex items-center gap-1 text-[9px]">
              @if (connectionTasks().source; as source) {
                <span class="font-bold text-violet-500 truncate max-w-[55px]">{{ compressDisplayId(source.displayId) }}</span>
              }
              <svg class="w-2.5 h-2.5 text-violet-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8l4 4m0 0l-4 4m4-4H3" />
              </svg>
              @if (connectionTasks().target; as target) {
                <span class="font-bold text-indigo-500 truncate max-w-[55px]">{{ compressDisplayId(target.displayId) }}</span>
              }
            </div>
          </div>
          
          <!-- 描述区域 - 点击进入编辑模式 -->
          <div class="px-2 py-1.5">
            @if (isEditMode()) {
              <!-- 编辑模式 -->
              <textarea 
                #descInput
                [(ngModel)]="editingDescription"
                (ngModelChange)="onDescriptionChange($event)"
                (keydown.escape)="exitEditMode()"
                (blur)="onTextareaBlur($event)"
                class="w-full text-[11px] text-stone-700 border border-violet-300 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-violet-400 bg-white resize-none"
                placeholder="输入关联描述..."
                [style.min-height.px]="24"
                [style.max-height.px]="80"></textarea>
            } @else {
              <!-- 预览模式 -->
              <div 
                class="text-[11px] text-stone-600 min-h-[24px] px-1.5 py-1 rounded border border-transparent hover:border-stone-200 cursor-text transition-colors"
                (click)="enterEditMode()">
                @if (currentDescription()) {
                  <span>{{ currentDescription() }}</span>
                } @else {
                  <span class="text-stone-400 italic">点击添加描述...</span>
                }
              </div>
            }
          </div>
        </div>
      </div>
    }
  `
})
export class FlowConnectionEditorComponent implements OnInit, OnDestroy {
  @ViewChild('descInput') descInput!: ElementRef<HTMLTextAreaElement>;
  @ViewChild('editorContainer') editorContainer!: ElementRef<HTMLDivElement>;

  readonly data = input<ConnectionEditorData | null>(null);
  readonly position = input<{ x: number; y: number }>({ x: 0, y: 0 });
  readonly connectionTasks = input<ConnectionTasks>({ source: null, target: null });
  
  readonly close = output<void>();
  readonly save = output<string>();
  readonly delete = output<void>();
  readonly positionChange = output<{ x: number; y: number }>();
  readonly dragStart = output<MouseEvent | TouchEvent>();
  
  // 编辑模式状态
  readonly isEditMode = signal(false);
  
  // 当前编辑的描述内容
  editingDescription = '';
  
  // 防抖保存定时器
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  // 防止“打开编辑器的同一次点击”触发 document:click 立即关闭
  private ignoreOutsideUntil = 0;

  // 当 data 变化时：刷新保护窗口，并在非编辑态同步描述
  private readonly dataSyncEffect = effect(() => {
    const data = this.data();
    console.log('[ConnectionEditor] dataSyncEffect 触发', { data });
    if (!data) return;

    this.ignoreOutsideUntil = Date.now() + 200;

    // 如果用户正在编辑，不要覆盖输入
    if (!this.isEditMode()) {
      this.editingDescription = data.description || '';
    }
  });
  
  // 计算当前描述（优先显示编辑中的内容）
  readonly currentDescription = computed(() => {
    const data = this.data();
    return this.editingDescription || data?.description || '';
  });
  
  // 计算限制在视口内的位置
  readonly clampedPosition = computed(() => {
    const pos = this.position();
    const editorWidth = 176; // w-44 = 11rem = 176px
    const editorHeight = 120; // 估算高度（更紧凑）
    const padding = 12;
    
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1000;
    const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 800;
    
    return {
      x: Math.max(padding, Math.min(pos.x, viewportWidth - editorWidth - padding)),
      y: Math.max(padding, Math.min(pos.y, viewportHeight - editorHeight - padding))
    };
  });

  ngOnInit(): void {
    // 初始化逻辑已由 dataSyncEffect 统一处理
  }

  ngOnDestroy(): void {
    // 清理定时器
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  /**
   * 监听全局点击事件，点击编辑器外部时关闭
   */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.editorContainer) return;

    if (Date.now() < this.ignoreOutsideUntil) return;
    
    const target = event.target as HTMLElement;
    const editorEl = this.editorContainer.nativeElement;
    
    // 如果点击在编辑器外部，保存并关闭
    if (editorEl && !editorEl.contains(target)) {
      this.saveAndClose();
    }
  }

  /**
   * 监听全局触摸事件（移动端）
   */
  @HostListener('document:touchstart', ['$event'])
  onDocumentTouchStart(event: TouchEvent): void {
    if (!this.editorContainer) return;

    if (Date.now() < this.ignoreOutsideUntil) return;
    
    const target = event.target as HTMLElement;
    const editorEl = this.editorContainer.nativeElement;
    
    // 如果触摸在编辑器外部，保存并关闭
    if (editorEl && !editorEl.contains(target)) {
      this.saveAndClose();
    }
  }

  /**
   * 进入编辑模式
   */
  enterEditMode(): void {
    this.isEditMode.set(true);
    // 延迟聚焦，确保 textarea 已渲染
    setTimeout(() => {
      if (this.descInput) {
        this.descInput.nativeElement.focus();
        // 自动调整高度
        this.autoResizeTextarea(this.descInput.nativeElement);
      }
    }, 50);
  }

  /**
   * 退出编辑模式
   */
  exitEditMode(): void {
    this.isEditMode.set(false);
    // 保存内容
    this.saveContent();
  }

  /**
   * textarea 失焦处理
   * 只有当焦点移到编辑器外部时才退出编辑模式
   */
  onTextareaBlur(event: FocusEvent): void {
    // 获取新的焦点元素
    const relatedTarget = event.relatedTarget as HTMLElement;
    
    // 延迟检查，给浏览器时间处理焦点转移
    setTimeout(() => {
      if (!this.isEditMode()) return;
      if (!this.editorContainer) return;
      
      const editorEl = this.editorContainer.nativeElement;
      const activeElement = document.activeElement;
      
      // 如果焦点仍在编辑器内部（包括 textarea 重新获得焦点的情况），不退出编辑模式
      if (editorEl && (editorEl.contains(activeElement) || editorEl.contains(relatedTarget))) {
        return;
      }
      
      // 焦点移到编辑器外部，退出编辑模式
      this.exitEditMode();
    }, 150);
  }

  /**
   * 描述内容变化时实时保存
   */
  onDescriptionChange(value: string): void {
    this.editingDescription = value;
    
    // 自动调整高度
    if (this.descInput) {
      this.autoResizeTextarea(this.descInput.nativeElement);
    }
    
    // 防抖保存
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveContent();
    }, 500);
  }

  /**
   * 保存内容
   */
  private saveContent(): void {
    const data = this.data();
    if (data && this.editingDescription !== data.description) {
      this.save.emit(this.editingDescription);
    }
  }

  /**
   * 保存并关闭
   */
  private saveAndClose(): void {
    // 先保存
    this.saveContent();
    // 再关闭
    this.close.emit();
  }

  /**
   * 压缩显示ID
   */
  compressDisplayId(displayId: string | undefined): string {
    if (!displayId) return '';
    if (displayId.length > 6) {
      return displayId.substring(0, 5) + '..';
    }
    return displayId;
  }

  /**
   * 删除按钮点击处理
   */
  onDeleteClick(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.delete.emit();
  }

  onDragStart(event: MouseEvent | TouchEvent): void {
    event.preventDefault();
    this.dragStart.emit(event);
  }

  private autoResizeTextarea(textarea: HTMLTextAreaElement): void {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(80, Math.max(24, textarea.scrollHeight)) + 'px';
  }
}
