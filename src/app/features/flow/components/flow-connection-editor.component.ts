import { Component, ChangeDetectionStrategy, input, output, signal, ElementRef, ViewChild, computed, OnInit, OnDestroy, HostListener, effect, inject, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { COMPOSITION_BUFFER_MODE, FormsModule } from '@angular/forms';
import type { ConnectionEditorMode, ConnectionEditorData } from '../../../../models/flow-view-state';
import { ToastService } from '../../../../services/toast.service';
import { SafeMarkdownPipe } from '../../../shared/pipes/safe-markdown.pipe';
import { LoggerService } from '../../../../services/logger.service';
import { handleMarkdownLinkAction } from '../../../../utils/markdown';
import {
  buildConnectionEditorPayloadKey,
  buildConnectionEditorSessionState as buildConnectionEditorSessionStatePure,
  canRunDelayedConnectionEditorAction,
  clampConnectionEditorPosition,
  compressConnectionDisplayId,
  createConnectionEditorSaveContext,
  resizeConnectionEditorTextarea,
  resolveConnectionEditorBlurAction,
  resolveConnectionEditorComposingClickAction,
  resolveConnectionEditorDocumentInteraction,
  resolveConnectionEditorSaveContext,
  resolveConnectionEditorSavePayload,
  shouldSkipConnectionEditorContentSync,
  type ConnectionEditorDocumentInteractionContext,
  type ConnectionEditorSavePayload,
  type ConnectionEditorSaveContext,
  type ConnectionEditorSessionState,
  type ConnectionTasks,
} from './flow-connection-editor.helpers';

export { ConnectionEditorData, ConnectionEditorMode };
export type { ConnectionTasks, ConnectionEditorSavePayload };

const OPEN_CLICK_GUARD_MS = 50;
const MODE_SWITCH_CLICK_GUARD_MS = 220;

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
  templateUrl: './flow-connection-editor.component.html',
})
export class FlowConnectionEditorComponent implements OnInit, OnDestroy {
  @ViewChild('descInput') descInput!: ElementRef<HTMLTextAreaElement>;
  @ViewChild('titleInput') titleInput!: ElementRef<HTMLInputElement>;
  @ViewChild('editorContainer') editorContainer!: ElementRef<HTMLDivElement>;

  private readonly loggerService = inject(LoggerService);
  private readonly toast = inject(ToastService);
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
  readonly openTask = output<string>();

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
  private isDestroyed = false;

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
      this.handleMissingConnectionData(previousSessionKey, previousContext);
      return;
    }

    const state = this.buildConnectionSessionState(data, readOnly, previousSessionKey, previousContext);
    this.refreshOutsideGuardIfNeeded(state);
    if (previousSessionKey && previousContext && state.isNewSession && this.canPersistBeforeSessionSwitch()) {
      this.persistCurrentEdits(previousContext);
    }

    if (state.isNewSession) {
      this.startConnectionEditorSession(state);
    } else {
      const shouldReturn = this.syncExistingConnectionEditorSession(state, readOnly);
      if (shouldReturn) {
        return;
      }
    }

    this.finalizeConnectionDataSync(data, state.sessionKey);
  });

  // 预览态显示已持久化的内容（data），而非未保存的 editingTitle/Description。
  // 过去使用 `editingTitle || data?.title || ''` 有两个坑：
  //   1) editingTitle 是普通字段，非 signal，在 computed 中不会被追踪；
  //   2) `||` 把空字符串视为 falsy，清空标题会回退显示旧值，造成“输入被吞”错觉。
  // 编辑态输入由模板中的 [(ngModel)]="editingTitle" 直接驱动，与此处无关。
  readonly currentTitle = computed(() => this.data()?.title ?? '');
  readonly currentDescription = computed(() => this.data()?.description ?? '');

  private handleMissingConnectionData(
    previousSessionKey: string | null,
    previousContext: ConnectionEditorSaveContext | null,
  ): void {
    if (previousSessionKey && previousContext && this.canPersistBeforeSessionSwitch()) {
      this.persistCurrentEdits(previousContext);
    }

    this.activeSessionContext = null;
    this.lastSessionKey = null;
    this.lastEmittedPayloadKey = null;
    this.closeRequested = false;
    this.deleteRequested = false;
  }

  private buildConnectionSessionState(
    data: ConnectionEditorData,
    readOnly: boolean,
    previousSessionKey: string | null,
    previousContext: ConnectionEditorSaveContext | null,
  ): ConnectionEditorSessionState {
    return buildConnectionEditorSessionStatePure({
      data,
      readOnly,
      previousSessionKey,
      previousContext,
      currentIsEditMode: untracked(() => this.isEditMode()),
    });
  }

  private canPersistBeforeSessionSwitch(): boolean {
    return !this.closeRequested && !this.deleteRequested;
  }

  private refreshOutsideGuardIfNeeded(state: ConnectionEditorSessionState): void {
    if (state.isNewSession || (!state.currentIsEditMode && state.nextIsEditMode)) {
      this.ignoreOutsideUntil = Date.now() + OPEN_CLICK_GUARD_MS;
    }
  }

  private startConnectionEditorSession(state: ConnectionEditorSessionState): void {
    const { data, nextIsEditMode } = state;

    this.activeSessionContext = createConnectionEditorSaveContext(data);
    this.editingTitle = data.title || '';
    this.editingDescription = data.description || '';
    this.isEditMode.set(nextIsEditMode);
    this.closeRequested = false;
    this.deleteRequested = false;
    this.lastEmittedPayloadKey = null;

    if (nextIsEditMode) {
      this.scheduleFocusInput();
    }
  }

  private syncExistingConnectionEditorSession(
    state: ConnectionEditorSessionState,
    readOnly: boolean,
  ): boolean {
    const modeChanged = state.currentIsEditMode !== state.nextIsEditMode;
    if (modeChanged) {
      this.applyConnectionEditorModeChange(state, readOnly);
    }

    if (state.nextIsEditMode) {
      this.finalizeConnectionDataSync(state.data, state.sessionKey);
      return true;
    }

    if (!this.shouldSkipServiceContentSync(modeChanged, state.currentIsEditMode, state.nextIsEditMode)) {
      this.editingTitle = state.data.title || '';
      this.editingDescription = state.data.description || '';
    }

    return false;
  }

  private applyConnectionEditorModeChange(state: ConnectionEditorSessionState, readOnly: boolean): void {
    if (state.currentIsEditMode && !state.nextIsEditMode && this.canPersistBeforeSessionSwitch()) {
      if (readOnly) {
        this.editingTitle = state.data.title || '';
        this.editingDescription = state.data.description || '';
        this.lastEmittedPayloadKey = null;
      } else {
        this.persistCurrentEdits(state.previousContext ?? undefined);
      }
      this.ignoreOutsideUntil = Date.now() + MODE_SWITCH_CLICK_GUARD_MS;
    }

    this.isEditMode.set(state.nextIsEditMode);
    if (state.currentIsEditMode && !state.nextIsEditMode && readOnly) {
      this.modeChange.emit('preview');
    }
    if (state.nextIsEditMode) {
      this.scheduleFocusInput();
    }
  }

  private shouldSkipServiceContentSync(
    modeChanged: boolean,
    currentIsEditMode: boolean,
    nextIsEditMode: boolean,
  ): boolean {
    return shouldSkipConnectionEditorContentSync({
      modeChanged,
      currentIsEditMode,
      nextIsEditMode,
      hasLastEmittedPayload: this.lastEmittedPayloadKey !== null,
    });
  }

  private finalizeConnectionDataSync(data: ConnectionEditorData, sessionKey: string): void {
    this.lastSessionKey = sessionKey;
    if (this.lastEmittedPayloadKey === buildConnectionEditorPayloadKey(
      data.sourceId,
      data.targetId,
      data.title || '',
      data.description || '',
    )) {
      this.lastEmittedPayloadKey = null;
    }
  }

  // 计算限制在视口内的位置（已由服务端处理，这里做兜底）
  readonly clampedPosition = computed(() => {
    const pos = this.position();
    return clampConnectionEditorPosition({
      position: pos,
      viewport: {
        width: typeof window !== 'undefined' ? window.innerWidth : 1000,
        height: typeof window !== 'undefined' ? window.innerHeight : 800,
      },
      editor: { width: 208, height: 180 },
      padding: 12,
    });
  });

  ngOnInit(): void {
    // 初始化逻辑已由 dataSyncEffect 统一处理
  }

  ngOnDestroy(): void {
    if (this.isDestroyed) {
      return;
    }

    // 销毁前 flush 一次，避免 500ms 防抖期内因切换/关闭丢字。
    // 使用 activeSessionContext 作为基准，配合 lastEmittedPayloadKey 去重，不会重复 emit。
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      if (this.activeSessionContext && !this.deleteRequested) {
        try {
          this.saveContent(this.activeSessionContext);
        } catch {
          // 销毁期间忽略保存异常，避免阻塞组件销毁
        }
      }
    }
    if (this.focusTimer !== null) {
      clearTimeout(this.focusTimer);
      this.focusTimer = null;
    }
    this.isDestroyed = true;
  }

  /**
   * 监听全局点击事件
   * - 编辑模式下，点击空白区域或外部时，退出编辑模式并保存
   * - 非编辑模式下，点击外部时关闭编辑器
   */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const context = this.getDocumentInteractionContext(event.target);
    if (!context) return;

    if (this.isEditMode()) {
      this.handleDocumentClickInEditMode(context);
      return;
    }

    if (!context.clickedInside && Date.now() >= this.ignoreOutsideUntil) {
      this.saveAndClose();
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
    if (this.isDestroyed) return;

    const context = this.getDocumentInteractionContext(event.target);
    if (!context) return;

    // 在事件开始时捕获当前模式状态，防止 GoJS backgroundClick 事件先修改模式导致竞争条件
    const wasEditMode = this.isEditMode();

    // 如果正在 IME 输入中，使用更长的延迟等待 compositionend
    const delayMs = this.isComposing() ? 100 : 50;
    if (this.isComposing()) {
      this.logger.debug('正在 IME 输入中，使用更长延迟处理触摸事件');
    }

    if (wasEditMode) {
      this.handleDocumentTouchInEditMode(context, delayMs);
      return;
    }

    if (!context.clickedInside && Date.now() >= this.ignoreOutsideUntil) {
      this.saveAndClose();
    }
  }

  private getDocumentInteractionContext(target: EventTarget | null) {
    return resolveConnectionEditorDocumentInteraction({
      target,
      editorElement: this.editorContainer?.nativeElement,
      closeRequested: this.closeRequested,
      ignoreOutsideUntil: this.ignoreOutsideUntil,
      isSelecting: this.isSelecting,
      now: Date.now(),
    });
  }

  private handleDocumentClickInEditMode(
    context: ConnectionEditorDocumentInteractionContext,
  ): void {
    if (context.isInteractiveElement) {
      this.logger.debug('点击可交互元素，保持编辑模式');
      return;
    }

    if (this.isComposing()) {
      this.deferComposingDocumentClick(context.clickedInside);
      return;
    }

    if (context.clickedInside) {
      this.logger.debug('点击编辑器空白区域，退出编辑模式');
      this.exitEditMode();
      return;
    }

    this.logger.debug('点击编辑器外部，保存并关闭');
    this.saveAndClose();
  }

  private deferComposingDocumentClick(clickedInside: boolean): void {
    const sessionKey = this.lastSessionKey;
    setTimeout(() => {
      const action = resolveConnectionEditorComposingClickAction({
        canRunDelayedAction: this.canRunDelayedOpenSessionAction(sessionKey),
        clickedInside,
        isEditMode: this.isEditMode(),
      });
      if (action === 'force-exit-edit') {
        this.exitEditMode(true);
      } else if (action === 'save-and-close') {
        this.saveAndClose();
      }
    }, 100);
  }

  private handleDocumentTouchInEditMode(
    context: ConnectionEditorDocumentInteractionContext,
    delayMs: number,
  ): void {
    if (context.isInteractiveElement) {
      this.logger.debug('触摸可交互元素，保持编辑模式');
      return;
    }

    this.logger.debug(
      context.clickedInside
        ? '触摸编辑器空白区域，退出编辑模式'
        : '触摸编辑器外部，保存并切换到预览模式'
    );
    const sessionKey = this.lastSessionKey;
    setTimeout(() => {
      if (!this.canRunDelayedOpenSessionAction(sessionKey)) return;
      this.exitEditMode(this.isComposing());
    }, delayMs);
  }

  private canRunDelayedOpenSessionAction(sessionKey: string | null): boolean {
    return canRunDelayedConnectionEditorAction({
      isDestroyed: this.isDestroyed,
      closeRequested: this.closeRequested,
      sessionKey,
      lastSessionKey: this.lastSessionKey,
    });
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
    if (event instanceof MouseEvent && this.handlePreviewLinkClick(event)) {
      return;
    }

    event.stopPropagation();
    this.enterEditMode();
  }

  private handlePreviewLinkClick(event: MouseEvent): boolean {
    const linkTarget = handleMarkdownLinkAction(event, this.toast);
    if (!linkTarget) {
      // null = 无链接; false = 已内部消化（blocked/internal/local/external）
      return linkTarget === false;
    }

    // task 类型：由组件决定导航行为
    if (linkTarget.kind === 'task' && linkTarget.taskId) {
      this.openTask.emit(linkTarget.taskId);
    }
    return true;
  }

  /**
   * 退出编辑模式
   * 注意：必须先同步 DOM 状态再切换模式，否则输入框被销毁后无法获取最新值
   * 若正在 IME 输入（compositionstart ~ compositionend 之间），需等待组合完成再读取 DOM value，
   * 否则最后一个中文字符未 commit 就被保存，表现为“吞字”。
   */
  exitEditMode(force = false): void {
    if (this.isDestroyed) {
      return;
    }

    if (!this.isEditMode()) {
      return;
    }
    if (this.isComposing() && !force) {
      this.logger.debug('exitEditMode: IME 输入中，延迟等待组合结束');
      const sessionKey = this.lastSessionKey;
      setTimeout(() => {
        if (this.isDestroyed) {
          return;
        }

        if (sessionKey === null || sessionKey !== this.lastSessionKey) {
          return;
        }

        if (this.isEditMode()) {
          this.exitEditMode();
        }
      }, 100);
      return;
    }
    if (force && this.isComposing()) {
      this.composingState.title = false;
      this.composingState.description = false;
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
    if (this.isDestroyed) return;

    // 立即同步 DOM 值，确保在关闭前获取最新输入
    this.syncEditorStateFromDom();

    // 获取新的焦点元素
    const relatedTarget = event.relatedTarget as HTMLElement;

    // 延迟检查，给浏览器时间处理焦点转移
    const sessionKey = this.lastSessionKey;
    setTimeout(() => {
      const action = resolveConnectionEditorBlurAction({
        canRunDelayedAction: this.canRunDelayedOpenSessionAction(sessionKey),
        isEditMode: this.isEditMode(),
        editorElement: this.editorContainer?.nativeElement,
        activeElement: document.activeElement,
        relatedTarget,
      });
      if (action === 'exit-edit') {
        this.exitEditMode();
      }
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
      resizeConnectionEditorTextarea(this.descInput.nativeElement);
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
    const resolvedPayload = resolveConnectionEditorSavePayload({
      context,
      draft: payload,
      lastEmittedPayloadKey: this.lastEmittedPayloadKey,
    });
    if (!resolvedPayload) {
      return;
    }

    const { payloadKey, ...savePayload } = resolvedPayload;
    this.lastEmittedPayloadKey = payloadKey;
    this.save.emit(savePayload);
  }

  /**
   * 保存并关闭
   * 如果正在 IME 输入中，等待 compositionend 后再保存
   *
   * 使用 activeSessionContext 作为保存上下文，确保最终保存总是与会话开始时的原始值比较，
   * 避免中间的 debounced save 更新了 connectionEditorData 后导致最终保存被跳过。
   */
  private saveAndClose(): void {
    if (this.isDestroyed) return;
    if (this.closeRequested) return;
    this.closeRequested = true;
    this.ignoreOutsideUntil = Date.now() + 250;

    // 立即从 DOM 读取最新值（此时输入框还存在）
    this.syncEditorStateFromDom();

    // 如果正在 IME 输入中，延迟保存以等待 compositionend
    if (this.isComposing()) {
      this.logger.debug('IME 输入中，延迟保存');
      setTimeout(() => {
        if (this.isDestroyed) {
          return;
        }

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
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.syncEditorStateFromDom();
    this.saveContent(context);
  }

  private scheduleDebouncedSave(): void {
    if (this.isDestroyed) return;

    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      if (this.isDestroyed) {
        return;
      }

      this.saveTimer = null;
      if (this.isComposing()) {
        return;
      }
      this.saveContent();
    }, 500);
  }

  private syncEditorStateFromDom(): { title: string; description: string } {
    const liveTitle = this.titleInput?.nativeElement?.value ?? this.editingTitle;
    const liveDescription = this.descInput?.nativeElement?.value ?? this.editingDescription;

    this.editingTitle = liveTitle;
    this.editingDescription = liveDescription;

    if (this.descInput?.nativeElement) {
      resizeConnectionEditorTextarea(this.descInput.nativeElement);
    }

    return {
      title: liveTitle,
      description: liveDescription,
    };
  }

  /**
   * 压缩显示ID
   */
  compressDisplayId(displayId: string | undefined): string {
    return compressConnectionDisplayId(displayId);
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

  private scheduleFocusInput(): void {
    if (this.isDestroyed) return;

    if (this.focusTimer !== null) {
      clearTimeout(this.focusTimer);
    }

    // 延迟聚焦，确保输入控件已渲染
    this.focusTimer = setTimeout(() => {
      if (this.isDestroyed) {
        return;
      }

      const input = this.titleInput?.nativeElement ?? this.descInput?.nativeElement;
      if (input) {
        input.focus();
      }

      if (this.descInput?.nativeElement) {
        resizeConnectionEditorTextarea(this.descInput.nativeElement);
      }

      this.focusTimer = null;
    }, 50);
  }

  private getSaveContext(override?: ConnectionEditorSaveContext): ConnectionEditorSaveContext | null {
    // 默认使用会话初始基准（activeSessionContext），而不是被 saveConnectionContent 回流覆盖过的 data()。
    // 去重完全交给 lastEmittedPayloadKey，避免“data 已被回流 → context 与 payload 相同 → 跳过保存”
    // 导致后续输入无法落盘的隐形漏保存。
    return resolveConnectionEditorSaveContext({
      override,
      activeSessionContext: this.activeSessionContext,
      data: this.data(),
    });
  }

}
