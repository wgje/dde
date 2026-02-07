import { Injectable, inject, ElementRef, NgZone, type EventEmitter, type Signal, type WritableSignal } from '@angular/core';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { ToastService } from '../../../../services/toast.service';
import { LoggerService } from '../../../../services/logger.service';
import { Task } from '../../../../models';
import { getErrorMessage, isFailure } from '../../../../utils/result';
import { TextViewDragDropService } from './text-view-drag-drop.service';

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
  private readonly toast = inject(ToastService);
  private readonly dragDropService = inject(TextViewDragDropService);
  private readonly elementRef = inject(ElementRef);
  private readonly ngZone = inject(NgZone);
  private readonly logger = inject(LoggerService).category('TextViewOps');

  /** 组件上下文 */
  private ctx!: TextViewOpsContext;

  /** 待清理的定时器列表（防止内存泄漏） */
  readonly pendingTimers: ReturnType<typeof setTimeout>[] = [];

  /** 初始化：接收组件 signal 和 ViewChild 引用 */
  init(ctx: TextViewOpsContext): void {
    this.ctx = ctx;
  }

  /** 销毁：清理定时器 */
  destroy(): void {
    this.pendingTimers.forEach(timer => clearTimeout(timer));
    this.pendingTimers.length = 0;
  }

  // ========== 容器点击 ==========

  /**
   * 点击空白区域时收缩已展开的任务
   */
  onContainerClick(event: Event): void {
    const target = event.target as HTMLElement;
    if (target.closest('[data-task-id]') || target.closest('[data-unassigned-task]')) return;
    if (target.closest('button, input, textarea, a, [role="button"]')) return;
    if (this.ctx.selectedTaskId()) {
      this.ctx.selectedTaskId.set(null);
    }
  }

  // ========== DOM 辅助方法 ==========

  getScrollContainer(): HTMLElement | null {
    return this.elementRef.nativeElement.querySelector('.text-view-scroll-container');
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
                const input = el.querySelector(inputSelector) as HTMLInputElement;
                input?.focus();
                input?.select?.();
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
    if (!task) return;

    if (task.stage) {
      this.ctx.getStagesRef()?.expandStage(task.stage);
      if (this.uiState.stageFilter() !== 'all' && this.uiState.stageFilter() !== task.stage) {
        this.uiState.setStageFilter('all');
      }
      this.ctx.selectedTaskId.set(taskId);
      this.scrollToElementById(`[data-task-id="${taskId}"]`);
    } else {
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
    const result = this.taskOpsAdapter.addTask('', '', null, null, false);
    if (isFailure(result)) {
      this.toast.error('创建任务失败', getErrorMessage(result.error));
    } else {
      this.ctx.getUnassignedRef()?.setEditingTask(result.value, true);
      this.scrollToTaskAndFocus(result.value, 'input');
    }
  }

  // ========== 任务选择和操作 ==========

  onTaskSelect(task: Task): void {
    const wasSelected = this.ctx.selectedTaskId() === task.id;
    this.ctx.selectedTaskId.update(id => id === task.id ? null : task.id);

    if (!wasSelected && this.ctx.selectedTaskId() === task.id) {
      if (!this.ctx.isMobile()) {
        this.ctx.focusFlowNode.emit(task.id);
      } else {
        this.scrollToTaskAfterExpand(task.id);
      }
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
    const result = this.taskOpsAdapter.addTask('', '', task.stage, task.parentId, true);
    if (isFailure(result)) {
      this.toast.error('添加任务失败', getErrorMessage(result.error));
    } else {
      this.navigateToNewTask(result.value, task.stage);
    }
  }

  onAddChild(task: Task): void {
    const newStage = (task.stage || 0) + 1;
    const result = this.taskOpsAdapter.addTask('', '', newStage, task.id, false);
    if (isFailure(result)) {
      this.toast.error('添加任务失败', getErrorMessage(result.error));
    } else {
      this.navigateToNewTask(result.value, newStage);
    }
  }

  onDeleteTask(task: Task): void {
    this.ctx.deleteConfirmTask.set(task);
  }

  onConfirmDelete(keepChildren: boolean): void {
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

  onOpenLinkedTask(data: { task: Task; event: Event }): void {
    const { task, event } = data;
    event.stopPropagation();
    if (!task) return;
    if (task.stage) {
      this.ctx.getStagesRef()?.expandStage(task.stage);
    }
    this.ctx.selectedTaskId.set(task.id);
    this.scrollToElementById(`[data-task-id="${task.id}"]`);
  }

  onAddNewStage(): void {
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
