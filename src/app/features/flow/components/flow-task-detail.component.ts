import { Component, ChangeDetectionStrategy, Injector, input, output, computed, inject, OnDestroy, HostListener, ElementRef, effect, untracked, ViewChild, ChangeDetectorRef, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { UserSessionService } from '../../../../services/user-session.service';
import { ToastService } from '../../../../services/toast.service';
import { Task, Attachment, TaskAttentionDraftItem } from '../../../../models';
import { SafeMarkdownPipe } from '../../../shared/pipes/safe-markdown.pipe';
import { FlowTaskDetailFormService } from '../services/flow-task-detail-form.service';
import { FlowTaskOperationsService } from '../services/flow-task-operations.service';
import { toggleMarkdownTodo, getTodoIndexFromClick, handleMarkdownLinkAction } from '../../../../utils/markdown';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { SimpleReminderService } from '../../../../services/simple-reminder.service';
import { KnowledgeAnchorComponent } from '../../../shared/components/knowledge-anchor/knowledge-anchor.component';
import type { TaskSidecarBadge } from '../../../../utils/task-sidecar';
import { parseOptionalMinutes } from '../../parking/utils/dock-format';
import { FlowTaskDetailAttentionDraftController } from './flow-task-detail-attention-draft.helpers';
import { FlowTaskDetailSidecarPreviewController } from './flow-task-detail-sidecar-preview.controller';
import { buildFlowTaskDetailSidecarSummary } from './flow-task-detail-summary.helpers';
import {
  computeTaskDetailAutoDrawerHeightVh,
  computeTaskDetailDragPosition,
  computeTaskDetailDragState,
  computeTaskDetailDrawerResizeHeightVh,
  measureTaskDetailIntrinsicContentHeight,
  resolveTaskDetailContentMaxHeightClass,
  resolveTaskDetailMobileDrawerElements,
  shouldEmitTaskDetailDrawerHeight,
} from './flow-task-detail-layout.helpers';

const IGNORE_PREVIEW_CLICK_AFTER_TASK_SWITCH_MS = 180;
const DRAWER_MIN_HEIGHT_VH = 8;
const DRAWER_MAX_HEIGHT_VH = 70;

/** 任务详情面板 - 桌面端：浮动面板, 移动端：底部抽屉, 默认预览模式 */
@Component({
  selector: 'app-flow-task-detail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, SafeMarkdownPipe, KnowledgeAnchorComponent],
  providers: [FlowTaskDetailFormService],
  // Host defaults to pointer-events none; interactive children explicitly opt in.
  host: { style: 'pointer-events: none' },
  templateUrl: './flow-task-detail.component.html',
})
export class FlowTaskDetailComponent implements OnDestroy {
  // P2-1 迁移：直接注入子服务
  private readonly injector = inject(Injector);
  readonly uiState = inject(UiStateService);
  readonly projectState = inject(ProjectStateService);
  readonly userSession = inject(UserSessionService);
  private readonly toast = inject(ToastService);
  private readonly elementRef = inject(ElementRef);
  private readonly cdr = inject(ChangeDetectorRef);
  readonly formService = inject(FlowTaskDetailFormService);
  private readonly flowTaskOps = inject(FlowTaskOperationsService);
  private readonly reminderService = inject(SimpleReminderService);

  private get taskOpsAdapter(): TaskOperationAdapterService {
    return this.injector.get(TaskOperationAdapterService);
  }

  @ViewChild('mobileDrawer') private mobileDrawer?: ElementRef<HTMLDivElement>;
  @ViewChild('mobileDrawerTitle') private mobileDrawerTitle?: ElementRef<HTMLDivElement>;
  @ViewChild('mobileDrawerContent') private mobileDrawerContent?: ElementRef<HTMLDivElement>;
  @ViewChild('mobileDrawerHandle') private mobileDrawerHandle?: ElementRef<HTMLDivElement>;

  private static readonly MOBILE_DRAWER_GUARD_PX = 4;
  private static readonly MOBILE_DRAWER_MIN_VH = 8;
  private static readonly MOBILE_DRAWER_MAX_VH = 70;
  private static readonly MOBILE_DRAWER_HEIGHT_EPSILON_VH = 0.3;
  readonly showReminderMenu = signal(false);
  readonly plannerSaveState = signal<'idle' | 'saving' | 'failed'>('idle');
  readonly reminderPresets = [
    { label: '5m', minutes: 5 },
    { label: '30m', minutes: 30 },
    { label: '2h', minutes: 120 },
  ] as const;
  
  // 输入
  readonly task = input<Task | null>(null);
  readonly position = input<{ x: number; y: number }>({ x: -1, y: -1 });
  readonly drawerHeight = input<number>(35); // vh unit
  readonly autoHeightEnabled = input<boolean>(true);
  readonly layoutTick = input<number>(0);

  // Form state delegated to FlowTaskDetailFormService
  readonly localTitle = this.formService.localTitle;
  readonly localContent = this.formService.localContent;
  readonly isEditMode = this.formService.isEditMode;
  readonly isTogglingMode = this.formService.isTogglingMode;
  private readonly attentionDraft = new FlowTaskDetailAttentionDraftController();
  readonly localAttentionDraft = this.attentionDraft.localDraft;
  readonly attentionDraftRows = this.attentionDraft.rows;
  readonly isAttentionRowsExpanded = this.attentionDraft.expanded;
  readonly visibleAttentionDraftRows = this.attentionDraft.visibleRows;
  readonly hiddenAttentionRowCount = this.attentionDraft.hiddenRowCount;

  readonly isCompactMode = computed(() => !this.autoHeightEnabled() && this.drawerHeight() < 12);
  readonly sidecarSummary = computed(() => buildFlowTaskDetailSidecarSummary(this.task()));
  readonly contentMaxHeight = computed(() =>
    resolveTaskDetailContentMaxHeightClass(this.drawerHeight())
  );

  // Outputs
  readonly positionChange = output<{ x: number; y: number }>();
  readonly drawerHeightChange = output<number>();
  readonly isResizingChange = output<boolean>();
  
  // 任务操作输出
  readonly titleChange = output<{ taskId: string; title: string }>();
  readonly contentChange = output<{ taskId: string; content: string }>();
  readonly attentionChange = output<{ taskId: string; items: TaskAttentionDraftItem[] }>();
  readonly addSibling = output<Task>();
  readonly addChild = output<Task>();
  readonly toggleStatus = output<Task>();
  readonly archiveTask = output<Task>();
  readonly deleteTask = output<Task>();
  readonly parkTask = output<Task>();
  readonly openLinkedTask = output<string>();
  readonly quickTodoAdd = output<{ taskId: string; text: string }>();
  
  // 附件操作输出
  readonly attachmentAdd = output<{ taskId: string; attachment: Attachment }>();
  readonly attachmentRemove = output<{ taskId: string; attachmentId: string }>();
  readonly attachmentsChange = output<{ taskId: string; attachments: Attachment[] }>();
  readonly attachmentError = output<string>();
  
  // 拖动状态
  private dragState = { isDragging: false, startX: 0, startY: 0, offsetX: 0, offsetY: 0 };
  private isResizingDrawer = false;
  private drawerStartY = 0;
  private drawerStartHeight = 0;
  private drawerResizeCleanup: (() => void) | null = null;
  private autoHeightRafId: number | null = null;
  private autoHeightTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAutoHeightSignature = '';
  private lastEmittedVh = -1;
  private isComponentDestroyed = false;
  private ignorePreviewClicksUntil = 0;
  private suppressedDocumentClickStamp: number | null = null;
  private readonly sidecarBadgePreview = new FlowTaskDetailSidecarPreviewController();
  
  constructor() {
    // Split-Brain 核心逻辑：委托给 formService
    this.formService.initSyncEffect(() => this.task());

    effect(() => {
      const currentTask = this.task();
      const taskId = currentTask?.id ?? null;
      if (this.attentionDraft.shouldSyncFromTask(taskId)) {
        this.attentionDraft.setFromMeta(currentTask?.attentionMeta, taskId);
      }
    });

    // 任务切换或详情面板重新打开后，短时间内忽略预览区点击，避免选择任务的同一击穿透到编辑态。
    effect(() => {
      const taskId = this.task()?.id ?? null;
      const isOpen = this.uiState.isFlowDetailOpen();

      if (!isOpen) {
        this.ignorePreviewClicksUntil = 0;
        return;
      }

      if (taskId) {
        this.plannerSaveState.set('idle');
        untracked(() => this.armPreviewEntryGuard());
      }
    });

    // 🔴 移动端自动高度：统一的触发入口（任务/编辑模式变化 + layoutTick 变化）    // 合并为单一 effect，通过签名去重，避免多个 effect 并发触发导致抖动
    effect(() => {
      const task = this.task();
      const isEdit = this.isEditMode();
      const isOpen = this.uiState.isFlowDetailOpen();
      const tick = this.layoutTick();
      
      if (this.uiState.isMobile() && isOpen) {
        const signature = task
          ? `${task.id}|${task.title}|${task.content}|${task.status}|${isEdit ? '1' : '0'}|${tick}`
          : `empty|${isEdit ? '1' : '0'}|${tick}`;
        if (signature === this.lastAutoHeightSignature) return;
        this.lastAutoHeightSignature = signature;
        // 重置发射缓存，允许新一轮测量
        this.lastEmittedVh = -1;
        untracked(() => this.requestAutoHeight());
      } else {
        this.lastAutoHeightSignature = '';
        this.lastEmittedVh = -1;
      }
    });
  }

  private armPreviewEntryGuard(): void {
    this.ignorePreviewClicksUntil = Date.now() + IGNORE_PREVIEW_CLICK_AFTER_TASK_SWITCH_MS;
  }

  // ========== 表单事件委托 ==========

  /**
   * 移动端：请求自动调整高度以适应内容。   *
   * 核心算法：targetPx = titleH + intrinsicContentH + handleH + guard
   * 只使用内容子元素的固有高度，不引入 containerH > contentClientH，
   * 从而确保算法幂等，无论当前抽屉多高，计算结果都一致。
   */
  private requestAutoHeight(): void {
    if (this.isComponentDestroyed) return;
    if (!this.uiState.isMobile() || !this.uiState.isFlowDetailOpen()) return;
    if (!this.autoHeightEnabled()) return;

    // 取消先前的挂起测量，避免多次 emit
    this.cancelPendingAutoHeight();

    this.autoHeightRafId = requestAnimationFrame(() => {
      this.autoHeightRafId = null;
      if (this.isComponentDestroyed) return;
      this.measureAndEmitHeight();
      // 一次延迟收敛：等字段样式稳定后再校验
      this.autoHeightTimer = setTimeout(() => {
        this.autoHeightTimer = null;
        if (!this.isComponentDestroyed) this.measureAndEmitHeight();
      }, 150);
    });
  }

  /**
   * 纯测量 + 发射：不依赖当前容器高度，只用子元素固有尺寸。   * 幂等：同样的内容调用 N 次结果一致，第二次不会 emit。   */
  private measureAndEmitHeight(): void {
    const elements = resolveTaskDetailMobileDrawerElements({
      host: this.elementRef.nativeElement,
      container: this.mobileDrawer?.nativeElement,
      title: this.mobileDrawerTitle?.nativeElement,
      content: this.mobileDrawerContent?.nativeElement,
      handle: this.mobileDrawerHandle?.nativeElement,
    });
    if (!elements) return;

    const viewportHeight = this.getViewportHeight();
    if (viewportHeight <= 0) return;

    const targetVh = computeTaskDetailAutoDrawerHeightVh({
      titleHeight: elements.title.offsetHeight || 0,
      handleHeight: elements.handle.offsetHeight || 0,
      intrinsicContentHeight: measureTaskDetailIntrinsicContentHeight(elements.content),
      viewportHeight,
      guardPx: FlowTaskDetailComponent.MOBILE_DRAWER_GUARD_PX,
      minVh: FlowTaskDetailComponent.MOBILE_DRAWER_MIN_VH,
      maxVh: FlowTaskDetailComponent.MOBILE_DRAWER_MAX_VH,
    });
    if (targetVh === null) return;

    // 只在与上一次发射值有显著差异时 emit
    if (shouldEmitTaskDetailDrawerHeight(
      this.lastEmittedVh,
      targetVh,
      FlowTaskDetailComponent.MOBILE_DRAWER_HEIGHT_EPSILON_VH,
    )) {
      this.lastEmittedVh = targetVh;
      this.drawerHeightChange.emit(targetVh);
    }
  }

  private getViewportHeight(): number {
    if (typeof window === 'undefined') return 0;
    const visualHeight = window.visualViewport?.height ?? 0;
    return visualHeight > 0 ? visualHeight : window.innerHeight;
  }

  private cancelPendingAutoHeight(): void {
    if (this.autoHeightRafId !== null) {
      cancelAnimationFrame(this.autoHeightRafId);
      this.autoHeightRafId = null;
    }
    if (this.autoHeightTimer !== null) {
      clearTimeout(this.autoHeightTimer);
      this.autoHeightTimer = null;
    }
  }
  
  /** 输入框聚焦处理 */
  onInputFocus(field: 'title' | 'content') {
    this.uiState.markEditing();
    this.formService.onInputFocus(field, this.task());
  }

  /** 输入框失焦处理 */
  onInputBlur(field: 'title' | 'content') {
    const result = this.formService.onInputBlur(field, this.task());
    if (result) {
      if (result.field === 'title') {
        this.titleChange.emit({ taskId: result.taskId, title: result.value });
      } else {
        this.contentChange.emit({ taskId: result.taskId, content: result.value });
      }
    }
  }
  
  /** 本地标题变更 */
  onLocalTitleChange(value: string) {
    const result = this.formService.onLocalTitleChange(value, this.task());
    if (result) {
      this.titleChange.emit(result);
    }
  }

  /** 本地内容变更 */
  onLocalContentChange(value: string) {
    const result = this.formService.onLocalContentChange(value, this.task());
    if (result) {
      this.contentChange.emit(result);
    }
  }

  onLocalAttentionDraftChange(value: string): void {
    const currentTask = this.task();
    this.emitAttentionDraftRows(this.attentionDraft.setRowsFromText(value, currentTask?.attentionMeta));
  }

  onAttentionDraftRowChange(index: number, value: string): void {
    this.emitAttentionDraftRows(this.attentionDraft.updateRow(index, value));
  }

  addAttentionDraftRow(): void {
    this.attentionDraft.addEmptyRowLocal();
  }

  toggleAttentionRowsExpanded(): void {
    this.attentionDraft.toggleExpanded();
  }

  removeAttentionDraftRow(index: number): void {
    this.emitAttentionDraftRows(this.attentionDraft.removeRow(index));
  }

  private emitAttentionDraftRows(rows: TaskAttentionDraftItem[]): void {
    const currentTask = this.task();
    if (!currentTask) return;
    this.attentionDraft.markCommittedTask(currentTask.id);
    this.attentionChange.emit({
      taskId: currentTask.id,
      items: rows,
    });
  }

  onAttentionFocus(): void {
    this.attentionDraft.markFocused();
    this.uiState.markEditing();
  }

  onAttentionBlur(): void {
    const currentTask = this.task();
    this.attentionDraft.markBlurred(currentTask?.id ?? null);
    this.attentionDraft.trimEmptyRowsLocal();
  }

  async onExpectedMinutesChange(taskId: string, raw: string | number | null): Promise<boolean> {
    return this.persistPlannerField(
      () => this.taskOpsAdapter.updateTaskExpectedMinutes(taskId, parseOptionalMinutes(raw)),
    );
  }

  async onWaitMinutesChange(taskId: string, raw: string | number | null): Promise<boolean> {
    return this.persistPlannerField(
      () => this.taskOpsAdapter.updateTaskWaitMinutes(taskId, parseOptionalMinutes(raw)),
    );
  }

  async onCognitiveLoadChange(taskId: string, raw: string | null): Promise<boolean> {
    const normalized = raw === 'high' || raw === 'low' ? raw : null;
    return this.persistPlannerField(
      () => this.taskOpsAdapter.updateTaskCognitiveLoad(taskId, normalized),
    );
  }

  private async persistPlannerField(save: () => Promise<boolean>): Promise<boolean> {
    this.plannerSaveState.set('saving');
    const saved = await save();
    this.plannerSaveState.set(saved ? 'idle' : 'failed');
    this.cdr.markForCheck();
    return saved;
  }

  showSidecarBadgePreview(event: Event, badge: TaskSidecarBadge): void {
    this.sidecarBadgePreview.show(event, badge);
  }

  hideSidecarBadgePreview(): void {
    this.sidecarBadgePreview.hide();
  }

  async onParkTaskClick(task: Task, event?: Event): Promise<void> {
    event?.stopPropagation();
    const parked = await this.flowTaskOps.parkTask(task);
    if (!parked) return;
    this.parkTask.emit(task);
    this.cdr.markForCheck();
  }

  toggleReminderMenu(): void {
    this.showReminderMenu.update(value => !value);
  }

  closeReminderMenu(): void {
    this.showReminderMenu.set(false);
  }

  async onReminderTriggerClick(task: Task, event?: Event): Promise<void> {
    event?.stopPropagation();
    if (task.parkingMeta?.state !== 'parked') {
      const parked = await this.flowTaskOps.parkTask(task);
      if (!parked) return;
      this.parkTask.emit(task);
    }
    this.toggleReminderMenu();
  }

  async setReminderPreset(taskId: string, minutes: number): Promise<void> {
    const currentTask = this.task();
    if (currentTask?.id === taskId && currentTask.parkingMeta?.state !== 'parked') {
      const parked = await this.flowTaskOps.parkTask(currentTask);
      if (!parked) return;
      this.parkTask.emit(currentTask);
    }
    const reminderAt = new Date(Date.now() + minutes * 60_000).toISOString();
    const saved = await this.reminderService.setReminder(taskId, reminderAt);
    if (!saved) return;
    this.showReminderMenu.set(false);
    this.cdr.markForCheck();
  }

  async clearReminder(taskId: string): Promise<void> {
    const saved = await this.reminderService.cancelReminder(taskId);
    if (!saved) return;
    this.showReminderMenu.set(false);
    this.cdr.markForCheck();
  }

  onEditToggleClick(): void {
    if (Date.now() < this.ignorePreviewClicksUntil && this.isEditMode()) {
      if (this.isTogglingMode()) {
        this.isTogglingMode.set(false);
      }
      return;
    }
    this.toggleEditMode();
  }

  /** 切换编辑模式 */
  toggleEditMode(): void { this.formService.toggleEditMode(); }

  /**
   * Markdown 预览区域点击处理
   * 点击待办 checkbox 时切换完成状态；点击其他区域进入编辑模式
   */
  async onPreviewClick(event: MouseEvent): Promise<void> {
    if (this.handlePreviewLinkClick(event)) {
      return;
    }

    event.stopPropagation();
    const todoIndex = getTodoIndexFromClick(event);
    if (todoIndex !== null) {
      const currentTask = this.task();
      if (!currentTask) return;
      const currentContent = this.formService.localContent() || currentTask.content || '';
      const newContent = toggleMarkdownTodo(currentContent, todoIndex);
      const saved = await this.taskOpsAdapter.updateTaskContent(currentTask.id, newContent);
      if (!saved) {
        this.cdr.markForCheck();
        return;
      }
      this.formService.localContent.set(newContent);
      // 强制标记组件需要重新检测，确保 OnPush 模式下 UI 刷新
      this.cdr.markForCheck();
    } else {
      if (Date.now() < this.ignorePreviewClicksUntil) {
        return;
      }
      this.suppressedDocumentClickStamp = event.timeStamp;
      this.toggleEditMode();
    }
  }

  private handlePreviewLinkClick(event: MouseEvent): boolean {
    const linkTarget = handleMarkdownLinkAction(event, this.toast);
    if (!linkTarget) {
      return linkTarget === false;
    }

    if (linkTarget.kind === 'task' && linkTarget.taskId) {
      this.openLinkedTask.emit(linkTarget.taskId);
    }
    return true;
  }

  /** 监听 document 点击事件，编辑模式下点击非交互区域退出编辑 */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.suppressedDocumentClickStamp !== null) {
      const isSuppressedClick = Math.abs(event.timeStamp - this.suppressedDocumentClickStamp) < 1;
      this.suppressedDocumentClickStamp = null;
      if (isSuppressedClick) {
        return;
      }
    }
    if (this.formService.shouldExitEditMode(event.target as HTMLElement, this.elementRef.nativeElement)) {
      this.isEditMode.set(false);
      if (this.isTogglingMode()) {
        this.isTogglingMode.set(false);
      }
    }
  }

  /** 监听 document 触摸事件（移动端），编辑模式下触摸非交互区域退出编辑 */
  @HostListener('document:touchstart', ['$event'])
  onDocumentTouchStart(event: TouchEvent): void {
    const activeElement = document.activeElement;
    if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
      return;
    }
    if (this.formService.shouldExitEditMode(event.target as HTMLElement, this.elementRef.nativeElement)) {
      this.isEditMode.set(false);
      if (this.isTogglingMode()) {
        this.isTogglingMode.set(false);
      }
    }
  }


  
  startDrag(event: MouseEvent | TouchEvent) {
    event.preventDefault();
    const _pos = this.position();
    const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
    const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;
    
    const target = event.target as HTMLElement;
    const panelEl = target.closest('.absolute') as HTMLElement;
    if (!panelEl) return;
    
    const parentEl = panelEl.parentElement;
    if (!parentEl) return;
    
    const parentRect = parentEl.getBoundingClientRect();
    const panelRect = panelEl.getBoundingClientRect();
    
    this.dragState = {
      isDragging: true,
      ...computeTaskDetailDragState({
        clientX,
        clientY,
        panelRect,
        parentRect,
      }),
    };
    
    document.addEventListener('mousemove', this.onDrag);
    document.addEventListener('mouseup', this.stopDrag);
    document.addEventListener('touchmove', this.onDrag);
    document.addEventListener('touchend', this.stopDrag);
    window.addEventListener('blur', this.stopDrag);
  }
  
  private onDrag = (event: MouseEvent | TouchEvent) => {
    if (!this.dragState.isDragging) return;
    if (event instanceof MouseEvent && event.buttons === 0) {
      this.stopDrag();
      return;
    }
    if (event instanceof TouchEvent && event.touches.length === 0) {
      this.stopDrag();
      return;
    }
    
    const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
    const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;
    
    const position = computeTaskDetailDragPosition({
      startClientX: this.dragState.startX,
      startClientY: this.dragState.startY,
      currentClientX: clientX,
      currentClientY: clientY,
      offsetX: this.dragState.offsetX,
      offsetY: this.dragState.offsetY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      panelWidth: 256,
      panelHeight: 384,
      marginPx: 20,
    });

    this.positionChange.emit(position);
  };
  
  private stopDrag = () => {
    this.dragState.isDragging = false;
    document.removeEventListener('mousemove', this.onDrag);
    document.removeEventListener('mouseup', this.stopDrag);
    document.removeEventListener('touchmove', this.onDrag);
    document.removeEventListener('touchend', this.stopDrag);
    window.removeEventListener('blur', this.stopDrag);
  };

  /** 重置面板位置到默认位置（右上角） */
  resetPosition() { this.positionChange.emit({ x: -1, y: -1 }); }
  
  startDrawerResize(event: TouchEvent | MouseEvent) {
    event.preventDefault();
    this.cleanupDrawerResizeListeners();

    const startY = this.getDrawerResizeClientY(event);
    if (startY === null) return;

    this.isResizingDrawer = true;
    this.isResizingChange.emit(true);
    this.drawerStartY = startY;
    this.drawerStartHeight = this.drawerHeight();

    const drawerEl = this.elementRef.nativeElement.querySelector('.absolute.z-30') as HTMLElement;
    if (drawerEl) {
      drawerEl.style.willChange = 'height';
    }

    let rafId: number | null = null;

    const onMove = (ev: TouchEvent | MouseEvent) => {
      if (!this.isResizingDrawer) return;
      ev.preventDefault();
      const currentY = this.getDrawerResizeClientY(ev);
      if (currentY === null) return;
      if (rafId) return;

      rafId = this.scheduleDrawerResizeFrame(currentY, () => {
        rafId = null;
      });
    };

    const onEnd = () => {
      this.isResizingDrawer = false;
      this.isResizingChange.emit(false);
      this.cleanupDrawerResizeListeners();
    };

    this.bindDrawerResizeListeners(onMove, onEnd, () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (drawerEl) {
        drawerEl.style.willChange = 'auto';
      }
    });
  }

  private getDrawerResizeClientY(event: TouchEvent | MouseEvent): number | null {
    if (event instanceof TouchEvent) {
      return event.touches.length === 1 ? event.touches[0].clientY : null;
    }

    return event.clientY;
  }

  private scheduleDrawerResizeFrame(currentY: number, onComplete: () => void): number {
    return requestAnimationFrame(() => {
      onComplete();
      if (!this.isResizingDrawer) return;

      const viewportHeight = this.getViewportHeight();
      if (viewportHeight <= 0) return;

      const newHeight = computeTaskDetailDrawerResizeHeightVh({
        currentY,
        startY: this.drawerStartY,
        startHeight: this.drawerStartHeight,
        viewportHeight,
        minVh: DRAWER_MIN_HEIGHT_VH,
        maxVh: DRAWER_MAX_HEIGHT_VH,
      });
      if (newHeight === null) return;
      this.drawerHeightChange.emit(newHeight);
    });
  }

  private bindDrawerResizeListeners(
    onMove: (event: TouchEvent | MouseEvent) => void,
    onEnd: () => void,
    onCleanup: () => void,
  ): void {
    this.drawerResizeCleanup = () => {
      onCleanup();
      window.removeEventListener('touchmove', onMove as EventListener);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
      window.removeEventListener('mousemove', onMove as EventListener);
      window.removeEventListener('mouseup', onEnd);
    };

    window.addEventListener('touchmove', onMove as EventListener, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
    window.addEventListener('mousemove', onMove as EventListener);
    window.addEventListener('mouseup', onEnd);
  }

  private cleanupDrawerResizeListeners(): void {
    const cleanup = this.drawerResizeCleanup;
    this.drawerResizeCleanup = null;
    cleanup?.();
  }
  
  // 内容区域触摸处理 - 防止无限下拉
  onContentTouchStart(event: TouchEvent): void {
    const target = event.target as HTMLElement;
    // 检查是否是内容区域本身或可滚动的子元素
    const scrollableParent = target.closest('.overflow-y-auto') as HTMLElement;
    if (scrollableParent) {
      // 记录初始滚动位置
      scrollableParent.dataset['touchStartScrollTop'] = String(scrollableParent.scrollTop);
    }
  }

  onContentTouchMove(event: TouchEvent): void {
    const target = event.target as HTMLElement;
    const scrollableParent = target.closest('.overflow-y-auto') as HTMLElement;
    
    if (scrollableParent && !this.isResizingDrawer) {
      const scrollTop = scrollableParent.scrollTop;
      const scrollHeight = scrollableParent.scrollHeight;
      const clientHeight = scrollableParent.clientHeight;
      
      const touchStartScrollTop = Number(scrollableParent.dataset['touchStartScrollTop']) || 0;
      const _touch = event.touches[0];
      
      if ((scrollTop === 0 && scrollTop >= touchStartScrollTop) || 
          (scrollTop + clientHeight >= scrollHeight && scrollTop <= touchStartScrollTop)) {
        // 允许内部滚动，不阻止事件
        return;
      }
      
      // 更新滚动位置记录
      scrollableParent.dataset['touchStartScrollTop'] = String(scrollTop);
    }
  }

  async addQuickTodo(taskId: string, inputEl: HTMLInputElement): Promise<boolean> {
    const text = inputEl.value.trim();
    if (!text) return false;

    const saved = await this.flowTaskOps.addQuickTodo(taskId, text);
    if (!saved) return false;
    inputEl.value = '';
    inputEl.focus();
    return true;
  }


  // ========== 生命周期管理 ==========
  ngOnDestroy(): void {
    this.isComponentDestroyed = true;
    this.hideSidecarBadgePreview();
    this.cancelPendingAutoHeight();
    this.stopDrag();
    this.cleanupDrawerResizeListeners();
    this.dragState.isDragging = false;
    this.isResizingDrawer = false;
    this.formService.cleanup();
  }
}
