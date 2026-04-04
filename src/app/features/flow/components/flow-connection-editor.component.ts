import { Component, ChangeDetectionStrategy, input, output, signal, ElementRef, ViewChild, computed, OnInit, OnDestroy, HostListener, effect, inject, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { COMPOSITION_BUFFER_MODE, FormsModule } from '@angular/forms';
import { Task } from '../../../../models';
import type { ConnectionEditorMode } from '../../../../models/flow-view-state';
import { SafeMarkdownPipe } from '../../../shared/pipes/safe-markdown.pipe';
import { LoggerService } from '../../../../services/logger.service';

export interface ConnectionEditorData {
  sourceId: string;
  targetId: string;
  /** 联系块标题（外显内容） */
  title: string;
  /** 联系块详细描述 */
  description: string;
  /** 当前打开的是跨树关联还是父子关系 */
  isCrossTree: boolean;
  /** 当前浮层模式：预览或编辑 */
  mode: ConnectionEditorMode;
  x: number;
  y: number;
}

export interface ConnectionTasks {
  source: Task | null;
  target: Task | null;
}

export interface ConnectionEditorSavePayload {
  sourceId: string;
  targetId: string;
  title: string;
  description: string;
}

type ConnectionEditorSaveContext = Pick<ConnectionEditorData, 'sourceId' | 'targetId' | 'title' | 'description'>;

/**
 * 联系块编辑器组件
 * 浮动在连接线附近，可拖动，用于编辑连接标题和描述
 * 
 * 设计思路（类似维基百科悬浮预览）：
 * - 默认预览模式，显示标题和描述
 * - 点击进入编辑模式
 * - 标题用于外显（流程图上显示）
 * - 描述用于详细说明（悬停/点击时显示）
 */
@Component({
  selector: 'app-flow-connection-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, SafeMarkdownPipe],
  providers: [{ provide: COMPOSITION_BUFFER_MODE, useValue: false }],
  template: `
    @if (data(); as connData) {
      <div class="fixed z-[100] animate-scale-in"
           #editorContainer
           [style.left.px]="clampedPosition().x"
           [style.top.px]="clampedPosition().y">
        <div class="bg-white dark:bg-stone-900 rounded-lg shadow-xl border border-violet-200 dark:border-violet-800 overflow-hidden w-52 max-w-[calc(100vw-1.5rem)]"
             (click)="$event.stopPropagation()">
          <!-- 可拖动标题栏 - 整个标题栏都可拖动 -->
          <div class="px-2 py-1.5 bg-gradient-to-r from-violet-50 to-indigo-50 dark:from-violet-900/30 dark:to-indigo-900/30 border-b border-violet-100 dark:border-violet-800 flex items-center gap-1.5 cursor-move select-none"
               (mousedown)="onDragStart($event)"
               (touchstart)="onDragStart($event)">
            <span class="text-[10px]">{{ isParentChildLink() ? '🔀' : '🔗' }}</span>
            <span class="text-[10px] font-medium text-violet-700 dark:text-violet-300 flex-1">
              {{ isParentChildLink() ? '父子关系' : '跨树连接' }}
            </span>
            @if (!readOnly()) {
              <!-- 删除按钮 -->
              <button 
                (click)="onDeleteClick($event)"
                (touchend)="onDeleteClick($event)"
                class="text-stone-400 hover:text-red-500 p-0.5 transition-colors"
                [title]="isParentChildLink() ? '解除关系' : '删除连接'">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            }
            <span class="text-[8px] text-violet-300 ml-0.5">☰</span>
          </div>
          
          <!-- 连接的两个任务 + 模式切换 - 超紧凑显示 -->
          <div class="px-2 py-1 bg-stone-50/50 dark:bg-stone-800/50 border-b border-stone-100 dark:border-stone-700">
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
              <!-- 预览/编辑模式切换按钮（仅跨树连接显示） -->
              @if (!isParentChildLink() && !readOnly()) {
                <button 
                  (click)="toggleEditMode(); $event.stopPropagation()"
                  class="ml-auto text-[8px] px-1 py-0.5 rounded transition-colors"
                  [ngClass]="{
                    'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300': isEditMode(),
                    'bg-stone-100 dark:bg-stone-700 text-stone-500 dark:text-stone-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20': !isEditMode()
                  }">
                  {{ isEditMode() ? '预览' : '编辑' }}
                </button>
              }
            </div>
          </div>
          
          <!-- 标题和描述区域 -->
          <div class="px-2 py-1.5 space-y-2">
            @if (isParentChildLink()) {
              <!-- 父子连接：只读模式，显示说明 -->
              <div class="text-[10px] text-stone-600 dark:text-stone-300 px-1.5 py-2 rounded bg-stone-50 dark:bg-stone-800/50 border border-stone-200 dark:border-stone-700">
                <div class="flex items-start gap-1.5 mb-2">
                  <span class="text-[12px]">ℹ️</span>
                  <div class="flex-1">
                    <p class="font-medium text-stone-700 dark:text-stone-200 mb-1">父子关系</p>
                    <p class="text-stone-500 dark:text-stone-400">这是树形结构的父子关系，不支持自定义标题和描述。</p>
                  </div>
                </div>
                <div class="mt-2 pt-2 border-t border-stone-200 dark:border-stone-700">
                  <p class="text-[9px] text-amber-600 dark:text-amber-400 flex items-center gap-1">
                    <span>⚠️</span>
                    <span>解除关系后，子任务将移到"待分配"区域</span>
                  </p>
                </div>
              </div>
            } @else {
              <!-- 跨树连接：支持编辑标题和描述 -->
              @if (isEditMode()) {
                <!-- 编辑模式 -->
                <!-- 标题输入 -->
                <div>
                  <label class="text-[9px] text-stone-400 dark:text-stone-500 font-medium block mb-0.5">标题（外显）</label>
                  <input 
                    #titleInput
                    type="text"
                    [(ngModel)]="editingTitle"
                    (ngModelChange)="onTitleChange($event)"
                    (compositionstart)="onCompositionStart('title')"
                    (compositionend)="onCompositionEnd('title')"
                    (keydown.escape)="exitEditMode()"
                    (blur)="onInputBlur($event)"
                    spellcheck="false"
                    class="w-full text-[11px] text-stone-700 dark:text-stone-200 border border-violet-300 dark:border-violet-600 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-violet-400 dark:focus:ring-violet-500 bg-white dark:bg-stone-800"
                    placeholder="输入关联标题..."
                    maxlength="20">
                </div>
                <!-- 描述输入 -->
                <div>
                  <label class="text-[9px] text-stone-400 dark:text-stone-500 font-medium block mb-0.5">描述（悬停显示）</label>
                  <textarea 
                    #descInput
                    [(ngModel)]="editingDescription"
                    (ngModelChange)="onDescriptionChange($event)"
                    (compositionstart)="onCompositionStart('description')"
                    (compositionend)="onCompositionEnd('description')"
                    (keydown.escape)="exitEditMode()"
                    (blur)="onInputBlur($event)"
                    (mousedown)="isSelecting = true"
                    (mouseup)="isSelecting = false"
                    spellcheck="false"
                    class="w-full text-[11px] text-stone-700 dark:text-stone-200 border border-violet-300 dark:border-violet-600 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-violet-400 dark:focus:ring-violet-500 bg-white dark:bg-stone-800 resize-none font-mono"
                    placeholder="输入详细描述（支持 Markdown）..."
                    [style.min-height.px]="48"
                    [style.max-height.px]="100"></textarea>
                </div>
              } @else {
                <!-- 预览模式 -->
                <div 
                  class="text-[11px] text-stone-600 dark:text-stone-300 min-h-[48px] px-1.5 py-1 rounded border border-transparent transition-colors max-h-28 overflow-y-auto"
                  [ngClass]="readOnly()
                    ? 'cursor-default'
                    : 'cursor-pointer hover:border-stone-200 dark:hover:border-stone-700'"
                  (click)="onPreviewClick($event)">
                  <!-- 标题 -->
                  @if (currentTitle()) {
                    <div class="font-medium text-violet-700 dark:text-violet-300 mb-1 flex items-center gap-1">
                      <span class="text-[10px]">📌</span>
                      <span>{{ currentTitle() }}</span>
                    </div>
                  }
                  <!-- 描述 -->
                  @if (currentDescription()) {
                    <div class="markdown-preview leading-relaxed text-stone-600 dark:text-stone-300" [innerHTML]="currentDescription() | safeMarkdown:'raw'"></div>
                  } @else if (!currentTitle()) {
                    <span class="text-stone-400 dark:text-stone-500 italic">
                      {{ readOnly() ? '会话确认完成后可编辑标题和描述...' : '点击添加标题和描述...' }}
                    </span>
                  } @else {
                    <span class="text-stone-400 dark:text-stone-500 italic text-[10px]">无描述</span>
                  }
                </div>
              }
            }
          </div>
        </div>
      </div>
    }
  `
})
export class FlowConnectionEditorComponent implements OnInit, OnDestroy {
  @ViewChild('descInput') descInput!: ElementRef<HTMLTextAreaElement>;
  @ViewChild('titleInput') titleInput!: ElementRef<HTMLInputElement>;
  @ViewChild('editorContainer') editorContainer!: ElementRef<HTMLDivElement>;

  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ConnectionEditor');

  readonly data = input<ConnectionEditorData | null>(null);
  readonly position = input<{ x: number; y: number }>({ x: 0, y: 0 });
  readonly readOnly = input(false);
  readonly connectionTasks = input<ConnectionTasks>({ source: null, target: null });
  
  readonly close = output<void>();
  /** 保存事件：发送 { sourceId, targetId, title, description } */
  readonly save = output<ConnectionEditorSavePayload>();
  readonly modeChange = output<ConnectionEditorMode>();
  readonly delete = output<void>();
  readonly positionChange = output<{ x: number; y: number }>();
  readonly dragStart = output<MouseEvent | TouchEvent>();
  
  // 编辑模式状态（默认预览模式）
  readonly isEditMode = signal(false);
  
  // 判断是否为父子连接（否则为跨树连接）
  readonly isParentChildLink = computed(() => {
    const data = this.data();
    if (!data) return false;
    return !data.isCrossTree;
  });
  
  // 当前编辑的标题和描述
  editingTitle = '';
  editingDescription = '';
  
  // 防抖保存定时器
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private focusTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSessionKey: string | null = null;
  private lastEmittedPayloadKey: string | null = null;
  private activeSessionContext: ConnectionEditorSaveContext | null = null;

  // 防止"打开编辑器的同一次点击"触发 document:click 立即关闭
  private ignoreOutsideUntil = 0;
  private closeRequested = false;
  private deleteRequested = false;
  
  // 标记是否正在进行文本选择
  private isSelecting = false;
  private readonly composingState: Record<'title' | 'description', boolean> = {
    title: false,
    description: false,
  };

  // 当 data 变化时：按会话/模式精细同步，避免移动端误吞外部点击
  private readonly dataSyncEffect = effect(() => {
    const data = this.data();
    const readOnly = this.readOnly();
    const previousSessionKey = this.lastSessionKey;
    const previousContext = this.activeSessionContext;

    if (!data) {
      if (previousSessionKey && previousContext && !this.closeRequested && !this.deleteRequested) {
        this.persistCurrentEdits(previousContext);
      }

      this.activeSessionContext = null;
      this.lastSessionKey = null;
      this.lastEmittedPayloadKey = null;
      this.closeRequested = false;
      this.deleteRequested = false;
      return;
    }

    const sessionKey = `${data.sourceId}->${data.targetId}@${data.x},${data.y}`;
    const isNewSession = previousSessionKey !== sessionKey;
    const nextIsEditMode = data.mode === 'edit' && !readOnly;
    const currentIsEditMode = untracked(() => this.isEditMode());
    const shouldRefreshOutsideGuard = isNewSession || (!currentIsEditMode && nextIsEditMode);

    if (shouldRefreshOutsideGuard) {
      this.ignoreOutsideUntil = Date.now() + 200;
    }

    if (previousSessionKey && previousContext && isNewSession && !this.closeRequested && !this.deleteRequested) {
      this.persistCurrentEdits(previousContext);
    }

    // 仅在新会话时初始化 activeSessionContext
    // 同一会话内编辑模式下不更新，避免服务层回流后覆盖原始值，导致最终保存被跳过
    if (isNewSession) {
      this.activeSessionContext = {
        sourceId: data.sourceId,
        targetId: data.targetId,
        title: data.title || '',
        description: data.description || '',
      };
    }

    if (isNewSession) {
      this.editingTitle = data.title || '';
      this.editingDescription = data.description || '';
      this.isEditMode.set(nextIsEditMode);
      this.closeRequested = false;
      this.deleteRequested = false;
      this.lastEmittedPayloadKey = null;

      if (nextIsEditMode) {
        this.scheduleFocusInput();
      }
    } else {
      const modeChanged = currentIsEditMode !== nextIsEditMode;

      if (modeChanged) {
        if (currentIsEditMode && !nextIsEditMode && !this.closeRequested && !this.deleteRequested) {
          if (readOnly) {
            this.editingTitle = data.title || '';
            this.editingDescription = data.description || '';
            this.lastEmittedPayloadKey = null;
          } else {
            // 父层强制 edit -> preview 时，先保存输入框里最后可见值（含 IME 末尾字符）
            this.persistCurrentEdits(previousContext ?? undefined);
          }
          // 防止同一次外部点击在预览态分支被当作“点击外部关闭”处理
          this.ignoreOutsideUntil = Date.now() + 220;
        }
        this.isEditMode.set(nextIsEditMode);
        if (currentIsEditMode && !nextIsEditMode && readOnly) {
          this.modeChange.emit('preview');
        }
        if (nextIsEditMode) {
          this.scheduleFocusInput();
        }
      }

      if (nextIsEditMode) {
        this.lastSessionKey = sessionKey;
        if (this.lastEmittedPayloadKey === this.buildPayloadKey(data.sourceId, data.targetId, data.title || '', data.description || '')) {
          this.lastEmittedPayloadKey = null;
        }
        return;
      }

      // 非编辑态同步服务层内容；若刚从编辑态被父层切回预览，保留本地最新值等待父层回流
      // 或者有待确认的保存操作（lastEmittedPayloadKey 已设置），也不覆盖本地值
      const skipSyncFromService = 
        (modeChanged && currentIsEditMode && !nextIsEditMode) ||
        (this.lastEmittedPayloadKey !== null);
      
      if (!skipSyncFromService) {
        this.editingTitle = data.title || '';
        this.editingDescription = data.description || '';
      }
    }

    this.lastSessionKey = sessionKey;
    if (this.lastEmittedPayloadKey === this.buildPayloadKey(data.sourceId, data.targetId, data.title || '', data.description || '')) {
      this.lastEmittedPayloadKey = null;
    }
  });
  
  // 计算当前标题（优先显示编辑中的内容）
  readonly currentTitle = computed(() => {
    const data = this.data();
    return this.editingTitle || data?.title || '';
  });
  
  // 计算当前描述（优先显示编辑中的内容）
  readonly currentDescription = computed(() => {
    const data = this.data();
    return this.editingDescription || data?.description || '';
  });
  
  // 计算限制在视口内的位置（已由服务端处理，这里做兜底）
  readonly clampedPosition = computed(() => {
    const pos = this.position();
    const editorWidth = 208; // w-52 = 13rem = 208px
    const editorHeight = 180; // 估算高度（更高，因为增加了标题）
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
    if (this.focusTimer) {
      clearTimeout(this.focusTimer);
      this.focusTimer = null;
    }
  }

  /**
   * 监听全局点击事件
   * - 编辑模式下，点击空白区域或外部时，退出编辑模式并保存
   * - 非编辑模式下，点击外部时关闭编辑器
   */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.closeRequested) return;
    if (!this.editorContainer) return;
    if (Date.now() < this.ignoreOutsideUntil) return;
    
    // 如果正在进行文本选择，不处理
    if (this.isSelecting) return;
    
    // 检查是否有文本被选中
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) {
      return;
    }
    
    const target = event.target as HTMLElement;
    const editorEl = this.editorContainer.nativeElement;
    const clickedInside = editorEl && editorEl.contains(target);
    
    if (this.isEditMode()) {
      // 编辑模式下的处理
      // 检查是否点击了可交互元素（输入框、按钮等）
      const isInteractiveElement = clickedInside && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'BUTTON' ||
        target.tagName === 'svg' ||
        target.tagName === 'path' ||
        target.closest('input, textarea, button, svg') !== null
      );
      
      if (isInteractiveElement) {
        this.logger.debug('点击可交互元素，保持编辑模式');
        return;
      }
      
       if (clickedInside) {
         // 点击在编辑器内部但不是可交互元素（如标题栏、空白区域），退出编辑模式
         this.logger.debug('点击编辑器空白区域，退出编辑模式');
         this.exitEditMode();
       } else {
         // 点击在编辑器外部，保存并关闭编辑器
         this.logger.debug('点击编辑器外部，保存并关闭');
         this.saveAndClose();
       }
     } else {
       // 预览模式下，点击外部关闭编辑器
       // 但如果刚从编辑模式切换过来，需要等待保护期结束
       if (!clickedInside && Date.now() >= this.ignoreOutsideUntil) {
         this.saveAndClose();
       }
     }
   }

  /**
   * 监听全局触摸事件（移动端）
   * - 编辑模式下，触摸空白区域或外部时，退出编辑模式并保存
   * - 非编辑模式下，触摸外部时关闭编辑器
   * - 使用延迟处理确保 IME 输入完成后再保存
   */
  @HostListener('document:touchstart', ['$event'])
  onDocumentTouchStart(event: TouchEvent): void {
    if (this.closeRequested) return;
    if (!this.editorContainer) return;
    if (Date.now() < this.ignoreOutsideUntil) return;
    
    // 如果正在进行文本选择，不处理
    if (this.isSelecting) return;
    
    // 检查是否有文本被选中
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) {
      return;
    }
    
    const target = event.target as HTMLElement;
    const editorEl = this.editorContainer.nativeElement;
    const clickedInside = editorEl && editorEl.contains(target);
    
    // 在事件开始时捕获当前模式状态，防止 GoJS backgroundClick 事件先修改模式导致竞争条件
    const wasEditMode = this.isEditMode();
    
    // 如果正在 IME 输入中，使用更长的延迟等待 compositionend
    const delayMs = this.isComposing() ? 100 : 50;
    if (this.isComposing()) {
      this.logger.debug('正在 IME 输入中，使用更长延迟处理触摸事件');
    }
    
    if (wasEditMode) {
      // 编辑模式下的处理
      const isInteractiveElement = clickedInside && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'BUTTON' ||
        target.tagName === 'svg' ||
        target.tagName === 'path' ||
        target.closest('input, textarea, button, svg') !== null
      );
      
      if (isInteractiveElement) {
        this.logger.debug('触摸可交互元素，保持编辑模式');
        return;
      }
      
       if (clickedInside) {
         // 触摸在编辑器内部但不是可交互元素，退出编辑模式
         this.logger.debug('触摸编辑器空白区域，退出编辑模式');
        // 使用延迟确保 blur 事件先完成
        setTimeout(() => {
          if (!this.closeRequested) {
            this.exitEditMode();
          }
        }, delayMs);
       } else {
         // 触摸在编辑器外部，保存并切换到预览模式（不是关闭）
         // 这样用户可以看到保存后的内容，需要再次点击外部才会关闭
         this.logger.debug('触摸编辑器外部，保存并切换到预览模式');
         setTimeout(() => {
           if (!this.closeRequested) {
             this.exitEditMode();
           }
         }, delayMs);
       }
    } else {
      // 预览模式下，触摸外部关闭编辑器
      // 但如果刚从编辑模式切换过来，需要等待保护期结束
      if (!clickedInside && Date.now() >= this.ignoreOutsideUntil) {
        this.saveAndClose();
      }
    }
  }

  /**
   * 切换编辑模式
   */
  toggleEditMode(): void {
    const newMode = !this.isEditMode();
    this.logger.debug(`toggleEditMode: 当前模式 = ${this.isEditMode()} → 新模式 = ${newMode}`);
    if (newMode) {
      this.enterEditMode();
    } else {
      this.exitEditMode();
    }
  }
  
  /**
   * 进入编辑模式
   */
  enterEditMode(): void {
    if (this.isEditMode() || this.readOnly()) {
      return;
    }
    this.isEditMode.set(true);
    this.modeChange.emit('edit');
    this.scheduleFocusInput();
  }

  onPreviewClick(event: Event): void {
    event.stopPropagation();
    this.enterEditMode();
  }

  /**
   * 退出编辑模式
   * 注意：必须先同步 DOM 状态再切换模式，否则输入框被销毁后无法获取最新值
   */
  exitEditMode(): void {
    if (!this.isEditMode()) {
      return;
    }
    // 先同步 DOM 状态（此时输入框还存在）
    this.syncEditorStateFromDom();
    // 先保存，再切回预览，确保预览内容立即显示新值
    // 使用 activeSessionContext 作为比较基准，避免 debounced save 更新信号后跳过最终保存
    this.persistCurrentEdits(this.activeSessionContext ?? undefined);
    this.isEditMode.set(false);
    this.modeChange.emit('preview');
  }

  onCompositionStart(field: 'title' | 'description'): void {
    this.composingState[field] = true;
  }

  onCompositionEnd(field: 'title' | 'description'): void {
    this.composingState[field] = false;
    this.lastEmittedPayloadKey = null;
    this.syncEditorStateFromDom();
    this.scheduleDebouncedSave();
  }

  /**
   * 检查是否有任何字段正在 IME 输入中
   */
  private isComposing(): boolean {
    return this.composingState.title || this.composingState.description;
  }

  /**
   * 输入框失焦处理（标题和描述通用）
   * 1. 立即同步 DOM 状态到编辑器状态
   * 2. 延迟检查焦点位置，如果移到编辑器外部则退出编辑模式并保存
   */
  onInputBlur(event: FocusEvent): void {
    // 立即同步 DOM 值，确保在关闭前获取最新输入
    this.syncEditorStateFromDom();
    
    // 获取新的焦点元素
    const relatedTarget = event.relatedTarget as HTMLElement;
    
    // 延迟检查，给浏览器时间处理焦点转移
    setTimeout(() => {
      if (!this.isEditMode()) return;
      if (!this.editorContainer) return;
      if (this.closeRequested) return;
      
      const editorEl = this.editorContainer.nativeElement;
      const activeElement = document.activeElement;
      
      // 如果焦点仍在编辑器内部（包括 textarea/input 重新获得焦点的情况），不退出编辑模式
      if (editorEl && (editorEl.contains(activeElement) || editorEl.contains(relatedTarget))) {
        return;
      }
      
      // 焦点移到编辑器外部，退出编辑模式并保存
      this.exitEditMode();
    }, 100);
  }

  /**
   * 标题内容变化时实时保存
   */
  onTitleChange(value: string): void {
    this.editingTitle = value;
    this.lastEmittedPayloadKey = null;
    this.scheduleDebouncedSave();
  }

  /**
   * 描述内容变化时实时保存
   */
  onDescriptionChange(value: string): void {
    this.editingDescription = value;
    this.lastEmittedPayloadKey = null;
    
    // 自动调整高度
    if (this.descInput) {
      this.autoResizeTextarea(this.descInput.nativeElement);
    }

    this.scheduleDebouncedSave();
  }

  /**
   * 保存内容（标题和描述）
   */
  private saveContent(contextOverride?: ConnectionEditorSaveContext): void {
    const context = this.getSaveContext(contextOverride);
    if (!context) {
      return;
    }

    const payload = this.syncEditorStateFromDom();
    
    if (payload.title === context.title && payload.description === context.description) {
      return;
    }

    const payloadKey = this.buildPayloadKey(context.sourceId, context.targetId, payload.title, payload.description);
    if (payloadKey === this.lastEmittedPayloadKey) {
      return;
    }

    this.lastEmittedPayloadKey = payloadKey;
    this.save.emit({
      sourceId: context.sourceId,
      targetId: context.targetId,
      title: payload.title,
      description: payload.description,
    });
  }

  /**
   * 保存并关闭
   * 如果正在 IME 输入中，等待 compositionend 后再保存
   * 
   * 使用 activeSessionContext 作为保存上下文，确保最终保存总是与会话开始时的原始值比较，
   * 避免中间的 debounced save 更新了 connectionEditorData 后导致最终保存被跳过。
   */
  private saveAndClose(): void {
    if (this.closeRequested) return;
    this.closeRequested = true;
    this.ignoreOutsideUntil = Date.now() + 250;

    // 立即从 DOM 读取最新值（此时输入框还存在）
    this.syncEditorStateFromDom();
    
    // 如果正在 IME 输入中，延迟保存以等待 compositionend
    if (this.isComposing()) {
      this.logger.debug('IME 输入中，延迟保存');
      setTimeout(() => {
        this.syncEditorStateFromDom();
        this.persistCurrentEdits(this.activeSessionContext ?? undefined);
        this.close.emit();
      }, 100);
    } else {
      this.persistCurrentEdits(this.activeSessionContext ?? undefined);
      this.close.emit();
    }
  }

  private persistCurrentEdits(context?: ConnectionEditorSaveContext): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.syncEditorStateFromDom();
    this.saveContent(context);
  }

  private scheduleDebouncedSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveContent();
    }, 500);
  }

  private syncEditorStateFromDom(): { title: string; description: string } {
    const liveTitle = this.titleInput?.nativeElement?.value ?? this.editingTitle;
    const liveDescription = this.descInput?.nativeElement?.value ?? this.editingDescription;

    this.editingTitle = liveTitle;
    this.editingDescription = liveDescription;

    if (this.descInput?.nativeElement) {
      this.autoResizeTextarea(this.descInput.nativeElement);
    }

    return {
      title: liveTitle,
      description: liveDescription,
    };
  }

  private buildPayloadKey(sourceId: string, targetId: string, title: string, description: string): string {
    return `${sourceId}->${targetId}|${title}|${description}`;
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
    if (this.readOnly()) {
      return;
    }
    this.logger.debug('删除按钮被点击');
    // 设置忽略外部点击的保护窗口，防止 document:click 立即关闭编辑器
    this.ignoreOutsideUntil = Date.now() + 300;
    this.deleteRequested = true;
    this.delete.emit();
  }

  onDragStart(event: MouseEvent | TouchEvent): void {
    event.preventDefault();
    this.dragStart.emit(event);
  }

  private autoResizeTextarea(textarea: HTMLTextAreaElement): void {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(100, Math.max(48, textarea.scrollHeight)) + 'px';
  }

  private scheduleFocusInput(): void {
    if (this.focusTimer) {
      clearTimeout(this.focusTimer);
    }

    // 延迟聚焦，确保输入控件已渲染
    this.focusTimer = setTimeout(() => {
      const input = this.titleInput?.nativeElement ?? this.descInput?.nativeElement;
      if (input) {
        input.focus();
      }

      if (this.descInput?.nativeElement) {
        this.autoResizeTextarea(this.descInput.nativeElement);
      }

      this.focusTimer = null;
    }, 50);
  }

  private getSaveContext(override?: ConnectionEditorSaveContext): ConnectionEditorSaveContext | null {
    if (override) {
      return override;
    }

    const data = this.data();
    if (data) {
      return {
        sourceId: data.sourceId,
        targetId: data.targetId,
        title: data.title || '',
        description: data.description || '',
      };
    }

    return this.activeSessionContext;
  }
  
}
