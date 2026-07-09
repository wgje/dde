import { Injectable, Injector, inject, signal } from '@angular/core';
import { ProjectStateService } from '../../../../services/project-state.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { ToastService } from '../../../../services/toast.service';
import { Task } from '../../../../models';
import { CascadeAssignDialogData } from '../components/flow-cascade-assign-dialog.component';
import { FLOATING_TREE_CONFIG } from '../../../../config/layout.config';
import { extractErrorMessage, getErrorMessage } from '../../../../utils/result';

/**
 * 级联分配服务
 * 处理待分配任务树拖拽到阶段区域时的级联分配逻辑
 */
@Injectable({ providedIn: 'root' })
export class FlowCascadeAssignService {
  private readonly injector = inject(Injector);
  private readonly projectState = inject(ProjectStateService);
  private readonly toast = inject(ToastService);

  private get taskOpsAdapter(): TaskOperationAdapterService {
    return this.injector.get(TaskOperationAdapterService);
  }

  /** 级联分配确认对话框状态 */
  readonly dialogData = signal<CascadeAssignDialogData | null>(null);
  /** 确认在途标记：await 期间对话框仍可点击，双击不得重复派发同一子树的持久化迁移 */
  private isConfirming = false;

  /**
   * 显示级联分配确认对话框
   * 当用户将待分配任务树拖拽到阶段区域时调用
   */
  showDialog(
    taskId: string,
    targetStage: number,
    targetParentId: string | null
  ): void {
    const tasks = this.projectState.tasks();
    const task = this.projectState.getTask(taskId);
    if (!task) return;

    // 计算子树信息
    const subtreeCount = this.countSubtree(taskId, tasks);
    const subtreeDepth = this.getSubtreeDepth(taskId, tasks);

    const targetParent = targetParentId ? (this.projectState.getTask(targetParentId) ?? null) : null;

    this.dialogData.set({
      show: true,
      taskId,
      taskTitle: task.title || '未命名任务',
      targetStage,
      subtreeCount,
      targetParentId,
      targetParentTitle: targetParent?.title || null,
      subtreeDepth
    });
  }

  /**
   * 确认级联分配
   * @returns 是否成功执行
   */
  async confirm(): Promise<boolean> {
    if (this.isConfirming) {
      return false;
    }

    const dialog = this.dialogData();
    if (!dialog) return false;

    this.isConfirming = true;
    try {
      try {
        const result = await this.taskOpsAdapter.moveTaskToStage(
          dialog.taskId,
          dialog.targetStage,
          undefined,
          dialog.targetParentId
        );

        if (!result.ok) {
          this.toast.error('分配失败', getErrorMessage(result.error));
          return false;
        }
      } catch (error) {
        this.toast.error('分配失败', extractErrorMessage(error));
        return false;
      }

      this.dialogData.set(null);
      this.toast.success('分配成功', `已将 ${dialog.subtreeCount} 个任务分配到阶段 ${dialog.targetStage}`);
      return true;
    } finally {
      this.isConfirming = false;
    }
  }

  /**
   * 取消级联分配
   */
  cancel(): void {
    this.dialogData.set(null);
  }

  /**
   * 计算子树任务数量（迭代算法，符合项目规范）
   */
  private countSubtree(taskId: string, tasks: Task[]): number {
    const childrenByParent = this.buildChildrenByParent(tasks);
    const visited = new Set<string>();
    const stack: Array<{ id: string; depth: number }> = [{ id: taskId, depth: 0 }];

    while (stack.length > 0) {
      const { id, depth } = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);

      if (depth >= FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH) continue;

      for (const child of childrenByParent.get(id) ?? []) {
        if (!visited.has(child.id)) {
          stack.push({ id: child.id, depth: depth + 1 });
        }
      }
    }

    return visited.size;
  }

  /**
   * 计算子树深度（迭代算法，符合项目规范）
   */
  private getSubtreeDepth(taskId: string, tasks: Task[]): number {
    const childrenByParent = this.buildChildrenByParent(tasks);
    const visited = new Set<string>();
    let maxDepth = 0;
    const stack: { id: string; depth: number }[] = [{ id: taskId, depth: 0 }];

    while (stack.length > 0) {
      const { id, depth } = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);

      maxDepth = Math.max(maxDepth, depth);
      if (depth >= FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH) continue;

      for (const child of childrenByParent.get(id) ?? []) {
        if (!visited.has(child.id)) {
          stack.push({ id: child.id, depth: depth + 1 });
        }
      }
    }

    return maxDepth;
  }

  private buildChildrenByParent(tasks: Task[]): Map<string, Task[]> {
    const childrenByParent = new Map<string, Task[]>();
    for (const task of tasks) {
      if (!task.parentId || task.deletedAt) continue;
      const children = childrenByParent.get(task.parentId) ?? [];
      children.push(task);
      childrenByParent.set(task.parentId, children);
    }
    return childrenByParent;
  }
}
