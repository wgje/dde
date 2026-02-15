import { Injectable, inject, signal } from '@angular/core';
import { ProjectStateService } from '../../../../services/project-state.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { ToastService } from '../../../../services/toast.service';
import { Task } from '../../../../models';
import { CascadeAssignDialogData } from '../components/flow-cascade-assign-dialog.component';

/**
 * 级联分配服务
 * 处理待分配任务树拖拽到阶段区域时的级联分配逻辑
 */
@Injectable({ providedIn: 'root' })
export class FlowCascadeAssignService {
  private readonly projectState = inject(ProjectStateService);
  private readonly taskOpsAdapter = inject(TaskOperationAdapterService);
  private readonly toast = inject(ToastService);

  /** 级联分配确认对话框状态 */
  readonly dialogData = signal<CascadeAssignDialogData | null>(null);

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
  confirm(): boolean {
    const dialog = this.dialogData();
    if (!dialog) return false;

    this.taskOpsAdapter.moveTaskToStage(
      dialog.taskId,
      dialog.targetStage,
      undefined,
      dialog.targetParentId
    );

    this.dialogData.set(null);
    this.toast.success('分配成功', `已将 ${dialog.subtreeCount} 个任务分配到阶段 ${dialog.targetStage}`);
    return true;
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
    const visited = new Set<string>();
    const stack = [taskId];

    while (stack.length > 0) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);

      tasks.filter(t => t.parentId === id && !t.deletedAt)
        .forEach(child => stack.push(child.id));
    }

    return visited.size;
  }

  /**
   * 计算子树深度（迭代算法，符合项目规范）
   */
  private getSubtreeDepth(taskId: string, tasks: Task[]): number {
    let maxDepth = 0;
    const stack: { id: string; depth: number }[] = [{ id: taskId, depth: 0 }];

    while (stack.length > 0) {
      const { id, depth } = stack.pop()!;
      maxDepth = Math.max(maxDepth, depth);

      tasks.filter(t => t.parentId === id && !t.deletedAt)
        .forEach(child => stack.push({ id: child.id, depth: depth + 1 }));
    }

    return maxDepth;
  }
}
