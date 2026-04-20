import { Injectable, inject, ElementRef, NgZone, type EventEmitter, type Signal, type WritableSignal } from '@angular/core';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { UserSessionService } from '../../../../services/user-session.service';
import { ToastService } from '../../../../services/toast.service';
import { LoggerService } from '../../../../services/logger.service';
import { ParkingService } from '../../../../services/parking.service';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { Task } from '../../../../models';
import { getErrorMessage, isFailure } from '../../../../utils/result';
import { TextViewDragDropService } from './text-view-drag-drop.service';
import { PARKING_CONFIG } from '../../../../config/parking.config';
import { clearActiveTextSelection, isInteractiveSelectionTarget } from '../../../../utils/text-selection';

function isNavigableLinkedTask(task: Task | undefined | null): task is Task {
  return !!task && !task.deletedAt && task.status !== 'archived';
}

function hasStageAssignment(task: Task): task is Task & { stage: number } {
  return task.stage !== null && task.stage !== undefined;
}

/**
 * 组件上下文接口
 * 用于从组件传递 signal 引用和 ViewChild getter
 */
export interface TextViewOpsContext {
  selectedTaskId: WritableSignal<string | null>;
  deleteConfirmTask: WritableSignal<Task | null>;
  deleteKeepChildren: WritableSignal<boolean>;
  focusFlowNode: EventEmitter<string>;
  isMobile: Signal<boolean>;
  getStagesRef: () => { expandStage(n: number): void; collapseStage(n: number): void; isStageExpanded(n: number): boolean } | undefined;
  getUnassignedRef: () => { setEditingTask(id: string, editing: boolean): Promise<void> } | undefined;
}

/**
 * 文本视图任务操作服务
 * 从 TextViewComponent 拆分，负责：
 * - 任务 CRUD 操作（添加、删除、导航）
 * - 拖拽后的 drop 推断逻辑
 * - 阶段折叠/展开管理
 * - DOM 滚动辅助
 *
 * 注意：此服务在组件级别提供（非 root），与组件生命周期绑定
 */
@Injectable()
export class TextViewTaskOpsService {
  private readonly taskOpsAdapter = inject(TaskOperationAdapterService);
  private readonly projectState = inject(ProjectStateService);
  private readonly uiState = inject(UiStateService);
  private readonly userSession = inject(UserSessionService);
  private readonly toast = inject(ToastService);
  private readonly dragDropService = inject(TextViewDragDropService);
  private readonly elementRef = inject(ElementRef);
  private readonly ngZone = inject(NgZone);
  private readonly logger = inject(LoggerService).category('TextViewOps');
  private readonly parkingService = inject(ParkingService);
  private readonly dockEngine = inject(DockEngineService);

  /** 组件上下文 */
  private ctx!: TextViewOpsContext;

  /** 待清理的定时器列表（防止内存泄漏） */
  readonly pendingTimers: ReturnType<typeof setTimeout>[] = [];
  private pendingContainerClickGuardTaskId: string | null = null;

  /** 初始化：接收组件 signal 和 ViewChild 引用 */
  init(ctx: TextViewOpsContext): void {
    this.ctx = ctx;
  }

  private guardHintOnlyMutation(actionLabel: string): boolean {
    if (!this.userSession.isHintOnlyStartupPlaceholderVisible()) {
      return false;
    }

    this.toast.info('会话确认中', `${actionLabel}暂不可用，owner 确认完成前保持只读`);
    return true;
  }

  /** 销毁：清理定时器 */
  destroy(): void {
    this.pendingTimers.forEach(timer => clearTimeout(timer));
    this.pendingTimers.length = 0;
    this.pendingContainerClickGuardTaskId = null;
  }

  armContainerClickGuard(taskId: string): void {
    this.pendingContainerClickGuardTaskId = taskId;
  }

  // ========== 容器点击 ==========

  /**
   * 点击空白区域时收缩已展开的任务
   */
  onContainerClick(event: Event): void {
    const guardTaskId = this.pendingContainerClickGuardTaskId;
    if (guardTaskId) {
      this.pendingContainerClickGuardTaskId = null;
      const originatedFromGuardedTask = this.eventPathContains(event, node => {
        if (!(node instanceof HTMLElement)) {
          return false;
        }

        return node.getAttribute('data-task-id') === guardTaskId
          || node.getAttribute('data-unassigned-task') === guardTaskId;
      });

      if (originatedFromGuardedTask) {
        return;
      }
    }

    const target = event.target as HTMLElement;
    if (this.eventPathContains(event, node => this.isTaskContainerNode(node))) return;
    if (target.closest('[data-task-id]') || target.closest('[data-unassigned-task]')) return;
    const isInteractiveTarget = this.eventPathContains(event, node => this.isInteractiveNode(node))
      || isInteractiveSelectionTarget(target);
    const clearedSelection = clearActiveTextSelection();

    if (isInteractiveTarget) {
      return;
    }

    if (clearedSelection) {
      return;
    }

    if (this.ctx.selectedTaskId()) {
      this.ctx.selectedTaskId.set(null);
    }
  }

  private isTaskContainerNode(node: EventTarget): boolean {
    if (!(node instanceof HTMLElement)) {
      return false;
    }

    return node.hasAttribute('data-task-id') || node.hasAttribute('data-unassigned-task');
  }

  private isInteractiveNode(node: EventTarget): boolean {
    return isInteractiveSelectionTarget(node);
  }

  private eventPathContains(event: Event, predicate: (node: EventTarget) => boolean): boolean {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    return path.some(predicate);
  }

  // ========== DOM 辅助方法 ==========

  getScrollContainer(): HTMLElement | null {
    return this.elementRef.nativeElement.querySelector('.text-view-scroll-container');
  }

  getStageScrollContainer(): HTMLElement | null {
    return this.elementRef.nativeElement.querySelector('[data-stage-scroll-container]');
  }

  getStageTaskListContainer(stageNumber: number | null | undefined): HTMLElement | null {
    if (stageNumber === null || stageNumber === undefined) {
      return null;
    }
    return this.elementRef.nativeElement.querySelector(`[data-stage-task-list="${stageNumber}"]`);
  }

  resolveAutoScrollContainer(stageNumber: number | null | undefined, clientY?: number): HTMLElement | null {
    const scrollContainer = this.getScrollContainer();
    const stageScrollContainer = this.getStageScrollContainer();
    const stageTaskList = this.getStageTaskListContainer(stageNumber);
    if (!this.canAutoScroll(stageTaskList)) {
      if (!this.canAutoScroll(stageScrollContainer)) {
        return scrollContainer;
      }

      if (clientY === undefined) {
        return stageScrollContainer;
      }

      const direction = this.getAutoScrollDirection(stageScrollContainer, clientY);
      if (direction === 0) {
        return stageNumber === null || stageNumber === undefined
          ? scrollContainer
          : stageScrollContainer;
      }

      return this.canScrollInDirection(stageScrollContainer, direction)
        ? stageScrollContainer
        : scrollContainer;
    }

    if (clientY === undefined) {
      return stageTaskList;
    }

    const direction = this.getAutoScrollDirection(stageTaskList, clientY);
    if (direction < 0) {
      if (stageTaskList.scrollTop > 0) {
        return stageTaskList;
      }

      if (this.canScrollInDirection(stageScrollContainer, direction)) {
        return stageScrollContainer;
      }

      return scrollContainer;
    }

    if (direction > 0) {
      if (this.canScrollInDirection(stageTaskList, direction)) {
        return stageTaskList;
      }

      if (this.canScrollInDirection(stageScrollContainer, direction)) {
        return stageScrollContainer;
      }

      return scrollContainer;
    }

    return stageTaskList;
  }

  private canAutoScroll(container: HTMLElement | null): container is HTMLElement {
    return !!container && container.clientHeight > 0 && container.scrollHeight > container.clientHeight;
  }

  private canScrollInDirection(container: HTMLElement | null, direction: -1 | 0 | 1): container is HTMLElement {
    if (!this.canAutoScroll(container)) {
      return false;
    }

    if (direction < 0) {
      return container.scrollTop > 0;
    }

    if (direction > 0) {
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
      return container.scrollTop < maxScrollTop;
    }

    return true;
  }

  private getAutoScrollDirection(container: HTMLElement, clientY: number): -1 | 0 | 1 {
    const rect = container.getBoundingClientRect();
    const edgeSize = 100;
    const edgeOverflow = 20;

    if (clientY < rect.top + edgeSize && clientY > rect.top - edgeOverflow) {
      return -1;
    }

    if (clientY > rect.bottom - edgeSize && clientY < rect.bottom + edgeOverflow) {
      return 1;
    }

    return 0;
  }

  scrollToElementById(selector: string): void {
    this.ngZone.runOutsideAngular(() => {
      requestAnimationFrame(() => {
        const el = this.elementRef.nativeElement.querySelector(selector);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    });
  }

  scrollToTaskAndFocus(taskId: string, inputSelector?: string): void {
    this.ngZone.runOutsideAngular(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = this.elementRef.nativeElement.querySelector(`[data-task-id="${taskId}"]`)
            ?? this.elementRef.nativeElement.querySelector(`[data-unassigned-task="${taskId}"]`);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            if (inputSelector) {
              const focusTimer = setTimeout(() => {
                this.focusTaskInput(el, inputSelector);
                this.removeTimer(focusTimer);
              }, 100);
              this.pendingTimers.push(focusTimer);
            }
          }
        });
      });
    });
  }

  removeTimer(timer: ReturnType<typeof setTimeout>): void {
    const index = this.pendingTimers.indexOf(timer);
    if (index > -1) {
      this.pendingTimers.splice(index, 1);
    }
  }

  private focusTaskInput(el: Element, inputSelector: string): void {
    const input = el.querySelector<HTMLInputElement | HTMLTextAreaElement>(inputSelector);
    if (input) {
      input.focus();
      input.select?.();
      return;
    }

    if (inputSelector !== 'input[data-title-input]') {
      return;
    }

    const previewTrigger = el.querySelector<HTMLElement>('[data-title-preview-trigger]');
    if (!previewTrigger) {
      return;
    }

    previewTrigger.click();

    this.retryFocusTaskInput(el, inputSelector, 4);
  }

  private retryFocusTaskInput(el: Element, inputSelector: string, attemptsLeft: number): void {
    const retryTimer = setTimeout(() => {
      const revealedInput = el.querySelector<HTMLInputElement | HTMLTextAreaElement>(inputSelector);
      if (revealedInput) {
        revealedInput.focus();
        revealedInput.select?.();
        this.removeTimer(retryTimer);
        return;
      }

      this.removeTimer(retryTimer);
      if (attemptsLeft > 0) {
        this.retryFocusTaskInput(el, inputSelector, attemptsLeft - 1);
      }
    }, 0);

    this.pendingTimers.push(retryTimer);
  }

  private isTaskVisibleUnderCurrentRootFilter(task: Task): boolean {
    const rootFilter = this.uiState.stageViewRootFilter();
    if (rootFilter === 'all') {
      return true;
    }

    const rootTask = this.projectState.getTask(rootFilter);
    if (!rootTask) {
      return true;
    }

    if (task.id === rootTask.id) {
      return true;
    }

    if (!rootTask.displayId || !task.displayId) {
      return false;
    }

    return task.displayId.startsWith(`${rootTask.displayId},`);
  }

  private ensureStageTaskVisible(task: Task): void {
    if (!this.isTaskVisibleUnderCurrentRootFilter(task)) {
      this.uiState.stageViewRootFilter.set('all');
    }
  }

  // ========== 阶段折叠管理 ==========

  /** 折叠在拖拽过程中临时展开但尚未收起的阶段 */
  collapseAutoExpandedStages(...stageGroups: Array<number[] | null | undefined>): void {
    const stagesRef = this.ctx.getStagesRef();
    if (!stagesRef) return;
    const merged: number[] = [];
    for (const group of stageGroups) {
      if (!group?.length) continue;
      merged.push(...group);
    }
    if (!merged.length) return;
    const uniqueStages = Array.from(new Set(merged));
    requestAnimationFrame(() => {
      uniqueStages.forEach(stage => stagesRef?.collapseStage(stage));
    });
  }

  /** 根据拖拽来源阶段状态决定是否需要立即折叠 */
  collapseSourceStageIfNeeded(currentStageNumber: number | null): void {
    const stagesRef = this.ctx.getStagesRef();
    const stageToCollapse = this.dragDropService.requestSourceStageCollapse(currentStageNumber);
    if (stageToCollapse !== null) {
      const isExpanded = stagesRef?.isStageExpanded(stageToCollapse) ?? false;
      if (isExpanded) {
        this.dragDropService.markSourceStageAutoCollapsed(stageToCollapse);
        this.collapseAutoExpandedStages([stageToCollapse]);
      }
    }
  }

  /** 在拖拽结束后恢复因拖拽自动折叠的阶段 */
  restoreAutoCollapsedSourceStage(): void {
    const stagesRef = this.ctx.getStagesRef();
    const stageToRestore = this.dragDropService.consumeAutoCollapsedSourceStage();
    if (stageToRestore === null) return;
    requestAnimationFrame(() => stagesRef?.expandStage(stageToRestore));
  }

  // ========== 待办事项处理 ==========

  async onJumpToTask(taskId: string): Promise<void> {
    const task = this.projectState.getTask(taskId);
    if (!isNavigableLinkedTask(task)) return;

    if (hasStageAssignment(task)) {
      this.ensureStageTaskVisible(task);
      this.ctx.getStagesRef()?.expandStage(task.stage);
      if (this.uiState.stageFilter() !== 'all' && this.uiState.stageFilter() !== task.stage) {
        this.uiState.setStageFilter('all');
      }
      this.ctx.selectedTaskId.set(taskId);
      this.scrollToElementById(`[data-task-id="${taskId}"]`);
    } else {
      this.ctx.selectedTaskId.set(null);
      if (!this.uiState.isTextUnassignedOpen()) {
        this.uiState.isTextUnassignedOpen.set(true);
      }
      await new Promise<void>(resolve => {
        setTimeout(() => resolve(), 50);
      });
      const unassignedRef = this.ctx.getUnassignedRef();
      if (unassignedRef) {
        await unassignedRef.setEditingTask(taskId, false);
      }
      this.ngZone.runOutsideAngular(() => {
        const timer = setTimeout(() => {
          const el = this.elementRef.nativeElement.querySelector(`[data-unassigned-task="${taskId}"]`);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
          this.removeTimer(timer);
        }, 100);
        this.pendingTimers.push(timer);
      });
    }
  }

  // ========== 待分配区处理 ==========

  onUnassignedTaskClick(task: Task): void {
    this.ctx.focusFlowNode.emit(task.id);
  }

  onCreateUnassigned(): void {
    if (this.guardHintOnlyMutation('创建任务')) {
      return;
    }

    const result = this.taskOpsAdapter.addTask('', '', null, null, false);
    if (isFailure(result)) {
      this.toast.error('创建任务失败', getErrorMessage(result.error));
    } else {
      this.ctx.getUnassignedRef()?.setEditingTask(result.value, true);
      this.scrollToTaskAndFocus(result.value, 'input');
    }
  }

  // ========== 任务选择和操作 ==========

  onTaskSelect(task: Task | null | undefined): void {
    if (!task?.id) {
      return;
    }

    if (this.ctx.selectedTaskId() === task.id) {
      return;
    }

    this.ctx.selectedTaskId.set(task.id);

    if (!this.ctx.isMobile()) {
      this.ctx.focusFlowNode.emit(task.id);
    } else {
      this.scrollToTaskAfterExpand(task.id);
    }
  }

  /**
   * 任务展开后滚动到合适位置（仅手机端）
   */
  scrollToTaskAfterExpand(taskId: string): void {
    this.ngZone.runOutsideAngular(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const timer = setTimeout(() => {
            requestAnimationFrame(() => {
              const el = this.elementRef.nativeElement.querySelector(`[data-task-id="${taskId}"]`)
                ?? this.elementRef.nativeElement.querySelector(`[data-unassigned-task="${taskId}"]`);
              if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
            });
            this.removeTimer(timer);
          }, 200);
          this.pendingTimers.push(timer);
        });
      });
    });
  }

  onAddSibling(task: Task): void {
    if (this.guardHintOnlyMutation('创建任务')) {
      return;
    }

    const result = this.taskOpsAdapter.addTask('', '', task.stage, task.parentId, true);
    if (isFailure(result)) {
      this.toast.error('添加任务失败', getErrorMessage(result.error));
    } else {
      this.navigateToNewTask(result.value, task.stage);
    }
  }

  onAddChild(task: Task): void {
    if (this.guardHintOnlyMutation('创建子任务')) {
      return;
    }

    const newStage = (task.stage || 0) + 1;
    const result = this.taskOpsAdapter.addTask('', '', newStage, task.id, false);
    if (isFailure(result)) {
      this.toast.error('添加任务失败', getErrorMessage(result.error));
    } else {
      this.navigateToNewTask(result.value, newStage);
    }
  }

  onDeleteTask(task: Task): void {
    if (this.guardHintOnlyMutation('删除任务')) {
      return;
    }

    this.ctx.deleteConfirmTask.set(task);
  }

  /** 停泊任务——将当前任务放入「稍后处理」停泊槽 */
  onParkTask(task: Task): void {
    if (this.guardHintOnlyMutation('停泊任务')) {
      return;
    }

    this.parkingService.parkTask(task.id);
    if (PARKING_CONFIG.DOCK_PARK_BUTTON_SYNC_MODE === 'on') {
      this.dockEngine.dockTask(task.id, undefined, {
        sourceSection: 'text',
        zoneSource: 'auto',
      });
    }
    // 停泊后取消选中，回到列表视图
    this.ctx.selectedTaskId.set(null);
  }

  onConfirmDelete(keepChildren: boolean): void {
    if (this.guardHintOnlyMutation('删除任务')) {
      return;
    }

    const task = this.ctx.deleteConfirmTask();
    if (task) {
      this.ctx.selectedTaskId.set(null);
      if (keepChildren) {
        this.taskOpsAdapter.deleteTaskKeepChildren(task.id);
      } else {
        this.taskOpsAdapter.deleteTask(task.id);
      }
      this.ctx.deleteConfirmTask.set(null);
      this.ctx.deleteKeepChildren.set(false);
    }
  }

  onCancelDelete(): void {
    this.ctx.deleteConfirmTask.set(null);
    this.ctx.deleteKeepChildren.set(false);
  }

  onAttachmentError(error: string): void {
    this.toast.error('附件操作失败', error);
  }

  onOpenLinkedTask(data: { taskId: string; event: Event }): void {
    const { taskId, event } = data;
    event.stopPropagation();
    const task = this.projectState.getTask(taskId);
    if (!isNavigableLinkedTask(task)) {
      this.toast.warning('任务链接不可用', '目标任务不存在、已删除或已归档');
      return;
    }

    void this.onJumpToTask(task.id);
  }

  onAddNewStage(): void {
    if (this.guardHintOnlyMutation('创建阶段')) {
      return;
    }

    const maxStage = Math.max(...this.projectState.stages().map(s => s.stageNumber), 0);
    const result = this.taskOpsAdapter.addTask('', '', maxStage + 1, null, false);
    if (isFailure(result)) {
      this.toast.error('创建阶段失败', getErrorMessage(result.error));
    } else {
      this.navigateToNewTask(result.value, maxStage + 1);
    }
  }

  navigateToNewTask(taskId: string, stage: number | null): void {
    if (stage) {
      this.ctx.getStagesRef()?.expandStage(stage);
      if (this.uiState.stageFilter() !== 'all' && this.uiState.stageFilter() !== stage) {
        this.uiState.setStageFilter('all');
      }
    }
    this.ctx.selectedTaskId.set(taskId);
    this.scrollToTaskAndFocus(taskId, 'input[data-title-input]');
  }

  hasChildren(task: Task): boolean {
    return this.projectState.tasks().some(t => t.parentId === task.id);
  }

  // ========== Drop 推断逻辑 ==========

  /**
   * 推断拖放操作的父任务 ID
   * 此逻辑在鼠标拖拽(onStageDrop)和触摸拖拽(onTouchEnd)共享
   *
   * @param stageNumber 目标阶段编号
   * @param beforeTaskId 插入位置之前的任务 ID（null 表示阶段末尾）
   * @returns undefined=不推断, null=无父, string=继承的父 ID
   */
  inferParentIdForDrop(stageNumber: number, beforeTaskId: string | null): string | null | undefined {
    if (beforeTaskId) {
      // 有明确的插入位置（在某个任务之前）
      const referenceTask = this.projectState.getTask(beforeTaskId) || null;
      if (referenceTask?.parentId) {
        const parentTask = this.projectState.getTask(referenceTask.parentId);
        if (parentTask && parentTask.stage === stageNumber - 1) {
          return referenceTask.parentId;
        } else {
          this.logger.debug('Drop 参照任务的 parentId 无效，不继承', {
            referenceTaskId: beforeTaskId.slice(-4),
            parentId: referenceTask.parentId?.slice(-4),
            parentStage: parentTask?.stage ?? 'not found',
            expectedParentStage: stageNumber - 1
          });
          return null;
        }
      }
      return null;
    }

    // 没有 beforeTaskId，说明拖到阶段最后
    const stages = this.projectState.stages();
    const targetStage = stages.find(s => s.stageNumber === stageNumber);
    if (targetStage && targetStage.tasks.length > 0) {
      const lastTask = targetStage.tasks[targetStage.tasks.length - 1];
      if (lastTask?.parentId) {
        const parentTask = this.projectState.getTask(lastTask.parentId);
        if (parentTask && parentTask.stage === stageNumber - 1) {
          return lastTask.parentId;
        } else {
          this.logger.debug('Drop 最后任务的 parentId 无效，不继承', {
            lastTaskId: lastTask?.id?.slice(-4) ?? 'unknown',
            parentId: lastTask?.parentId?.slice(-4) ?? null,
            parentStage: parentTask?.stage ?? 'not found',
            expectedParentStage: stageNumber - 1
          });
          return null;
        }
      }
      return null;
    }

    return undefined;
  }
}
