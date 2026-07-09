import { Injectable, Injector, inject } from '@angular/core';
import { ProjectStateService } from '../../../../services/project-state.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { Task } from '../../../../models';

type ParentChildRelinkResult = 'success' | 'cancelled' | 'error';
type ParentChildRelinkToEndResult = ParentChildRelinkResult | 'replace-subtree';
type TaskToUnassignedLinkResult = 'replace-subtree' | 'create-parent-child' | 'none';

/**
 * FlowLinkRelinkService - 连接线重连/子树迁移服务
 *
 * 职责：
 * - 任务块→待分配块的连接处理
 * - 父子连接线的上游/下游端点重连（子树迁移）
 * - 跨树连接线的重连
 * - 子树提升为根任务
 *
 * 从 FlowLinkService 拆分而来，专注于 relink 相关逻辑
 */
@Injectable({
  providedIn: 'root'
})
export class FlowLinkRelinkService {
  private readonly injector = inject(Injector);
  private readonly projectState = inject(ProjectStateService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowLinkRelink');
  private readonly toast = inject(ToastService);

  private get taskOps(): TaskOperationAdapterService {
    return this.injector.get(TaskOperationAdapterService);
  }

  private guardHintOnlyLinkMutation(actionLabel: string): boolean {
    if (!this.taskOps.isHintOnlyStartupReadOnly()) {
      return false;
    }

    this.toast.info('会话确认中', `${actionLabel}暂不可用，owner 确认完成前保持只读`);
    return true;
  }

  // ========== 任务块→待分配块连接 ==========

  /**
   * 处理任务块连接到待分配块的场景（流程图逻辑链条核心）
   *
   * 【行为说明 - 根据 replaceMode 区分】
   *
   * replaceMode = false（从普通端口拖出新线条）：
   * - 将待分配块及其子树添加为源任务的子节点
   * - 保留源任务原有的子任务
   *
   * replaceMode = true（连接线重连，拖动下游端点）：
   * - 只替换 specificChildId 指定的子任务（剥离为待分配块）
   * - 其他子任务保持不变
   * - 源任务没有子任务时：直接分配待分配块
   *
   * @param sourceId 源任务块 ID
   * @param targetId 目标待分配块 ID
   * @param targetTask 目标待分配块任务对象
   * @param replaceMode 是否为替换模式（默认 false，即添加模式）
   * @param specificChildId 要被替换的特定子任务 ID（仅在 replaceMode=true 时使用）
   * @returns 操作结果
   */
  async handleTaskToUnassignedLink(
    sourceId: string,
    targetId: string,
    targetTask: Task,
    replaceMode: boolean = false,
    specificChildId?: string
  ): Promise<TaskToUnassignedLinkResult> {
    // 检查源任务是否已有子任务
    const existingChildren = this.taskOps.getDirectChildren(sourceId);

    // 替换模式：当有子任务时执行替换（只替换特定的子任务）
    if (replaceMode && existingChildren.length > 0 && specificChildId) {
      // 源任务已有子任务：执行子树替换
      // 只将 specificChildId 对应的子任务剥离为待分配块
      // 其他子任务保持不变
      this.logger.info('执行子树替换（重连模式，只替换特定子任务）', {
        sourceId,
        targetId,
        specificChildId,
        existingChildrenCount: existingChildren.length,
        targetHasParent: !!targetTask.parentId
      });

      const result = await this.taskOps.replaceChildSubtreeWithUnassigned(sourceId, targetId, specificChildId);

      if (result.ok) {
        // Toast 由 TaskOperationAdapterService 显示，这里不重复
        return 'replace-subtree';
      } else {
        // 错误 Toast 也由 TaskOperationAdapterService 处理
        return 'none';
      }
    } else {
      // 添加模式 或 源任务没有子任务：直接分配待分配块（保留原有子任务）
      this.logger.info('分配待分配块给任务（添加模式）', {
        sourceId,
        targetId,
        targetHasParent: !!targetTask.parentId,
        existingChildrenCount: existingChildren.length,
        replaceMode
      });

      const result = await this.taskOps.assignUnassignedToTask(sourceId, targetId);

      if (result.ok) {
        // Toast 由 TaskOperationAdapterService 显示，这里不重复
        return 'create-parent-child';
      } else {
        // 错误 Toast 也由 TaskOperationAdapterService 处理
        return 'none';
      }
    }
  }

  // ========== 子树迁移处理 ==========

  /**
   * 处理父子连接的重连（子树迁移）
   * 当用户拖动父子连接线的终点到新的父节点时调用
   *
   * @param childTaskId 被迁移的子任务 ID（连接线的目标端）
   * @param oldParentId 原父任务 ID（连接线的原始源端）
   * @param newParentId 新父任务 ID（连接线的新源端）
   * @returns 操作结果：'success' | 'cancelled' | 'error'
   */
  async handleParentChildRelink(
    childTaskId: string,
    oldParentId: string,
    newParentId: string
  ): Promise<ParentChildRelinkResult> {
    if (this.guardHintOnlyLinkMutation('迁移任务')) {
      return 'cancelled';
    }

    const endpointResult = this.guardParentChildRelinkEndpoints(childTaskId, oldParentId, newParentId);
    if (endpointResult) return endpointResult;

    const tasks = this.projectState.tasks();
    const childTask = this.projectState.getTask(childTaskId);
    const newParentTask = this.projectState.getTask(newParentId);

    if (!childTask) {
      this.toast.error('迁移失败', '找不到要迁移的任务');
      return 'error';
    }

    if (!newParentTask) {
      this.toast.error('迁移失败', '找不到目标父任务');
      return 'error';
    }

    if (newParentTask.stage === null && childTask.stage !== null) {
      this.toast.warning('无法连接', '待分配块无法成为任务块的父节点');
      return 'error';
    }

    if (newParentTask.stage === null && childTask.stage === null) {
      return this.moveUnassignedChildToParent(childTask, newParentTask);
    }

    return this.moveAssignedSubtreeToParent(childTaskId, oldParentId, newParentId, childTask, newParentTask, tasks);
  }

  private guardParentChildRelinkEndpoints(
    childTaskId: string,
    oldParentId: string,
    newParentId: string
  ): 'cancelled' | 'error' | null {
    if (childTaskId === newParentId) {
      this.toast.warning('无法连接', '节点不能连接到自身');
      return 'error';
    }

    if (oldParentId === newParentId) {
      this.logger.debug('父节点未变化，跳过迁移');
      return 'cancelled';
    }

    return null;
  }

  private async moveUnassignedChildToParent(childTask: Task, newParentTask: Task): Promise<ParentChildRelinkResult> {
    const moveResult = await this.taskOps.moveTaskToStage(childTask.id, null, undefined, newParentTask.id);
    if (!moveResult.ok) {
      this.toast.error('迁移失败', moveResult.error?.message || '未知错误');
      return 'error';
    }

    this.toast.success('已建立待分配层级', `已将 "${childTask.title}" 挂载到新的待分配父节点`);
    return 'success';
  }

  private async moveAssignedSubtreeToParent(
    childTaskId: string,
    oldParentId: string,
    newParentId: string,
    childTask: Task,
    newParentTask: Task,
    tasks: Task[]
  ): Promise<ParentChildRelinkResult> {
    const subtreeIds = this.collectSubtreeIds(childTaskId, tasks);
    const subtreeCount = subtreeIds.size;

    this.logger.info('执行子树迁移', {
      childTaskId,
      childTitle: childTask.title,
      oldParentId,
      newParentId,
      newParentTitle: newParentTask.title,
      subtreeCount
    });

    const result = await this.taskOps.moveSubtreeToNewParent(childTaskId, newParentId);
    if (!result.ok) {
      const errorMessage = result.error?.message || '未知错误';
      this.toast.error('迁移失败', errorMessage);
      return 'error';
    }

    this.showSubtreeMoveSuccess(childTask, newParentTask, subtreeCount);
    return 'success';
  }

  private showSubtreeMoveSuccess(childTask: Task, newParentTask: Task, subtreeCount: number): void {
    if (subtreeCount > 1) {
      this.toast.success(
        '子树迁移成功',
        `已将 "${childTask.title}" 及其 ${subtreeCount - 1} 个子任务移动到 "${newParentTask.title}" 下`
      );
      return;
    }

    this.toast.success('任务迁移成功', `已将 "${childTask.title}" 移动到 "${newParentTask.title}" 下`);
  }

  /**
   * 处理父子连接下游端点（to端）的重连
   *
   * 【场景】用户拖动父子连接线的下游端点到新的目标节点
   *
   * 例如：原连接 A → B，用户将下游端点从 B 拖到 C
   * - 如果 C 是待分配块：执行子树替换（B 变成待分配，C 成为 A 的新子节点）
   * - 如果 C 是已分配任务：拒绝操作（一个任务不能有两个父节点）
   *
   * @param parentId 父任务 ID（连接线的 from 端，保持不变）
   * @param oldChildId 原子任务 ID（被断开的节点）
   * @param newTargetId 新目标节点 ID（连接线被拖到的节点）
   * @returns 操作结果
   */
  async handleParentChildRelinkToEnd(
    parentId: string,
    oldChildId: string,
    newTargetId: string
  ): Promise<ParentChildRelinkToEndResult> {
    if (this.guardHintOnlyLinkMutation('替换子任务')) {
      return 'cancelled';
    }

    const endpointResult = this.guardParentChildRelinkToEndEndpoints(parentId, oldChildId, newTargetId);
    if (endpointResult) return endpointResult;

    const parentTask = this.projectState.getTask(parentId);
    const oldChildTask = this.projectState.getTask(oldChildId);
    const newTargetTask = this.projectState.getTask(newTargetId);

    if (!parentTask) {
      this.toast.error('操作失败', '找不到父任务');
      return 'error';
    }

    if (!newTargetTask) {
      this.toast.error('操作失败', '找不到目标节点');
      return 'error';
    }

    this.logger.info('handleParentChildRelinkToEnd 调用', {
      parentId,
      oldChildId,
      newTargetId,
      parentStage: parentTask.stage,
      oldChildStage: oldChildTask?.stage,
      newTargetStage: newTargetTask.stage
    });

    if (newTargetTask.stage === null && parentTask.stage !== null) {
      return this.replaceRelinkTargetWithUnassigned(parentTask, oldChildId, newTargetTask);
    }

    if (newTargetTask.stage !== null) {
      return this.rejectAssignedRelinkTarget(newTargetTask);
    }

    if (parentTask.stage === null && newTargetTask.stage === null) {
      return this.linkUnassignedRelinkTarget(parentTask, newTargetTask);
    }

    return 'error';
  }

  private guardParentChildRelinkToEndEndpoints(
    parentId: string,
    oldChildId: string,
    newTargetId: string
  ): 'cancelled' | 'error' | null {
    if (parentId === newTargetId) {
      this.toast.warning('无法连接', '节点不能连接到自身');
      return 'error';
    }

    if (oldChildId === newTargetId) {
      this.logger.debug('目标节点未变化，跳过操作');
      return 'cancelled';
    }

    return null;
  }

  private async replaceRelinkTargetWithUnassigned(
    parentTask: Task,
    oldChildId: string,
    newTargetTask: Task
  ): Promise<ParentChildRelinkToEndResult> {
    this.logger.info('场景1：父子连接下游端点拖到待分配块（替换模式，只替换特定子任务）', {
      parentId: parentTask.id,
      parentTitle: parentTask.title,
      oldChildId,
      newTargetId: newTargetTask.id,
      newTargetTitle: newTargetTask.title
    });

    const linkResult = await this.handleTaskToUnassignedLink(parentTask.id, newTargetTask.id, newTargetTask, true, oldChildId);
    if (linkResult === 'replace-subtree') return 'replace-subtree';
    if (linkResult === 'create-parent-child') return 'success';
    return 'error';
  }

  private rejectAssignedRelinkTarget(newTargetTask: Task): ParentChildRelinkResult {
    if (newTargetTask.parentId) {
      this.toast.warning('无法连接', '目标任务已有父节点，无法建立新的父子关系');
      return 'error';
    }

    this.toast.warning('无法连接', '无法将已分配的根任务设为子任务，请使用拖拽节点的方式');
    return 'error';
  }

  private async linkUnassignedRelinkTarget(parentTask: Task, newTargetTask: Task): Promise<ParentChildRelinkResult> {
    const result = await this.taskOps.moveTaskToStage(newTargetTask.id, null, undefined, parentTask.id);
    if (!result.ok) {
      this.toast.error('连接失败', result.error?.message || '未知错误');
      return 'error';
    }

    this.toast.success('已建立待分配层级', '待分配块已挂载到新的父节点');
    return 'success';
  }

  /**
   * 处理跨树连接的重连
   * 当用户拖动跨树连接线的起点或终点到新节点时调用
   *
   * @param oldSourceId 原始起点节点 ID
   * @param oldTargetId 原始终点节点 ID
   * @param newSourceId 新的起点节点 ID
   * @param newTargetId 新的终点节点 ID
   * @param changedEnd 'from' | 'to' 哪一端被改变了
   * @returns 操作结果：'success' | 'cancelled' | 'error'
   */
  async handleCrossTreeRelink(
    oldSourceId: string,
    oldTargetId: string,
    newSourceId: string,
    newTargetId: string,
    changedEnd: 'from' | 'to'
  ): Promise<ParentChildRelinkResult> {
    if (this.guardHintOnlyLinkMutation('重连关联')) {
      return 'cancelled';
    }

    const context = this.prepareCrossTreeRelink(
      oldSourceId,
      oldTargetId,
      newSourceId,
      newTargetId
    );
    if (context.result) return context.result;

    const { sourceTask, targetTask } = context;
    const duplicateResult = this.cancelDuplicateCrossTreeRelink(sourceTask, targetTask);
    if (duplicateResult) return duplicateResult;

    this.logger.info('执行跨树连接重连', {
      oldSourceId,
      oldTargetId,
      newSourceId,
      newTargetId,
      changedEnd,
      sourceTitle: sourceTask.title,
      targetTitle: targetTask.title
    });

    const saved = await this.taskOps.connectionAdapter.relinkCrossTreeConnection(oldSourceId, oldTargetId, newSourceId, newTargetId);
    if (!saved) {
      this.toast.error('重连失败', '关联变更未能写入本地队列');
      return 'error';
    }

    this.showCrossTreeRelinkSuccess(oldSourceId, oldTargetId, changedEnd, sourceTask, targetTask);
    return 'success';
  }

  private prepareCrossTreeRelink(
    oldSourceId: string,
    oldTargetId: string,
    newSourceId: string,
    newTargetId: string
  ): { result: ParentChildRelinkResult; sourceTask?: never; targetTask?: never } | {
    result: null;
    sourceTask: Task;
    targetTask: Task;
  } {
    const endpointResult = this.guardCrossTreeRelinkEndpoints(oldSourceId, oldTargetId, newSourceId, newTargetId);
    if (endpointResult) return { result: endpointResult };

    const sourceTask = this.projectState.getTask(newSourceId);
    const targetTask = this.projectState.getTask(newTargetId);

    if (!sourceTask) {
      this.toast.error('重连失败', '找不到起点任务');
      return { result: 'error' };
    }

    if (!targetTask) {
      this.toast.error('重连失败', '找不到终点任务');
      return { result: 'error' };
    }

    return { result: null, sourceTask, targetTask };
  }

  private guardCrossTreeRelinkEndpoints(
    oldSourceId: string,
    oldTargetId: string,
    newSourceId: string,
    newTargetId: string
  ): 'cancelled' | 'error' | null {
    if (newSourceId === newTargetId) {
      this.toast.warning('无法连接', '节点不能连接到自身');
      return 'error';
    }

    if (oldSourceId === newSourceId && oldTargetId === newTargetId) {
      this.logger.debug('跨树连接未变化，跳过');
      return 'cancelled';
    }

    return null;
  }

  private cancelDuplicateCrossTreeRelink(sourceTask: Task, targetTask: Task): 'cancelled' | null {
    const project = this.projectState.activeProject();
    const existingConnection = project?.connections?.find(
      c => c.source === sourceTask.id && c.target === targetTask.id && !c.deletedAt
    );

    if (!existingConnection) {
      return null;
    }

    this.toast.warning('连接已存在', `"${sourceTask.title}" 到 "${targetTask.title}" 的关联已存在`);
    return 'cancelled';
  }

  private showCrossTreeRelinkSuccess(
    oldSourceId: string,
    oldTargetId: string,
    changedEnd: 'from' | 'to',
    sourceTask: Task,
    targetTask: Task
  ): void {
    const changedEndText = changedEnd === 'from' ? '起点' : '终点';
    const oldTaskTitle = changedEnd === 'from'
      ? this.projectState.getTask(oldSourceId)?.title
      : this.projectState.getTask(oldTargetId)?.title;
    const newTaskTitle = changedEnd === 'from' ? sourceTask.title : targetTask.title;

    this.toast.success('关联重连成功', `已将关联${changedEndText}从 "${oldTaskTitle}" 移动到 "${newTaskTitle}"`);
  }

  /**
   * 处理将子树迁移到根节点（stage 1）
   * @param childTaskId 被迁移的子任务 ID
   * @param oldParentId 原父任务 ID
   */
  async handleMoveSubtreeToRoot(childTaskId: string, oldParentId: string): Promise<'success' | 'cancelled' | 'error'> {
    const tasks = this.projectState.tasks();
    const childTask = this.projectState.getTask(childTaskId);

    if (!childTask) {
      this.toast.error('迁移失败', '找不到要迁移的任务');
      return 'error';
    }

    // 收集子树信息
    const subtreeIds = this.collectSubtreeIds(childTaskId, tasks);
    const subtreeCount = subtreeIds.size;

    this.logger.info('执行子树迁移到根节点', {
      childTaskId,
      childTitle: childTask.title,
      oldParentId,
      subtreeCount
    });

    // 执行迁移（newParentId = null 表示迁移到根节点）
    const result = await this.taskOps.moveSubtreeToNewParent(childTaskId, null);

    if (result.ok) {
      if (subtreeCount > 1) {
        this.toast.success(
          '子树迁移成功',
          `已将 "${childTask.title}" 及其 ${subtreeCount - 1} 个子任务提升为根任务`
        );
      } else {
        this.toast.success(
          '任务迁移成功',
          `已将 "${childTask.title}" 提升为根任务`
        );
      }
      return 'success';
    } else {
      const errorMessage = result.error?.message || '未知错误';
      this.toast.error('迁移失败', errorMessage);
      return 'error';
    }
  }

  // ========== 工具方法 ==========

  /**
   * 收集指定任务及其所有后代的 ID
   */
  collectSubtreeIds(taskId: string, tasks: Task[]): Set<string> {
    const result = new Set<string>();
    const stack = [taskId];

    while (stack.length > 0) {
      const currentId = stack.pop()!;
      result.add(currentId);
      tasks.filter(t => t.parentId === currentId && !t.deletedAt).forEach(child => {
        stack.push(child.id);
      });
    }

    return result;
  }
}
