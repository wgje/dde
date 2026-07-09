import { Component, Injector, input, output, signal, inject, OnDestroy, ChangeDetectionStrategy, computed, ElementRef, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { BlackBoxService } from '../../../../services/black-box.service';
import { FocusPreferenceService } from '../../../../services/focus-preference.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { ToastService } from '../../../../services/toast.service';
import { Task } from '../../../../models';
import { blackBoxEntriesMap } from '../../../../state/focus-stores';
import { BlackBoxPanelComponent } from '../../focus/components/black-box/black-box-panel.component';
import { StrataViewComponent } from '../../focus/components/strata/strata-view.component';
import { readTaskDragPayload, writeTaskDragPayload } from '../../../../utils/task-drag-payload';
import {
  calculateFlowPaletteCompletionBasis,
  calculateFlowPalettePercent,
  filterActiveFlowPaletteBlackBoxEntries,
} from './flow-palette.helpers';

/**
 * 流程图侧边栏组件 (原 Palette/Strata Panel)
 * 职责：项目概览、任务列表、待分配池、历史回溯
 */
@Component({
  selector: 'app-flow-palette',
  standalone: true,
  imports: [CommonModule, BlackBoxPanelComponent, StrataViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './flow-palette.component.html',
  styleUrl: './flow-palette.component.css',
  providers: []
})
export class FlowPaletteComponent implements OnDestroy {
  private readonly injector = inject(Injector);
  readonly uiState = inject(UiStateService);
  readonly projectState = inject(ProjectStateService);
  readonly blackBoxService = inject(BlackBoxService);
  readonly focusPrefs = inject(FocusPreferenceService);
  private readonly toast = inject(ToastService);
  readonly workbenchSectionRef = viewChild<ElementRef<HTMLElement>>('workbenchSection');
  readonly blackboxSectionRef = viewChild<ElementRef<HTMLElement>>('blackboxSection');

  private get taskOpsAdapter(): TaskOperationAdapterService {
    return this.injector.get(TaskOperationAdapterService);
  }

  // 输入
  readonly height = input<number>(200);
  readonly isDropTargetActive = input<boolean>(false);

  // 输出事件
  readonly heightChange = output<number>();
  readonly centerOnNode = output<string>();
  readonly createUnassigned = output<void>();
  readonly taskClick = output<Task>();
  readonly taskDragStart = output<{ event: DragEvent; task: Task }>();
  readonly taskDrop = output<{ event: DragEvent }>();
  readonly taskTouchStart = output<{ event: TouchEvent; task: Task }>();
  readonly taskTouchMove = output<{ event: TouchEvent }>();
  readonly taskTouchEnd = output<{ event: TouchEvent }>();

  // 手势滑动事件
  readonly swipeToText = output<void>();
  readonly swipeToSidebar = output<void>();

  // 内部状态
  readonly draggingId = signal<string | null>(null);
  readonly isOpen = signal<boolean>(true);
  readonly isHistoryExpanded = signal<boolean>(false);
  readonly focusedSection = signal<'unfinished' | 'unassigned' | 'blackbox' | null>(null);
  readonly blackBoxExpandToken = signal(0);
  readonly activeWorkbenchTab = signal<'unfinished' | 'unassigned' | 'blackbox'>('unfinished');

  /** 待分配区每次展示的任务上限，防止 DOM 节点过多导致 UI 崩溃 */
  private readonly UNASSIGNED_PAGE_SIZE = 50;
  readonly unassignedDisplayLimit = signal(50);

  /** 限量展示的待分配任务列表 */
  readonly displayedUnassignedTasks = computed(() =>
    this.projectState.unassignedTasks().slice(0, this.unassignedDisplayLimit())
  );

  /** 是否还有更多未展示的待分配任务 */
  readonly hasMoreUnassigned = computed(() =>
    this.projectState.unassignedTasks().length > this.unassignedDisplayLimit()
  );

  /** 剩余未展示数量 */
  readonly remainingUnassignedCount = computed(() =>
    Math.max(0, this.projectState.unassignedTasks().length - this.unassignedDisplayLimit())
  );

  // 与 FlowToolbar 保持一致，但侧边栏默认展开
  readonly isOpenChange = output<boolean>();

  /** 侧边栏宽度限制：最小 280px，最大 600px */
  private readonly MIN_WIDTH = 280;
  private readonly MAX_WIDTH = 600;
  private readonly DEFAULT_WIDTH = 320;

  /** 可调整的侧边栏宽度 */
  readonly sidebarWidth = signal(this.DEFAULT_WIDTH);
  /** 是否正在拖拽调整宽度 */
  readonly isResizing = signal(false);

  /** 保留兼容（暂不移除），实际使用 sidebarWidth() */
  readonly expandedWidth = '320px';

  readonly livingTasks = computed(() => this.projectState.tasks().filter(task => !task.deletedAt));
  readonly totalTaskCount = computed(() => this.livingTasks().length);
  readonly activeTaskCount = computed(() => this.livingTasks().filter(task => task.status === 'active').length);
  readonly completedTaskCount = computed(() => this.livingTasks().filter(task => task.status === 'completed').length);
  readonly unfinishedCount = computed(() => this.projectState.unfinishedItems().length);
  readonly unassignedCount = computed(() => this.projectState.unassignedTasks().length);

  readonly blackBoxPendingCount = this.blackBoxService.pendingCount;

  /**
   * 所有黑匣子条目（未软删除）
   * 包含已完成（在项目历史回顾中）和未完成（在黑匣子待处理仓中）的条目
   * 【修复 2026-02-20】不按 projectId 过滤，与黑匣子面板和项目历史回顾保持一致。
   * 用户要求完成率基数 = 所有录音内容，分子 = 已完成的录音内容（项目历史回顾中的）
   */
  readonly allBlackBoxEntries = computed(() => {
    return filterActiveFlowPaletteBlackBoxEntries(blackBoxEntriesMap().values());
  });

  /**
   * 完成率基数只包含两类可独立完成的内容：
   * 1. 任务块中的 Markdown 待办事项
   * 2. 黑匣子条目
   *
   * 任务块本身可独立设为 completed 并进入沉积层，但不作为完成率分母。
   */
  readonly completionBasis = computed(() => {
    return calculateFlowPaletteCompletionBasis(
      this.projectState.taskTodoStats(),
      this.allBlackBoxEntries(),
    );
  });

  /**
   * 完成率 = (已完成待办事项 + 已完成黑匣子条目) / (待办事项总数 + 黑匣子条目总数)
   * 任务块只是容器，不直接进入完成率计算。
   */
  readonly completionRate = computed(() => {
    if (!this.projectState.activeProject()) {
      return 0;
    }

    const basis = this.completionBasis();
    return calculateFlowPalettePercent(basis.completed, basis.total);
  });

  readonly projectStatusLabel = computed(() => {
    const total = this.completionBasis().total;
    if (total === 0) return '初始化';
    if (this.completionRate() >= 70) return '稳态推进';
    if (this.completionRate() >= 35) return '高效执行';
    return '启动阶段';
  });

  toggleSidebar() {
    this.isOpen.set(!this.isOpen());
    this.isOpenChange.emit(this.isOpen());
  }

  toggleHistory() {
    this.isHistoryExpanded.set(!this.isHistoryExpanded());
  }

  /**
   * 从沉积层历史中恢复条目
   * - task → 状态设回 active，切换到任务列表并定位节点
   * - black_box → 取消完成标记，切换到黑匣子 tab
   */
  async onRestoreFromHistory(event: { id: string; type: 'task' | 'black_box' }): Promise<void> {
    if (event.type === 'task') {
      const restored = await this.taskOpsAdapter.updateTaskStatus(event.id, 'active');
      if (!restored) {
        this.toast.warning('恢复失败', '任务状态本地保存失败，请释放浏览器存储空间后重试');
        return;
      }
      this.setWorkbenchTab('unfinished');
      this.centerOnNode.emit(event.id);
    } else {
      // black_box：取消完成，恢复为待处理
      const result = await this.blackBoxService.updateDurably(event.id, { isCompleted: false });
      if (!result.ok) {
        this.toast.warning('恢复失败', result.error.message);
        return;
      }
      this.setWorkbenchTab('blackbox');
    }
  }

  setWorkbenchTab(tab: 'unfinished' | 'unassigned' | 'blackbox'): void {
    this.activeWorkbenchTab.set(tab);
    // 切换到待分配 tab 时重置展示上限，避免残留超量 DOM
    if (tab === 'unassigned') {
      this.unassignedDisplayLimit.set(this.UNASSIGNED_PAGE_SIZE);
    }
    // 兼容原有状态逻辑，但不强制绑定
    if (tab === 'unfinished') this.uiState.isFlowUnfinishedOpen.set(true);
    if (tab === 'unassigned') this.uiState.isFlowUnassignedOpen.set(true);
  }

  /** 加载更多待分配任务 */
  loadMoreUnassigned(): void {
    this.unassignedDisplayLimit.update(v => v + this.UNASSIGNED_PAGE_SIZE);
  }

  focusDashboardSection(section: 'unfinished' | 'unassigned' | 'blackbox'): void {
    this.setWorkbenchTab(section);
    
    if (section === 'blackbox') {
      this.blackBoxExpandToken.update(v => v + 1);
    }

    this.focusedSection.set(section);
    
    if (this.sectionFocusTimer !== null) {
      clearTimeout(this.sectionFocusTimer);
    }

    this.sectionFocusTimer = setTimeout(() => {
      this.focusedSection.set(null);
      this.sectionFocusTimer = null;
    }, 1000);
  }

  // 触摸拖动状态
  private touchState = {
    task: null as Task | null,
    startX: 0,
    startY: 0,
    isDragging: false,
    longPressTimer: null as ReturnType<typeof setTimeout> | null,
    ghost: null as HTMLElement | null
  };

  private sectionFocusTimer: ReturnType<typeof setTimeout> | null = null;

  /** Resize 状态：起始宽度和起始鼠标位置 */
  private resizeState = {
    startWidth: 0,
    startX: 0,
  };

  /** 绑定的 resize 事件处理器，用于移除监听 */
  private boundResizeMove = this.onResizeMove.bind(this);
  private boundResizeEnd = this.onResizeEnd.bind(this);
  private boundResizeTouchMove = this.onResizeTouchMove.bind(this);
  private boundResizeTouchEnd = this.onResizeTouchEnd.bind(this);

  ngOnDestroy() {
    // 清理 resize 监听
    this.cleanupResizeListeners();

    if (this.touchState.longPressTimer !== null) {
      clearTimeout(this.touchState.longPressTimer);
      this.touchState.longPressTimer = null;
    }

    if (this.touchState.ghost) {
      this.touchState.ghost.remove();
      this.touchState.ghost = null;
    }

    if (this.sectionFocusTimer !== null) {
      clearTimeout(this.sectionFocusTimer);
      this.sectionFocusTimer = null;
    }
  }

  // ============ Resize 宽度调整逻辑 ============

  /** 鼠标按下开始 resize */
  onResizeStart(event: MouseEvent) {
    event.preventDefault();
    this.resizeState.startWidth = this.sidebarWidth();
    this.resizeState.startX = event.clientX;
    this.isResizing.set(true);

    document.addEventListener('mousemove', this.boundResizeMove);
    document.addEventListener('mouseup', this.boundResizeEnd);
  }

  /** 鼠标移动中调整宽度 */
  private onResizeMove(event: MouseEvent) {
    if (!this.isResizing()) return;
    const delta = event.clientX - this.resizeState.startX;
    const newWidth = Math.max(this.MIN_WIDTH, Math.min(this.MAX_WIDTH, this.resizeState.startWidth + delta));
    this.sidebarWidth.set(newWidth);
  }

  /** 鼠标释放结束 resize */
  private onResizeEnd() {
    this.isResizing.set(false);
    document.removeEventListener('mousemove', this.boundResizeMove);
    document.removeEventListener('mouseup', this.boundResizeEnd);
  }

  /** 触摸开始 resize */
  onResizeTouchStart(event: TouchEvent) {
    if (event.touches.length !== 1) return;
    event.preventDefault();
    const touch = event.touches[0];
    this.resizeState.startWidth = this.sidebarWidth();
    this.resizeState.startX = touch.clientX;
    this.isResizing.set(true);

    document.addEventListener('touchmove', this.boundResizeTouchMove, { passive: false });
    document.addEventListener('touchend', this.boundResizeTouchEnd);
    document.addEventListener('touchcancel', this.boundResizeTouchEnd);
  }

  /** 触摸移动中调整宽度 */
  private onResizeTouchMove(event: TouchEvent) {
    if (!this.isResizing() || event.touches.length !== 1) return;
    event.preventDefault();
    const touch = event.touches[0];
    const delta = touch.clientX - this.resizeState.startX;
    const newWidth = Math.max(this.MIN_WIDTH, Math.min(this.MAX_WIDTH, this.resizeState.startWidth + delta));
    this.sidebarWidth.set(newWidth);
  }

  /** 触摸结束 resize */
  private onResizeTouchEnd() {
    this.isResizing.set(false);
    document.removeEventListener('touchmove', this.boundResizeTouchMove);
    document.removeEventListener('touchend', this.boundResizeTouchEnd);
    document.removeEventListener('touchcancel', this.boundResizeTouchEnd);
  }

  /** 清理 resize 监听器 */
  private cleanupResizeListeners() {
    document.removeEventListener('mousemove', this.boundResizeMove);
    document.removeEventListener('mouseup', this.boundResizeEnd);
    document.removeEventListener('touchmove', this.boundResizeTouchMove);
    document.removeEventListener('touchend', this.boundResizeTouchEnd);
    document.removeEventListener('touchcancel', this.boundResizeTouchEnd);
  }

  // 拖动事件
  onDragStart(event: DragEvent, task: Task) {
    if (event.dataTransfer) {
      writeTaskDragPayload(event.dataTransfer, {
        v: 1,
        type: 'task',
        taskId: task.id,
        projectId: this.projectState.activeProjectId(),
        fromProjectId: this.projectState.activeProjectId(),
        source: 'flow',
      });
      event.dataTransfer.effectAllowed = 'move';
    }
    this.taskDragStart.emit({ event, task });
  }

  onDragOver(event: DragEvent) {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  }

  onDrop(event: DragEvent) {
    event.preventDefault();

    const payload = event.dataTransfer ? readTaskDragPayload(event.dataTransfer) : null;
    const fallbackData = event.dataTransfer?.getData('application/json') || event.dataTransfer?.getData('text');
    if (!payload && !fallbackData) {
      this.taskDrop.emit({ event });
      return;
    }

    try {
      const draggedTask = payload
        ? this.projectState.getTask(payload.taskId)
        : (JSON.parse(fallbackData ?? '') as { id?: string; stage?: number | null });

      if (draggedTask?.id && draggedTask.stage === null) {
        this.taskDrop.emit({ event });
        return;
      }
    } catch (_err) {
      // 数据解析失败时，回落到通用 drop 处理
    }

    this.taskDrop.emit({ event });
  }

  // 触摸事件
  onTouchStart(event: TouchEvent, task: Task) {
    if (event.touches.length !== 1) return;

    const touch = event.touches[0];
    this.touchState = {
      task,
      startX: touch.clientX,
      startY: touch.clientY,
      isDragging: false,
      longPressTimer: null,
      ghost: null
    };

    this.touchState.longPressTimer = setTimeout(() => {
      this.touchState.isDragging = true;
      this.draggingId.set(task.id);
      this.createGhost(task, touch.clientX, touch.clientY);
      if (navigator.vibrate) navigator.vibrate(50);
    }, 250);

    this.taskTouchStart.emit({ event, task });
  }

  onTouchMove(event: TouchEvent) {
    if (!this.touchState.task || event.touches.length !== 1) return;

    const touch = event.touches[0];
    const deltaX = Math.abs(touch.clientX - this.touchState.startX);
    const deltaY = Math.abs(touch.clientY - this.touchState.startY);

    if (!this.touchState.isDragging && (deltaX > 15 || deltaY > 15)) {
      if (this.touchState.longPressTimer !== null) {
        clearTimeout(this.touchState.longPressTimer);
        this.touchState.longPressTimer = null;
      }
      return;
    }

    if (this.touchState.isDragging) {
      if (event.cancelable) {
        event.preventDefault();
      }
      event.stopPropagation();

      if (this.touchState.ghost) {
        this.touchState.ghost.style.left = `${touch.clientX - 40}px`;
        this.touchState.ghost.style.top = `${touch.clientY - 20}px`;
      }
    }

    this.taskTouchMove.emit({ event });
  }

  onTouchEnd(event: TouchEvent) {
    if (this.touchState.longPressTimer !== null) {
      clearTimeout(this.touchState.longPressTimer);
    }

    if (this.touchState.ghost) {
      this.touchState.ghost.remove();
    }

    this.draggingId.set(null);
    this.taskTouchEnd.emit({ event });

    this.touchState = {
      task: null,
      startX: 0,
      startY: 0,
      isDragging: false,
      longPressTimer: null,
      ghost: null
    };
  }

  private createGhost(task: Task, x: number, y: number) {
    const ghost = document.createElement('div');
    ghost.className = 'fixed z-[9999] px-3 py-2 bg-indigo-500/90 text-white rounded-lg shadow-xl text-xs font-medium pointer-events-none whitespace-nowrap';
    ghost.textContent = task.title || '未命名';
    ghost.style.left = `${x - 40}px`;
    ghost.style.top = `${y - 20}px`;
    document.body.appendChild(ghost);
    this.touchState.ghost = ghost;
  }

}
