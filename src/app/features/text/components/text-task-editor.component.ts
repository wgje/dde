import { Component, inject, input, output, signal, ChangeDetectionStrategy, ChangeDetectorRef, ElementRef, HostListener, effect, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { ChangeTrackerService } from '../../../../services/change-tracker.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService, TaskConnectionInfo } from '../../../../services/project-state.service';
import { AttachmentService } from '../../../../services/attachment.service';
import { ToastService } from '../../../../services/toast.service';
import { Task, Attachment } from '../../../../models';
import { SafeMarkdownPipe } from '../../../shared/pipes/safe-markdown.pipe';
import { TextTaskConnectionsComponent } from './text-task-connections.component';
import { toggleMarkdownTodo, getTodoIndexFromClick } from '../../../../utils/markdown';

/**
 * 浠诲姟缂栬緫鍣ㄧ粍浠讹紙灞曞紑鎬侊級
 * 鏄剧ず浠诲姟鐨勫畬鏁寸紪杈戠晫闈紝鍖呮嫭鏍囬銆佸唴瀹广€佸緟鍔炪€侀檮浠跺拰鎿嶄綔鎸夐挳
 *
 * 棰勮妯″紡閫昏緫锛? * - 榛樿杩涘叆缂栬緫鐘舵€佹椂涓洪瑙堟ā寮? * - 鐐瑰嚮棰勮鍖哄煙杩涘叆缂栬緫妯″紡
 * - 鐐瑰嚮绌虹櫧鍖哄煙锛堢粍浠跺閮級鑷姩鍒囨崲鍥為瑙堟ā寮? * - 棰勮妯″紡涓嬮殣钘忓簳閮ㄦ搷浣滄寜閽紙娣诲姞鍚岀骇銆佹坊鍔犱笅绾с€佸垹闄わ級
 */
@Component({
  selector: 'app-text-task-editor',
  standalone: true,
  imports: [CommonModule, SafeMarkdownPipe, TextTaskConnectionsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="animate-collapse-open"
         (click)="$event.stopPropagation()"
         [ngClass]="{'mt-2 flex gap-3': !isMobile(), 'mt-1.5': isMobile()}">

      <!-- 涓荤紪杈戝尯鍩?-->
      <div [ngClass]="{'flex-1 min-w-0 space-y-2': !isMobile(), 'space-y-1.5': isMobile()}">

          <!-- 鏍囬缂栬緫 -->
        <input
          #titleInput
          data-title-input
          type="text"
          [value]="localTitle()"
          (input)="onTitleInput(titleInput.value)"
          (focus)="onInputFocus('title')"
          (blur)="onInputBlur('title')"
          (mousedown)="isSelecting = true"
          (mouseup)="isSelecting = false"
          spellcheck="false"
          class="w-full font-medium text-retro-dark dark:text-stone-200 border rounded-lg focus:ring-1 focus:ring-stone-400 dark:focus:ring-stone-500 focus:border-stone-400 dark:focus:border-stone-500 outline-none touch-manipulation transition-colors"
          [ngClass]="{
            'text-sm p-2': !isMobile(),
            'text-xs p-1.5': isMobile(),
            'bg-retro-muted/5 dark:bg-stone-800 border-retro-muted/20 dark:border-stone-700': isPreview(),
            'bg-white dark:bg-stone-700 border-stone-200 dark:border-stone-600': !isPreview()
          }"
          placeholder="浠诲姟鍚嶇О...">

        <!-- 鍐呭缂栬緫/棰勮 -->
        <div class="relative">
          <!-- 棰勮/缂栬緫鍒囨崲鎸夐挳 -->
          <div class="absolute top-1.5 right-1.5 z-10 flex gap-1">
            <button
              (click)="togglePreview(); $event.stopPropagation()"
              class="px-1.5 py-0.5 text-[9px] rounded transition-all opacity-70 hover:opacity-100"
              [ngClass]="{
                'bg-indigo-500 dark:bg-indigo-600 text-white': isPreview(),
                'bg-stone-200 dark:bg-stone-600 text-stone-500 dark:text-stone-300 hover:bg-stone-300 dark:hover:bg-stone-500': !isPreview()
              }"
              title="鍒囨崲棰勮/缂栬緫">
              {{ isPreview() ? '缂栬緫' : '棰勮' }}
            </button>
          </div>

          @if (isPreview()) {
            <!-- Markdown 棰勮 - 鐐瑰嚮鍒囨崲鍒扮紪杈戞ā寮忥紝鐐瑰嚮 checkbox 鍒囨崲寰呭姙鐘舵€?-->
            <div
              (click)="onPreviewClick($event)"
              class="w-full border border-retro-muted/20 dark:border-stone-700 rounded-lg bg-retro-muted/5 dark:bg-stone-800 overflow-y-auto overflow-x-hidden markdown-preview cursor-pointer hover:border-stone-300 dark:hover:border-stone-600 transition-colors"
              [ngClass]="{'min-h-24 max-h-48 p-3 text-xs': !isMobile(), 'min-h-28 max-h-40 p-2 text-[11px]': isMobile()}"
              [innerHTML]="localContent() ? (localContent() | safeMarkdown) : '<span class=&quot;text-stone-400 italic&quot;>鐐瑰嚮杈撳叆鍐呭...</span>'"
              title="鐐瑰嚮缂栬緫">
            </div>
          } @else {
            <!-- Markdown 缂栬緫 -->
            <textarea
              #contentInput
              [value]="localContent()"
              (input)="onContentInput(contentInput.value)"
              (focus)="onInputFocus('content')"
              (blur)="onInputBlur('content')"
              (mousedown)="isSelecting = true"
              (mouseup)="isSelecting = false"
              spellcheck="false"
              class="w-full border border-stone-200 dark:border-stone-600 rounded-lg focus:ring-1 focus:ring-stone-400 dark:focus:ring-stone-500 focus:border-stone-400 dark:focus:border-stone-500 outline-none font-mono text-stone-600 dark:text-stone-400 bg-white dark:bg-stone-700 resize-none touch-manipulation"
              [ngClass]="{'h-24 text-xs p-2 pr-14': !isMobile(), 'h-28 text-[11px] p-2 pr-14': isMobile()}"
              placeholder="杈撳叆 Markdown 鍐呭..."></textarea>
          }
        </div>

        <!-- 蹇€熷緟鍔炶緭鍏?- 浠呭湪缂栬緫妯″紡涓嬫樉绀?-->
        @if (!isPreview()) {
          <div class="flex items-center gap-1 bg-retro-rust/5 dark:bg-retro-rust/10 border border-retro-rust/20 dark:border-retro-rust/30 rounded-lg overflow-hidden"
               [ngClass]="{'p-1': !isMobile(), 'p-0.5': isMobile()}">
            <span class="text-retro-rust flex-shrink-0"
                  [ngClass]="{'text-xs pl-2': !isMobile(), 'text-[10px] pl-1.5': isMobile()}">鈽?/span>
            <input
              #quickTodoInput
              type="text"
              (keydown.enter)="addQuickTodo(quickTodoInput)"
              (focus)="onInputFocus('todo')"
              (blur)="onInputBlur('todo')"
              (mousedown)="isSelecting = true"
              (mouseup)="isSelecting = false"
              spellcheck="false"
              class="flex-1 bg-transparent border-none outline-none text-stone-600 dark:text-stone-400 placeholder-stone-400 dark:placeholder-stone-500"
              [ngClass]="{'text-xs py-1.5 px-2': !isMobile(), 'text-[11px] py-1 px-1.5': isMobile()}"
              placeholder="杈撳叆寰呭姙鍐呭锛屾寜鍥炶溅娣诲姞...">
            <button
              (click)="addQuickTodo(quickTodoInput)"
              class="flex-shrink-0 bg-retro-rust/10 hover:bg-retro-rust text-retro-rust hover:text-white rounded transition-all flex items-center justify-center"
              [ngClass]="{'p-1.5 mr-0.5': !isMobile(), 'p-1 mr-0.5': isMobile()}"
              title="娣诲姞寰呭姙">
              <svg [ngClass]="{'w-3.5 h-3.5': !isMobile(), 'w-3 h-3': isMobile()}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </button>
          </div>
        }

        @if (!isPreview()) {
          <div class="grid grid-cols-3 gap-2">
            <input
              type="number"
              #expectedMinutesInput
              min="1"
              [value]="localExpectedMinutes()"
              (input)="onExpectedMinutesChange(expectedMinutesInput.value)"
              class="w-full text-[11px] px-2 py-1.5 rounded border border-stone-200 dark:border-stone-600 bg-white dark:bg-stone-700 text-stone-700 dark:text-stone-300"
              placeholder="预计(min)">
            <select
              #cognitiveLoadSelect
              [value]="localCognitiveLoad()"
              (change)="onCognitiveLoadChange(cognitiveLoadSelect.value)"
              class="w-full text-[11px] px-2 py-1.5 rounded border border-stone-200 dark:border-stone-600 bg-white dark:bg-stone-700 text-stone-700 dark:text-stone-300">
              <option value="">负荷未设</option>
              <option value="low">低负荷</option>
              <option value="high">高负荷</option>
            </select>
            <input
              type="number"
              #waitMinutesInput
              min="1"
              [value]="localWaitMinutes()"
              (input)="onWaitMinutesChange(waitMinutesInput.value)"
              class="w-full text-[11px] px-2 py-1.5 rounded border border-stone-200 dark:border-stone-600 bg-white dark:bg-stone-700 text-stone-700 dark:text-stone-300"
              placeholder="等待(min)">
          </div>
        }

        <!-- 妗岄潰绔細闄勪欢绠＄悊鐙珛鏄剧ず - 鏆傛椂闅愯棌 -->
        <!-- @if (!isMobile() && userId() && projectId()) {
          <app-attachment-manager
            [userId]="userId()"
            [projectId]="projectId()"
            [taskId]="task().id"
            [currentAttachments]="task().attachments"
            [compact]="false"
            (attachmentsChange)="onAttachmentsChange($event)"
            (error)="attachmentError.emit($event)">
          </app-attachment-manager>
        } -->

        <!-- 鎿嶄綔鎸夐挳 - 浠呭湪缂栬緫妯″紡涓嬫樉绀?-->
        @if (!isPreview()) {
          <div class="flex flex-wrap border-t border-stone-100 dark:border-stone-700"
               [ngClass]="{'gap-2 pt-2': !isMobile(), 'gap-1.5 pt-1.5': isMobile()}">
            <button
              (click)="addSibling.emit()"
              class="flex-1 bg-retro-teal/10 hover:bg-retro-teal text-retro-teal hover:text-white border border-retro-teal/30 font-medium rounded-md flex items-center justify-center transition-all"
              [ngClass]="{'px-2 py-1 text-xs gap-1': !isMobile(), 'px-1.5 py-0.5 text-[10px] gap-0.5': isMobile()}"
              title="娣诲姞鍚岀骇">
              <svg [ngClass]="{'w-3 h-3': !isMobile(), 'w-2.5 h-2.5': isMobile()}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              鍚岀骇
            </button>
            <button
              (click)="addChild.emit()"
              class="flex-1 bg-retro-rust/10 hover:bg-retro-rust text-retro-rust hover:text-white border border-retro-rust/30 font-medium rounded-md flex items-center justify-center transition-all"
              [ngClass]="{'px-2 py-1 text-xs gap-1': !isMobile(), 'px-1.5 py-0.5 text-[10px] gap-0.5': isMobile()}"
              title="娣诲姞涓嬬骇">
              <svg [ngClass]="{'w-3 h-3': !isMobile(), 'w-2.5 h-2.5': isMobile()}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="15 10 20 15 15 20"/>
                <path d="M4 4v7a4 4 0 0 0 4 4h12"/>
              </svg>
              涓嬬骇
            </button>
            <!-- 绉诲姩绔細闄勪欢鎸夐挳鏀惧湪鍚屼竴琛?- 鏆傛椂闅愯棌 -->
            <!-- @if (isMobile() && userId() && projectId()) {
              <label
                class="flex-1 cursor-pointer text-[10px] px-1.5 py-0.5 bg-stone-50 hover:bg-stone-100 text-stone-500 hover:text-stone-700 rounded-md border border-stone-200 transition-colors flex items-center justify-center gap-0.5"
                [class.opacity-50]="isUploading()"
                [class.pointer-events-none]="isUploading()">
                <svg class="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                </svg>
                @if (isUploading()) {
                  涓婁紶涓?                } @else {
                  闄勪欢
                }
                @if (task().attachments && task().attachments.length > 0) {
                  <span class="text-[8px] bg-indigo-100 text-indigo-600 px-0.5 rounded">{{ task().attachments.length }}</span>
                }
                <input
                  type="file"
                  class="hidden"
                  multiple
                  accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.md"
                  (change)="onMobileFileSelect($event)"
                  [disabled]="isUploading()">
              </label>
            } -->
            <button
              (click)="parkTask.emit()"
              class="flex-1 font-medium rounded-md flex items-center justify-center transition-all duration-200"
              [ngClass]="{
                'px-2 py-1 text-xs gap-1': !isMobile(), 
                'px-1.5 py-0.5 text-[10px] gap-0.5': isMobile(),
                'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-600': task().parkingMeta?.state === 'parked',
                'bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-500 text-amber-600 dark:text-amber-400 hover:text-white border border-amber-200 dark:border-amber-700 hover:border-amber-500': task().parkingMeta?.state !== 'parked'
              }"
              [title]="task().parkingMeta?.state === 'parked' ? '浠诲姟宸插湪鍋滄硦鍧炰腑' : '鍋滄硦浠诲姟锛岀◢鍚庡鐞?">
              <svg [ngClass]="{'w-3 h-3': !isMobile(), 'w-2.5 h-2.5': isMobile()}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                <polyline points="17 21 17 13 7 13 7 21"/>
              </svg>
              {{ task().parkingMeta?.state === 'parked' ? '宸插仠娉? : '鍋滄硦' }}
            </button>
            <button
              (click)="deleteTask.emit()"
              data-testid="delete-task-btn"
              class="bg-stone-100 dark:bg-stone-700 hover:bg-red-500 text-stone-400 dark:text-stone-500 hover:text-white border border-stone-200 dark:border-stone-600 hover:border-red-500 font-medium rounded-md flex items-center justify-center transition-all"
              [ngClass]="{'px-2 py-1 text-xs': !isMobile(), 'px-1.5 py-0.5 text-[10px]': isMobile()}"
              title="鍒犻櫎浠诲姟">
              <svg [ngClass]="{'w-3 h-3': !isMobile(), 'w-2.5 h-2.5': isMobile()}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>

          <!-- 绉诲姩绔細闄勪欢鍒楄〃鎶樺彔鍖猴紙濡傛灉鏈夐檮浠讹級- 鏆傛椂闅愯棌 -->
          <!-- @if (isMobile() && task().attachments && task().attachments.length > 0) {
            <div class="mt-1.5">
              <button
                (click)="toggleAttachmentList()"
                class="w-full flex items-center justify-between px-2 py-1 bg-stone-50 hover:bg-stone-100 rounded text-[10px] text-stone-500 transition-colors">
                <span class="flex items-center gap-1">
                  <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
                  {{ task().attachments.length }} 涓檮浠?                </span>
                <svg
                  class="w-3 h-3 transition-transform"
                  [class.rotate-180]="showAttachmentList()"
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              @if (showAttachmentList()) {
                <div class="mt-1 p-1.5 bg-stone-50/50 dark:bg-stone-800/50 rounded border border-stone-100 dark:border-stone-700 space-y-1 animate-collapse-open">
                  @for (attachment of task().attachments; track attachment.id) {
                    <div
                      class="group flex items-center gap-1.5 px-1.5 py-1 bg-white dark:bg-stone-700 hover:bg-stone-50 dark:hover:bg-stone-600 rounded text-[10px] text-stone-600 dark:text-stone-300 border border-stone-100 dark:border-stone-600 transition-colors"
                      [class.cursor-pointer]="attachment.type === 'image'"
                      (click)="attachment.type === 'image' && previewImage(attachment)">
                      @if (attachment.type === 'image' && attachment.thumbnailUrl) {
                        <img [src]="attachment.thumbnailUrl" [alt]="attachment.name" class="w-5 h-5 object-cover rounded">
                      } @else {
                        <span class="w-5 h-5 flex items-center justify-center text-[8px] text-stone-400 dark:text-stone-500 uppercase bg-stone-100 dark:bg-stone-600 rounded">{{ getFileExtension(attachment.name) }}</span>
                      }
                      <span class="flex-1 truncate">{{ attachment.name }}</span>
                      <span class="text-[9px] text-stone-400 dark:text-stone-500">{{ formatFileSize(attachment.size) }}</span>
                      <button
                        (click)="deleteAttachment(attachment, $event)"
                        class="text-stone-400 hover:text-red-500 transition-colors p-0.5"
                        title="鍒犻櫎">
                        <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  }
                </div>
              }
            </div>
          } -->
        }
      </div>

      <!-- 鍏宠仈鍖哄煙 -->
      <app-text-task-connections
        [connections]="connections()"
        [isMobile]="isMobile()"
        (openTask)="openLinkedTask.emit($event)">
      </app-text-task-connections>
    </div>
  `,
  styles: [`
    .animate-collapse-open {
      animation: collapseOpen 0.15s ease-out;
    }
    @keyframes collapseOpen {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `]
})
export class TextTaskEditorComponent implements OnDestroy {
  private readonly taskOpsAdapter = inject(TaskOperationAdapterService);
  private readonly changeTracker = inject(ChangeTrackerService);
  private readonly uiState = inject(UiStateService);
  private readonly projectState = inject(ProjectStateService);
  private readonly elementRef = inject(ElementRef);
  private readonly attachmentService = inject(AttachmentService);
  private readonly toast = inject(ToastService);
  private readonly cdr = inject(ChangeDetectorRef);

  readonly task = input.required<Task>();
  readonly isMobile = input(false);
  readonly userId = input<string | null>(null);
  readonly projectId = input<string | null>(null);
  readonly connections = input<TaskConnectionInfo | null>(null);
  readonly initialPreview = input(true);

  readonly addSibling = output<void>();
  readonly addChild = output<void>();
  readonly deleteTask = output<void>();
  readonly parkTask = output<void>();
  readonly attachmentError = output<string>();
  readonly openLinkedTask = output<{ task: Task; event: Event }>();
  readonly previewModeChange = output<boolean>();

  readonly isPreview = signal(true);
  readonly showAttachmentList = signal(false);
  readonly isUploading = signal(false);

  // ========== Split-Brain 鏈湴鐘舵€?==========
  /** 鏈湴鏍囬锛堜笌 Store 瑙ｈ€︼紝浠呭湪闈炶仛鐒︽椂鍚屾锛?*/
  protected readonly localTitle = signal('');
  /** 鏈湴鍐呭锛堜笌 Store 瑙ｈ€︼紝浠呭湪闈炶仛鐒︽椂鍚屾锛?*/
  protected readonly localContent = signal('');
  protected readonly localExpectedMinutes = signal('');
  protected readonly localWaitMinutes = signal('');
  protected readonly localCognitiveLoad = signal<'high' | 'low' | ''>('');
  /** 鏍囬杈撳叆妗嗘槸鍚﹁仛鐒?*/
  private isTitleFocused = false;
  /** 鍐呭杈撳叆妗嗘槸鍚﹁仛鐒?*/
  private isContentFocused = false;
  /** 瑙ｉ攣寤惰繜瀹氭椂鍣?*/
  private unlockTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /** 鏍囪鏄惁姝ｅ湪杩涜鏂囨湰閫夋嫨鎿嶄綔 */
  isSelecting = false;

  /** 鏈€澶ч檮浠舵暟閲?*/
  private readonly maxAttachments = 5;
  /** 鏈€澶ф枃浠跺ぇ灏?10MB */
  private readonly maxFileSize = 10 * 1024 * 1024;

  constructor() {
    // Split-Brain 核心逻辑：仅在输入框非聚焦时从 Store 同步到本地
    // 这样可避免用户输入时被远程更新覆盖
    try {
      effect(() => {
        const task = this.task();
        if (task) {
          // 浠呭綋鏍囬杈撳叆妗嗘湭鑱氱劍鏃舵墠鍚屾鏍囬
          if (!this.isTitleFocused) {
            this.localTitle.set(task.title || '');
          }
          // 浠呭綋鍐呭杈撳叆妗嗘湭鑱氱劍鏃舵墠鍚屾鍐呭
          if (!this.isContentFocused) {
            this.localContent.set(task.content || '');
          this.localExpectedMinutes.set(task.expected_minutes == null ? '' : String(task.expected_minutes));
          this.localWaitMinutes.set(task.wait_minutes == null ? '' : String(task.wait_minutes));
          this.localCognitiveLoad.set(task.cognitive_load ?? '');
          }
        }
      });
    } catch {
      // 銆愰槻寰°€慡W chunk 涓嶄竴鑷村彲鑳藉鑷?DestroyRef/injection context 涓㈠け
      // 回退：直接初始化本地状态
      const task = this.task?.();
      if (task) {
        this.localTitle.set(task.title || '');
        this.localContent.set(task.content || '');
          this.localExpectedMinutes.set(task.expected_minutes == null ? '' : String(task.expected_minutes));
          this.localWaitMinutes.set(task.wait_minutes == null ? '' : String(task.wait_minutes));
          this.localCognitiveLoad.set(task.cognitive_load ?? '');
      }
    }
  }

  ngOnDestroy(): void {
    // 娓呯悊鎵€鏈夋湭瀹屾垚鐨勮В閿佸畾鏃跺櫒
    for (const timer of this.unlockTimers.values()) {
      clearTimeout(timer);
    }
    this.unlockTimers.clear();
  }

  // ========== Split-Brain 閿佸畾杈呭姪鏂规硶 ==========

  /** 閿佸畾浠诲姟瀛楁锛堥槻姝㈣繙绋嬫洿鏂拌鐩栨湰鍦扮紪杈戯級 */
  private lockTaskFields(taskId: string, fields: string[]): void {
    const projectId = this.projectId() || this.projectState.activeProjectId();
    if (!projectId) return;
    for (const field of fields) {
      this.changeTracker.lockTaskField(taskId, projectId, field);
    }
  }

  /** 瑙ｉ攣浠诲姟瀛楁 */
  private unlockTaskFields(taskId: string, fields: string[]): void {
    const projectId = this.projectId() || this.projectState.activeProjectId();
    if (!projectId) return;
    for (const field of fields) {
      this.changeTracker.unlockTaskField(taskId, projectId, field);
    }
  }

  /**
   * 鐩戝惉 document 鐐瑰嚮浜嬩欢
   * 娉ㄦ剰锛氫换鍔″崱鐗囧唴鐨勭偣鍑荤敱 text-task-card 澶勭悊
   * 杩欓噷鍙鐞嗙偣鍑诲埌缁勪欢瀹屽叏澶栭儴鐨勬儏鍐碉紙濡傞〉闈㈠叾浠栧尯鍩燂級
   */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    // 濡傛灉宸茬粡鏄瑙堟ā寮忥紝鏃犻渶澶勭悊
    if (this.isPreview()) return;

    // 濡傛灉姝ｅ湪杩涜鏂囨湰閫夋嫨锛屼笉澶勭悊
    if (this.isSelecting) return;

    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) {
      // 鏈夋枃鏈閫変腑锛屼笉鍒囨崲妯″紡
      return;
    }

    const clickedInside = this.elementRef.nativeElement.contains(event.target as Node);

    // 如果点击在编辑器内部，不做任何处理（允许正常编辑与文本选择）
    if (clickedInside) return;

    // 点击在编辑器外部，检查是否在任务卡片内
    const target = event.target as HTMLElement;
    const clickedInTaskCard = target.closest(`[data-task-id="${this.task().id}"]`);

    if (!clickedInTaskCard) {
      // 鐐瑰嚮瀹屽叏鍦ㄤ换鍔″崱鐗囧锛屽垏鎹㈠埌棰勮妯″紡
      this.isPreview.set(true);
      this.previewModeChange.emit(true);
    }
    // 濡傛灉鐐瑰嚮鍦ㄤ换鍔″崱鐗囧唴浣嗙紪杈戝櫒澶栵紙濡傚崱鐗囧ご閮級锛岀敱 text-task-card 澶勭悊
  }

  ngOnInit() {
    this.isPreview.set(this.initialPreview());
    this.localTitle.set(this.task().title || '');
    this.localContent.set(this.task().content || '');
    this.localExpectedMinutes.set(this.task().expected_minutes == null ? '' : String(this.task().expected_minutes));
    this.localWaitMinutes.set(this.task().wait_minutes == null ? '' : String(this.task().wait_minutes));
    this.localCognitiveLoad.set(this.task().cognitive_load ?? '');
  }

  togglePreview() {
    const newValue = !this.isPreview();
    this.isPreview.set(newValue);
    this.previewModeChange.emit(newValue);
  }

  /**
   * 澶栭儴璋冪敤锛氬己鍒跺垏鎹㈠埌棰勮妯″紡
   */
  setPreviewMode() {
    if (!this.isPreview()) {
      this.isPreview.set(true);
      this.previewModeChange.emit(true);
    }
  }



  /**
   * 杈撳叆妗嗚仛鐒﹀鐞嗭紙Split-Brain 妯″紡鏍稿績锛?   * 1. 鏍囪鍏ㄥ眬缂栬緫鐘舵€?   * 2. 閿佸畾瀵瑰簲瀛楁锛?灏忔椂锛岄槻姝㈣繙绋嬫洿鏂拌鐩栵級
   * 3. 鏍囪鏈湴鑱氱劍鐘舵€侊紝闃绘 Store->Local 鍚屾
   */
  onInputFocus(field: 'title' | 'content' | 'todo') {
    this.uiState.markEditing();

    if (field === 'title') {
      this.isTitleFocused = true;
      // 娓呴櫎鍙兘瀛樺湪鐨勮В閿佸畾鏃跺櫒
      const existingTimer = this.unlockTimers.get('title');
      if (existingTimer) {
        clearTimeout(existingTimer);
        this.unlockTimers.delete('title');
      }
      this.lockTaskFields(this.task().id, ['title']);
    } else if (field === 'content') {
      this.isContentFocused = true;
      const existingTimer = this.unlockTimers.get('content');
      if (existingTimer) {
        clearTimeout(existingTimer);
        this.unlockTimers.delete('content');
      }
      this.lockTaskFields(this.task().id, ['content']);
    }
    // todo 瀛楁涓嶉渶瑕侀攣瀹氾紙涓嶄細琚繙绋嬫洿鏂拌鐩栵級
  }

  /**
   * 杈撳叆妗嗗け鐒﹀鐞嗭紙Split-Brain 妯″紡鏍稿績锛?   * 1. 鎻愪氦鏈湴鍐呭鍒?Store
   * 2. 寤惰繜 5 绉掑悗瑙ｉ攣瀛楁锛堢瓑寰呭悓姝ュ畬鎴愶紝闃叉鍥炲０瑕嗙洊锛?   * 3. 寤惰繜鍚庨噸鏂板惎鐢?Store->Local 鍚屾
   */
  onInputBlur(field: 'title' | 'content' | 'todo') {
    // 寤惰繜娓呴櫎閫夋嫨鏍囪
    setTimeout(() => {
      this.isSelecting = false;
    }, 100);

    if (field === 'title') {
      // 鎻愪氦鏈湴鍐呭鍒?Store
      this.taskOpsAdapter.updateTaskTitle(this.task().id, this.localTitle());

      const timer = setTimeout(() => {
        this.isTitleFocused = false;
        this.unlockTaskFields(this.task().id, ['title']);
        this.unlockTimers.delete('title');
      }, 10000);
      this.unlockTimers.set('title', timer);
    } else if (field === 'content') {
      this.taskOpsAdapter.updateTaskContent(this.task().id, this.localContent());

      const timer = setTimeout(() => {
        this.isContentFocused = false;
        this.unlockTaskFields(this.task().id, ['content']);
        this.unlockTimers.delete('content');
      }, 10000);
      this.unlockTimers.set('content', timer);
    }
  }

  /**
   * 鏍囬杈撳叆澶勭悊
   * 浠呮洿鏂版湰鍦扮姸鎬侊紝blur 鏃舵墠鎻愪氦鍒?Store
   */
  onTitleInput(value: string) {
    this.localTitle.set(value);
    this.taskOpsAdapter.updateTaskTitle(this.task().id, value);
  }

  /**
   * 鍐呭杈撳叆澶勭悊
   * 浠呮洿鏂版湰鍦扮姸鎬侊紝blur 鏃舵墠鎻愪氦鍒?Store
   */
  onContentInput(value: string) {
    this.localContent.set(value);
    this.taskOpsAdapter.updateTaskContent(this.task().id, value);
  }

  onExpectedMinutesChange(value: string): void {
    this.localExpectedMinutes.set(value);
    this.taskOpsAdapter.updateTaskExpectedMinutes(this.task().id, this.parseOptionalMinutes(value));
  }

  onWaitMinutesChange(value: string): void {
    this.localWaitMinutes.set(value);
    this.taskOpsAdapter.updateTaskWaitMinutes(this.task().id, this.parseOptionalMinutes(value));
  }

  onCognitiveLoadChange(value: string): void {
    const normalized = value === 'high' || value === 'low' ? value : null;
    this.localCognitiveLoad.set((normalized ?? '') as 'high' | 'low' | '');
    this.taskOpsAdapter.updateTaskCognitiveLoad(this.task().id, normalized);
  }

  /**
   * Markdown 棰勮鍖哄煙鐐瑰嚮澶勭悊
   * 鐐瑰嚮寰呭姙 checkbox 鏃跺垏鎹㈠畬鎴愮姸鎬侊紱鐐瑰嚮鍏朵粬鍖哄煙杩涘叆缂栬緫妯″紡
   */
  onPreviewClick(event: MouseEvent) {
    event.stopPropagation();
    const todoIndex = getTodoIndexFromClick(event);
    if (todoIndex !== null) {
      // 鐐瑰嚮浜嗗緟鍔?checkbox锛屽垏鎹㈢姸鎬佽€岄潪杩涘叆缂栬緫妯″紡
      const currentContent = this.localContent() || this.task().content || '';
      const newContent = toggleMarkdownTodo(currentContent, todoIndex);
      this.localContent.set(newContent);
      this.taskOpsAdapter.updateTaskContent(this.task().id, newContent);
      // 寮哄埗鏍囪缁勪欢闇€瑕侀噸鏂版娴嬶紝纭繚 OnPush 妯″紡涓?UI 鍒锋柊
      this.cdr.markForCheck();
    } else {
      this.togglePreview();
    }
  }

  addQuickTodo(inputElement: HTMLInputElement) {
    const text = inputElement.value.trim();
    if (!text) return;

    this.taskOpsAdapter.addTodoItem(this.task().id, text);
    inputElement.value = '';
    inputElement.focus();
  }

  onAttachmentsChange(attachments: Attachment[]) {
    this.taskOpsAdapter.updateTaskAttachments(this.task().id, attachments);
  }

  // ========== 绉诲姩绔檮浠剁鐞嗘柟娉?==========

  toggleAttachmentList() {
    this.showAttachmentList.update(v => !v);
  }

  getFileExtension(filename: string): string {
    const ext = filename.split('.').pop() || '';
    return ext.length > 4 ? ext.substring(0, 4) : ext;
  }

  formatFileSize(bytes: number | undefined): string {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  async onMobileFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    if (!files || files.length === 0 || !this.userId() || !this.projectId()) return;

    const currentCount = this.task().attachments?.length || 0;
    const remaining = this.maxAttachments - currentCount;

    if (remaining <= 0) {
      this.toast.warning('附件数量已达上限', '每个任务最多 ' + this.maxAttachments + ' 个附件');
      input.value = '';
      return;
    }

    const filesToUpload = Array.from(files).slice(0, remaining);

    // 检查文件大小
    for (const file of filesToUpload) {
      if (file.size > this.maxFileSize) {
        this.toast.warning('鏂囦欢杩囧ぇ', `${file.name} 瓒呰繃 10MB 闄愬埗`);
        input.value = '';
        return;
      }
    }

    this.isUploading.set(true);

    try {
      const newAttachments: Attachment[] = [];

      for (const file of filesToUpload) {
        const result = await this.attachmentService.uploadFile(
          this.userId()!,
          this.projectId()!,
          this.task().id,
          file
        );
        if (result.success && result.attachment) {
          newAttachments.push(result.attachment);
        } else if (result.error) {
          this.attachmentError.emit(result.error);
        }
      }

      if (newAttachments.length > 0) {
        const updatedAttachments = [...(this.task().attachments || []), ...newAttachments];
        this.taskOpsAdapter.updateTaskAttachments(this.task().id, updatedAttachments);
        this.toast.success('涓婁紶鎴愬姛', `${newAttachments.length} 涓枃浠跺凡涓婁紶`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : '涓婁紶澶辫触';
      this.attachmentError.emit(errorMsg);
      this.toast.error('涓婁紶澶辫触', errorMsg);
    } finally {
      this.isUploading.set(false);
      input.value = '';
    }
  }

  async deleteAttachment(attachment: Attachment, event: Event) {
    event.stopPropagation();

    if (!this.userId() || !this.projectId()) return;

    try {
      const deletedAttachment = this.attachmentService.markAsDeleted(attachment);

      const updatedAttachments = (this.task().attachments || []).map(a =>
        a.id === attachment.id ? deletedAttachment : a
      );
      this.taskOpsAdapter.updateTaskAttachments(this.task().id, updatedAttachments);
      this.toast.success('删除成功', attachment.name + ' 已删除');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : '鍒犻櫎澶辫触';
      this.attachmentError.emit(errorMsg);
      this.toast.error('鍒犻櫎澶辫触', errorMsg);
    }
  }

  previewImage(attachment: Attachment) {
    if (attachment.url) {
      window.open(attachment.url, '_blank');
    }
  }

  private parseOptionalMinutes(value: string): number | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.floor(parsed);
  }
}







