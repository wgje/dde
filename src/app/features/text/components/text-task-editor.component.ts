import { Component, Injector, inject, input, output, signal, computed, ChangeDetectionStrategy, ChangeDetectorRef, ElementRef, HostListener, effect, OnDestroy, viewChild, viewChildren } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { ChangeTrackerService } from '../../../../services/change-tracker.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService, TaskConnectionInfo } from '../../../../services/project-state.service';
import { UndoService, type UndoAppliedReplay } from '../../../../services/undo.service';
import { AttachmentService } from '../../../../services/attachment.service';
import { ToastService } from '../../../../services/toast.service';
import { Task, Attachment, type TaskAttentionDraftItem } from '../../../../models';
import { SafeMarkdownPipe } from '../../../shared/pipes/safe-markdown.pipe';
import { TextTaskConnectionsComponent } from './text-task-connections.component';
import { clearActiveTextSelection, hasActiveTextSelection, isInteractiveSelectionTarget } from '../../../../utils/text-selection';
import { KnowledgeAnchorComponent } from '../../../shared/components/knowledge-anchor/knowledge-anchor.component';
import { parseOptionalMinutes } from '../../parking/utils/dock-format';
import {
  formatAttachmentFileSize,
  getAttachmentFileExtension,
} from './text-task-editor.helpers';
import { TextTaskEditorAttachmentController } from './text-task-editor-attachment.controller';
import {
  TextTaskEditorDraftPersistenceController,
  type TextTaskEditorDraftOwner,
} from './text-task-editor-draft-persistence.controller';
import { TextTaskEditorFocusController } from './text-task-editor-focus.controller';
import { TextTaskEditorPreviewController } from './text-task-editor-preview.controller';
import { TextTaskEditorSidecarDraftController } from './text-task-editor-sidecar-draft.controller';

/**
 * 任务编辑器组件（展开态）
 * 显示任务的完整编辑界面，包括标题、内容、待办、附件和操作按钮
 *
 * 预览模式逻辑：
 * - 默认进入编辑状态时为预览模式
 * - 点击预览区域进入编辑模式
 * - 点击空白区域（组件外部）自动切换回预览模式
 * - 预览模式下隐藏底部操作按钮（添加同级、添加下级、删除）
 */
@Component({
  selector: 'app-text-task-editor',
  standalone: true,
  imports: [CommonModule, SafeMarkdownPipe, TextTaskConnectionsComponent, KnowledgeAnchorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './text-task-editor.component.html',
  styleUrl: './text-task-editor.component.css',
})
export class TextTaskEditorComponent implements OnDestroy {
  private readonly injector = inject(Injector);
  private readonly changeTracker = inject(ChangeTrackerService);
  private readonly uiState = inject(UiStateService);
  private readonly projectState = inject(ProjectStateService);
  private readonly undoService = inject(UndoService);
  private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly attachmentService = inject(AttachmentService);
  private readonly toast = inject(ToastService);
  private readonly cdr = inject(ChangeDetectorRef);

  private get taskOpsAdapter(): TaskOperationAdapterService {
    return this.injector.get(TaskOperationAdapterService);
  }

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
  readonly openLinkedTask = output<{ taskId: string; event: Event }>();
  readonly previewModeChange = output<boolean>();
  private readonly attachmentController = new TextTaskEditorAttachmentController({
    task: () => this.task(),
    userId: () => this.userId(),
    projectId: () => this.projectId(),
    setUploading: uploading => this.isUploading.set(uploading),
    uploadFile: (userId, projectId, taskId, file) =>
      this.attachmentService.uploadFile(userId, projectId, taskId, file),
    markAsDeleted: attachment => this.attachmentService.markAsDeleted(attachment),
    updateTaskAttachments: (taskId, attachments) =>
      this.taskOpsAdapter.updateTaskAttachments(taskId, attachments),
    emitAttachmentError: message => this.attachmentError.emit(message),
    toast: this.toast,
    openUrl: (url, target) => window.open(url, target),
  });

  readonly isPreview = signal(true);
  readonly showAttachmentList = signal(false);
  readonly isUploading = signal(false);
  private readonly previewController = new TextTaskEditorPreviewController({
    getLocalContent: () => this.localContent(),
    getTask: () => this.task(),
    submitTaskContent: (taskId, value) => this.submitTaskContent(taskId, value),
    setLocalContent: value => this.localContent.set(value),
    enterEditMode: (_field, event) => this.enterEditMode('content', event),
    emitOpenLinkedTask: (taskId, event) => this.openLinkedTask.emit({ taskId, event }),
    markForCheck: () => this.cdr.markForCheck(),
    toast: this.toast,
  });

  // ========== DOM 引用 ==========
  /** 标题输入框引用 */
  private readonly titleInputRef = viewChild<ElementRef<HTMLInputElement>>('titleInput');
  /** 内容输入框引用 */
  private readonly contentInputRef = viewChild<ElementRef<HTMLTextAreaElement>>('contentInput');
  private readonly attentionInputRefs = viewChildren<ElementRef<HTMLInputElement>>('attentionInput');

  // ========== Split-Brain 本地状态==========
  /** 本地标题（与 Store 解耦，仅在非聚焦时同步）*/
  protected readonly localTitle = signal('');
  /** 本地内容（与 Store 解耦，仅在非聚焦时同步）*/
  protected readonly localContent = signal('');
  protected readonly previewTitle = computed(() => this.localTitle().trim() || 'Untitled task');
  protected readonly hasPreviewContent = computed(() => this.localContent().trim().length > 0);
  protected readonly quickTodoSavePending = signal(false);
  private readonly sidecarDraft = new TextTaskEditorSidecarDraftController();
  private readonly draftPersistence = new TextTaskEditorDraftPersistenceController({
    getTask: () => this.task(),
    getUserId: () => this.userId(),
    captureOwner: taskId => this.captureTextOwner(taskId),
    isOwnerCurrent: owner => this.isTextOwnerCurrent(owner),
    retireSidecarSaveState: () => {
      this.sidecarDraft.plannerSaveState.set('idle');
      this.sidecarDraft.attentionSaveState.set('idle');
    },
    startPlannerSave: () => this.sidecarDraft.startPlannerSave(),
    finishPlannerSave: saved => this.sidecarDraft.finishPlannerSave(saved),
    startAttentionSave: () => this.sidecarDraft.startAttentionSave(),
    finishAttentionSave: (sequence, saved) => this.sidecarDraft.finishAttentionSave(sequence, saved),
    areAttentionRowsEqual: (left, right) => this.sidecarDraft.areAttentionRowsEqual(left, right),
    markForCheck: () => this.cdr.markForCheck(),
  });
  protected readonly textSaveState = this.draftPersistence.textSaveState;
  protected readonly localExpectedMinutes = this.sidecarDraft.localExpectedMinutes;
  protected readonly localWaitMinutes = this.sidecarDraft.localWaitMinutes;
  protected readonly localCognitiveLoad = this.sidecarDraft.localCognitiveLoad;
  protected readonly plannerSaveState = this.sidecarDraft.plannerSaveState;
  protected readonly localAttentionDraft = this.sidecarDraft.localAttentionDraft;
  protected readonly attentionDraftRows = this.sidecarDraft.attentionDraftRows;
  protected readonly attentionSaveState = this.sidecarDraft.attentionSaveState;
  protected readonly isAttentionRowsExpanded = this.sidecarDraft.isAttentionRowsExpanded;
  protected readonly visibleAttentionDraftRows = this.sidecarDraft.visibleAttentionDraftRows;
  protected readonly hiddenAttentionRowCount = this.sidecarDraft.hiddenAttentionRowCount;
  protected readonly getFileExtension = getAttachmentFileExtension;
  protected readonly formatFileSize = formatAttachmentFileSize;
  /** 标题输入框是否聚焦 */
  private isTitleFocused = false;
  /** 内容输入框是否聚焦 */
  private isContentFocused = false;
  private isComponentLive = false;
  private textOwner: TextTaskEditorDraftOwner | null = null;
  private isRetiringTextOwner = false;
  private unregisterProjectRetirement = () => {};
  private readonly focusController = new TextTaskEditorFocusController({
    elementRef: this.elementRef,
    taskId: () => this.task().id,
  });
  /** IME 输入状态追踪 */
  private readonly composingState: Record<'title' | 'content', boolean> = {
    title: false,
    content: false,
  };
  /** 解锁延迟定时器*/
  private unlockTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private lastConsumedReplay: UndoAppliedReplay | null = this.undoService.appliedReplay();

  /** 标记是否正在进行文本选择操作 */
  isSelecting = false;

  constructor() {
    // Split-Brain 核心逻辑：仅在输入框非聚焦时从 Store 同步到本地
    // 这样可避免用户输入时被远程更新覆盖
    try {
      effect(() => {
        this.draftPersistence.observeUserId(this.userId());
        const task = this.task();
        if (task) {
          this.refreshTextOwner(task.id);
          this.syncLocalDraftFromTask(
            task,
            !this.isTitleFocused,
            !this.isContentFocused,
            this.sidecarDraft.shouldSyncAttentionFromTask(task.id),
          );
        }
      });

      effect(() => {
        const replay = this.undoService.appliedReplay();
        if (!replay || replay === this.lastConsumedReplay) {
          return;
        }

        this.lastConsumedReplay = replay;

        const task = this.task();
        if (!task) {
          return;
        }

        const changedFields = replay.taskFieldChanges[task.id];
        if (!changedFields) {
          return;
        }

        if (changedFields.includes('title')) {
          this.localTitle.set(task.title || '');
        }
        if (changedFields.includes('content')) {
          this.localContent.set(task.content || '');
        }
      });
    } catch {
      // 【防御】SW chunk 不一致可能导致 DestroyRef/injection context 丢失
      // 回退：等待 ngOnInit/effect 在可用的输入上下文中完成初始化。
    }
  }

  ngOnDestroy(): void {
    this.isComponentLive = false;
    this.persistCurrentEdits();
    this.textOwner = null;
    this.draftPersistence.retireCurrentOwner();
    this.unregisterProjectRetirement();
    this.focusController.clearFocusRequestTimer();
    this.focusController.clearDocumentClickGuard();

    // 清理所有未完成的解锁定时器
    for (const timer of this.unlockTimers.values()) {
      clearTimeout(timer);
    }
    this.unlockTimers.clear();
  }

  /**
   * 从 DOM 同步最新值并持久化
   * 确保 IME 输入和快速关闭场景下数据不丢失
   */
  private persistCurrentEdits(): void {
    const task = this.task?.();
    if (!task) return;

    // 从 DOM 直接读取最新值（绕过 Angular 数据绑定的延迟）
    const titleEl = this.elementRef.nativeElement.querySelector(
      '[data-testid="task-title-input"]',
    ) as HTMLInputElement | null;
    const contentEl = this.contentInputRef()?.nativeElement;

    const currentTitle = titleEl?.value ?? this.localTitle();
    const currentContent = contentEl?.value ?? this.localContent();

    // 与当前 Store 中的任务比较，只有真正有变化才保存
    if (currentTitle !== task.title) {
      void this.submitTaskTitle(task.id, currentTitle);
    }
    if (currentContent !== task.content) {
      void this.submitTaskContent(task.id, currentContent);
    }
    this.persistVisibleAttentionInputs();
  }

  private submitTaskTitle(taskId: string, value: string): Promise<boolean> {
    return this.draftPersistence.submitText('title', taskId, value, () =>
      this.taskOpsAdapter.updateTaskTitle(taskId, value),
    );
  }

  private submitTaskContent(taskId: string, value: string): Promise<boolean> {
    return this.draftPersistence.submitText('content', taskId, value, () =>
      this.taskOpsAdapter.updateTaskContent(taskId, value),
    );
  }

  private persistVisibleAttentionInputs(): void {
    const attentionInputs = this.attentionInputRefs();
    const inputElements = attentionInputs.length > 0
      ? attentionInputs.map(inputRef => inputRef.nativeElement)
      : Array.from(this.elementRef.nativeElement.querySelectorAll('[data-testid="task-attention-input"]')) as HTMLInputElement[];
    if (inputElements.length === 0) return;

    const visibleRows = this.visibleAttentionDraftRows();
    const rows = [...this.attentionDraftRows()];
    let hasChanged = false;

    inputElements.forEach((inputEl, visibleIndex) => {
      const rowIndex = visibleRows[visibleIndex]?.index;
      if (rowIndex === undefined) return;

      const currentText = inputEl.value;
      const currentRow = rows[rowIndex] ?? { text: '', level: 'info', done: false };
      if (currentText !== currentRow.text) {
        rows[rowIndex] = { ...currentRow, text: currentText };
        hasChanged = true;
      }
    });

    if (hasChanged) {
      this.setAttentionDraftRows(rows);
    }
  }

  // ========== Split-Brain 锁定辅助方法 ==========

  /** 锁定任务字段（防止远程更新覆盖本地编辑） */
  private lockTaskFields(taskId: string, fields: string[]): void {
    const projectId = this.resolveProjectId();
    if (!projectId) return;
    for (const field of fields) {
      this.changeTracker.lockTaskField(taskId, projectId, field, ChangeTrackerService.TEXT_INPUT_LOCK_TIMEOUT_MS);
    }
  }

  /** 解锁任务字段 */
  private unlockTaskFields(taskId: string, fields: string[], projectId = this.resolveProjectId()): void {
    if (!projectId) return;
    for (const field of fields) {
      this.changeTracker.unlockTaskField(taskId, projectId, field);
    }
  }

  private resolveProjectId(): string | null {
    return this.projectId() || this.projectState.activeProjectId();
  }

  private refreshTextOwner(taskId: string): void {
    const owner = this.projectState.captureActiveProjectOwner();
    const current = this.textOwner;
    if (owner.projectId !== this.resolveProjectId()) {
      this.textOwner = null;
    } else if (!current || current.projectId !== owner.projectId
      || current.generation !== owner.generation || current.taskId !== taskId) {
      this.textOwner = { ...owner, taskId };
    }
  }

  private captureTextOwner(taskId = this.task().id): TextTaskEditorDraftOwner | null {
    const owner = this.textOwner;
    if (!owner || owner.taskId !== taskId || this.resolveProjectId() !== owner.projectId) return null;
    const projectCurrent = this.isRetiringTextOwner
      ? this.projectState.activeProjectId() === owner.projectId
      : this.projectState.isActiveProjectOwnerCurrent(owner);
    return projectCurrent ? owner : null;
  }

  private isTextOwnerCurrent(owner: TextTaskEditorDraftOwner): boolean {
    return this.captureTextOwner(owner.taskId) === owner;
  }

  private scheduleUnlock(field: string, unlock: () => void): void {
    // 显式 undefined 判断：timer handle 为 0 时也要清理，否则 stale 解锁回调会在
    // 用户聚焦编辑期间提前解锁字段，让远程同步覆盖正在输入的内容
    const existingTimer = this.unlockTimers.get(field);
    if (existingTimer !== undefined) clearTimeout(existingTimer);
    this.unlockTimers.set(field, setTimeout(() => {
      unlock(); this.unlockTimers.delete(field);
    }, 10000));
  }

  /**
   * 监听 document 点击事件
   * 注意：任务卡片内的点击由 text-task-card 处理
   * 这里只处理点击到组件完全外部的情况（如页面其他区域）
   */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    if (this.focusController.consumeSuppressedDocumentClick()) {
      return;
    }

    const isInteractiveTarget = isInteractiveSelectionTarget(event.target);
    const clickedInside = this.focusController.isEventInsideEditor(event);
    const clickedInTaskCard = this.focusController.isEventInsideCurrentTaskCard(event);

    // 拖拽选择过程中不打断浏览器原生选区行为。
    if (this.isSelecting) return;

    if (hasActiveTextSelection()) {
      if (clickedInside) {
        return;
      }

      clearActiveTextSelection();
      if (!isInteractiveTarget) {
        return;
      }
    }

    // 如果已经是预览模式，无需处理
    if (this.isPreview()) return;

    // 如果点击在编辑器内部，不做任何处理（允许正常编辑与文本选择）
    if (clickedInside) return;

    if (!clickedInTaskCard) {
      // 点击完全在任务卡片外，切换到预览模式
      this.isPreview.set(true);
      this.previewModeChange.emit(true);
    }
    // 如果点击在任务卡片内但编辑器外（如卡片头部），由 text-task-card 处理
  }

  ngOnInit() {
    this.isComponentLive = true;
    this.draftPersistence.observeUserId(this.userId());
    this.refreshTextOwner(this.task().id);
    this.unregisterProjectRetirement = this.projectState.registerBeforeActiveProjectChange(previousProjectId => {
      if (!this.textOwner || this.textOwner.projectId !== previousProjectId) return;
      this.isRetiringTextOwner = true;
      try { this.persistCurrentEdits(); }
      finally {
        this.isRetiringTextOwner = false;
        this.textOwner = null;
        this.draftPersistence.retireCurrentOwner();
      }
    });
    this.isPreview.set(this.initialPreview());
    this.syncLocalDraftFromTask(this.task(), true, true, true);
  }

  togglePreview() {
    const newValue = !this.isPreview();
    this.isPreview.set(newValue);
    this.previewModeChange.emit(newValue);
    if (newValue) {
      this.focusController.clearFocusRequestTimer();
    }
  }

  enterEditMode(field: 'title' | 'content', triggerEvent?: Event) {
    if (this.isPreview()) {
      this.focusController.armOutsideClickGuard(triggerEvent);
      this.isPreview.set(false);
      this.previewModeChange.emit(false);
    }

    this.focusController.focusEditorField(field);
  }

  onPreviewToggleButtonClick(event: Event) {
    event.stopPropagation();
    if (this.isPreview()) {
      this.enterEditMode('content', event);
      return;
    }
    this.togglePreview();
  }

  /**
   * 外部调用：强制切换到预览模式
   */
  setPreviewMode() {
    if (!this.isPreview()) {
      this.isPreview.set(true);
      this.previewModeChange.emit(true);
      this.focusController.clearFocusRequestTimer();
    }
  }

  /**
   * 输入框聚焦处理（Split-Brain 模式核心）   * 1. 标记全局编辑状态   * 2. 锁定对应字段，防止远程更新覆盖
   * 3. 标记本地聚焦状态，阻止 Store->Local 同步
   */
  onInputFocus(field: 'title' | 'content' | 'todo') {
    this.uiState.markEditing();

    if (field === 'title') {
      this.isTitleFocused = true;
      // 清除可能存在的解锁定时器（显式 undefined 判断：handle 0 也要清理）
      const existingTimer = this.unlockTimers.get('title');
      if (existingTimer !== undefined) {
        clearTimeout(existingTimer);
        this.unlockTimers.delete('title');
      }
      this.lockTaskFields(this.task().id, ['title']);
    } else if (field === 'content') {
      this.isContentFocused = true;
      const existingTimer = this.unlockTimers.get('content');
      if (existingTimer !== undefined) {
        clearTimeout(existingTimer);
        this.unlockTimers.delete('content');
      }
      this.lockTaskFields(this.task().id, ['content']);
    }
    // todo 字段不需要锁定（不会被远程更新覆盖）
  }

  /**
   * 输入框失焦处理（Split-Brain 模式核心）
   * 1. 从 DOM 读取最新值（确保 IME 输入的最终值）
   * 2. 提交本地内容到 Store
   * 3. 延迟后解锁字段（等待同步完成，防止回声覆盖）
   */
  onInputBlur(field: 'title' | 'content' | 'todo') {
    // 延迟清除选择标记
    setTimeout(() => {
      this.isSelecting = false;
    }, 100);

    if (field === 'title') {
      const currentTask = this.task();
      const unlockProjectId = this.resolveProjectId();
      // 从 DOM 读取最新值（确保 IME 输入完成后的最终值）
      const titleEl = this.titleInputRef()?.nativeElement;
      const currentTitle = titleEl?.value ?? this.localTitle();
      this.localTitle.set(currentTitle);

      // 提交本地内容到 Store
      void this.submitTaskTitle(currentTask.id, currentTitle);

      this.scheduleUnlock('title', () => {
        this.isTitleFocused = false;
        this.unlockTaskFields(currentTask.id, ['title'], unlockProjectId);
      });
    } else if (field === 'content') {
      const currentTask = this.task();
      const unlockProjectId = this.resolveProjectId();
      // 从 DOM 读取最新值
      const contentEl = this.contentInputRef()?.nativeElement;
      const currentContent = contentEl?.value ?? this.localContent();
      this.localContent.set(currentContent);

      void this.submitTaskContent(currentTask.id, currentContent);

      this.scheduleUnlock('content', () => {
        this.isContentFocused = false;
        this.unlockTaskFields(currentTask.id, ['content'], unlockProjectId);
      });
    }
  }

  /**
   * 标题输入处理
   * 仅更新本地状态，blur 时才提交到 Store
   */
  onTitleInput(value: string) {
    this.localTitle.set(value);
    void this.submitTaskTitle(this.task().id, value);
  }

  /**
   * 内容输入处理
   * 仅更新本地状态，blur 时才提交到 Store
   */
  onContentInput(value: string) {
    this.localContent.set(value);
    void this.submitTaskContent(this.task().id, value);
  }

  // ========== IME Composition 处理 ==========

  /**
   * IME 输入开始（如中文拼音输入）
   * 标记正在进行 composition，避免中间态被提交
   */
  onCompositionStart(field: 'title' | 'content'): void {
    this.composingState[field] = true;
  }

  /**
   * IME 输入完成
   * 立即同步最终值到本地状态并提交到 Store
   */
  onCompositionEnd(field: 'title' | 'content', value: string): void {
    this.composingState[field] = false;
    if (field === 'title') {
      this.localTitle.set(value);
      void this.submitTaskTitle(this.task().id, value);
    } else if (field === 'content') {
      this.localContent.set(value);
      void this.submitTaskContent(this.task().id, value);
    }
  }

  /**
   * 检查是否有任何字段正在 IME 输入中
   */
  private isComposing(): boolean {
    return this.composingState.title || this.composingState.content;
  }

  async onExpectedMinutesChange(value: string): Promise<boolean> {
    const taskId = this.task().id;
    const draftValue = this.sidecarDraft.setExpectedMinutes(value);
    return this.draftPersistence.submitPlanner('expectedMinutes', taskId, draftValue,
      () => this.taskOpsAdapter.updateTaskExpectedMinutes(taskId, parseOptionalMinutes(value)),
    );
  }

  async onWaitMinutesChange(value: string): Promise<boolean> {
    const taskId = this.task().id;
    const draftValue = this.sidecarDraft.setWaitMinutes(value);
    return this.draftPersistence.submitPlanner('waitMinutes', taskId, draftValue,
      () => this.taskOpsAdapter.updateTaskWaitMinutes(taskId, parseOptionalMinutes(value)),
    );
  }

  async onCognitiveLoadChange(value: string): Promise<boolean> {
    const taskId = this.task().id;
    const { draftValue, persistedValue } = this.sidecarDraft.setCognitiveLoad(value);
    return this.draftPersistence.submitPlanner('cognitiveLoad', taskId, draftValue,
      () => this.taskOpsAdapter.updateTaskCognitiveLoad(taskId, persistedValue),
    );
  }

  onAttentionInput(value: string): void {
    this.setAttentionDraftRows(this.sidecarDraft.setAttentionRowsFromText(value, this.task().attentionMeta));
  }

  onAttentionRowInput(index: number, value: string): void {
    this.setAttentionDraftRows(this.sidecarDraft.setAttentionRowText(index, value));
  }

  addAttentionRow(): void {
    this.sidecarDraft.addAttentionRowLocal();
  }

  toggleAttentionRowsExpanded(): void {
    this.sidecarDraft.toggleAttentionRowsExpanded();
  }

  removeAttentionRow(index: number): void {
    this.setAttentionDraftRows(this.sidecarDraft.removeAttentionRow(index));
  }

  private setAttentionDraftRows(rows: TaskAttentionDraftItem[]): void {
    this.sidecarDraft.setAttentionRows(rows);
    void this.persistAttentionDraftRows(rows);
  }

  private syncLocalDraftFromTask(task: Task, syncTitle: boolean, syncContent: boolean, syncAttention: boolean): void {
    const persistedDraft = this.draftPersistence.readDraft(task.id);
    if (syncTitle) {
      const title = persistedDraft?.title ?? task.title ?? '';
      this.draftPersistence.syncTextField('title', task.id, title, next => this.localTitle.set(next));
    }
    if (syncContent) {
      const content = persistedDraft?.content ?? task.content ?? '';
      this.draftPersistence.syncTextField('content', task.id, content, next => this.localContent.set(next));
    }
    this.draftPersistence.settleTextFailures(task);
    if (!this.draftPersistence.shouldKeepSidecarDraft(task.id)) {
      this.sidecarDraft.syncFromTask({ task, persistedDraft, syncAttention });
    }
  }

  private persistAttentionDraftRows(rows: TaskAttentionDraftItem[]): Promise<boolean> {
    const currentTask = this.task();
    this.sidecarDraft.markAttentionCommitted(currentTask.id);
    return this.draftPersistence.submitAttention(
      currentTask.id, rows,
      () => this.taskOpsAdapter.updateTaskAttentionItems(currentTask.id, rows),
    );
  }

  onAttentionFocus(): void {
    this.sidecarDraft.markAttentionFocused();
    this.uiState.markEditing();
    const existingTimer = this.unlockTimers.get('attentionMeta');
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
      this.unlockTimers.delete('attentionMeta');
    }
    this.lockTaskFields(this.task().id, ['attentionMeta']);
  }

  onAttentionBlur(): void {
    const currentTask = this.task();
    this.sidecarDraft.markAttentionBlurred(currentTask.id);
    const unlockProjectId = this.resolveProjectId();
    this.persistVisibleAttentionInputs();
    this.trimEmptyAttentionDraftRowsLocal();
    this.scheduleUnlock('attentionMeta', () => {
      this.unlockTaskFields(currentTask.id, ['attentionMeta'], unlockProjectId);
    });
  }

  private trimEmptyAttentionDraftRowsLocal(): void {
    const trimmedRows = this.sidecarDraft.trimEmptyAttentionRows();
    if (trimmedRows) {
      void this.persistAttentionDraftRows(trimmedRows);
    }
  }

  /**
   * Markdown 预览区域点击处理
   * 点击待办 checkbox 时切换完成状态；点击其他区域进入编辑模式
   */
  async onPreviewClick(event: MouseEvent): Promise<void> {
    await this.previewController.onPreviewClick(event);
  }

  async addQuickTodo(inputElement: HTMLInputElement): Promise<boolean> {
    if (this.quickTodoSavePending()) return false;

    const submittedValue = inputElement.value;
    const text = submittedValue.trim();
    if (!text) return false;

    const taskId = this.task().id;
    this.quickTodoSavePending.set(true);
    try {
      const saved = await this.taskOpsAdapter.addTodoItem(taskId, text);
      if (!saved) return false;

      if (
        this.isComponentLive &&
        this.task().id === taskId &&
        inputElement.value === submittedValue
      ) {
        inputElement.value = '';
        inputElement.focus();
      }
      return true;
    } catch {
      return false;
    } finally {
      this.quickTodoSavePending.set(false);
    }
  }

  async onAttachmentsChange(attachments: Attachment[]): Promise<void> {
    const persisted = await this.taskOpsAdapter.updateTaskAttachments(this.task().id, attachments);
    if (!persisted) {
      this.attachmentError.emit('附件本地保存失败，请释放浏览器存储空间后重试');
    }
  }

  // ========== 移动端附件管理方法 ==========

  toggleAttachmentList() {
    this.showAttachmentList.update(v => !v);
  }

  async onMobileFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    await this.attachmentController.onMobileFileSelect(input);
  }

  async deleteAttachment(attachment: Attachment, event: Event) {
    await this.attachmentController.deleteAttachment(attachment, event);
  }

  previewImage(attachment: Attachment) {
    this.attachmentController.previewImage(attachment);
  }

}
