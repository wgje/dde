import { Injectable, inject } from '@angular/core';
import { Task, Connection } from '../models';
import { Result, OperationError, success, failure, ErrorCodes } from '../utils/result';
import { LayoutService } from './layout.service';
import { FLOATING_TREE_CONFIG, LAYOUT_CONFIG } from '../config/layout.config';

/**
 * 子树操作服务
 * 负责子树迁移、待分配块分配等复杂操作
 * 
 * 从 TaskOperationService 提取，实现关注点分离
 */
@Injectable({ providedIn: 'root' })
export class SubtreeOperationsService {
  private readonly layoutService = inject(LayoutService);

  // ========== 子树工具方法 ==========

  /**
   * 收集指定任务及其所有后代的 ID
   */
  collectSubtreeIds(taskId: string, tasks: Task[]): Set<string> {
    const result = new Set<string>();
    const stack = [taskId];

    while (stack.length > 0) {
      const currentId = stack.pop()!;
      // 循环防护：已访问节点不再入栈
      if (result.has(currentId)) continue;
      result.add(currentId);
      tasks.filter(t => t.parentId === currentId).forEach(child => {
        stack.push(child.id);
      });
    }

    return result;
  }

  /**
   * 计算子树深度
   * @param taskId 根节点 ID
   * @param tasks 所有任务
   * @returns 子树最大深度（根节点深度为 0）
   */
  getSubtreeDepth(taskId: string, tasks: Task[]): number {
    let maxDepth = 0;
    const stack: { id: string; depth: number }[] = [{ id: taskId, depth: 0 }];
    const visited = new Set<string>();

    while (stack.length > 0) {
      const { id, depth } = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);

      maxDepth = Math.max(maxDepth, depth);

      // 防止无限递归
      if (depth >= FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH) continue;

      tasks.filter(t => t.parentId === id && !t.deletedAt)
        .forEach(child => stack.push({ id: child.id, depth: depth + 1 }));
    }

    return maxDepth;
  }

  /**
   * 获取动态最大阶段索引
   * 基于当前项目中最大的 stage + 缓冲区
   */
  getMaxStageIndex(tasks: Task[]): number {
    const currentMax = Math.max(
      ...tasks.filter(t => t.stage !== null && !t.deletedAt).map(t => t.stage!),
      0
    );
    return currentMax + FLOATING_TREE_CONFIG.STAGE_BUFFER;
  }

  /**
   * 验证阶段容量（阶段溢出预检查）
   * 检查将任务子树分配到目标阶段是否会导致子任务超出最大阶段限制
   */
  validateStageCapacity(
    taskId: string,
    targetStage: number,
    tasks: Task[]
  ): Result<void, OperationError> {
    const subtreeDepth = this.getSubtreeDepth(taskId, tasks);
    const maxStageIndex = this.getMaxStageIndex(tasks);

    if (targetStage + subtreeDepth > maxStageIndex) {
      return failure(
        ErrorCodes.STAGE_OVERFLOW,
        `操作被拦截：子任务将超出最大阶段限制（需要 ${targetStage + subtreeDepth}，最大 ${maxStageIndex}）`,
        { requiredStage: targetStage + subtreeDepth, maxStage: maxStageIndex, subtreeDepth }
      );
    }

    return success(undefined);
  }

  /**
   * 验证父子阶段一致性（同源不变性）
   * 确保父子任务必须同时在待分配区或同时在阶段中
   */
  validateParentChildStageConsistency(
    parentId: string | null,
    childStage: number | null,
    tasks: Task[]
  ): Result<void, OperationError> {
    if (!parentId) return success(undefined);

    const taskMap = new Map(tasks.map(t => [t.id, t] as const));
    const parent = taskMap.get(parentId);
    if (!parent) return success(undefined);

    const parentIsUnassigned = parent.stage === null;
    const childIsUnassigned = childStage === null;

    // 同源检查：父子必须同为已分配或同为未分配
    if (parentIsUnassigned !== childIsUnassigned) {
      return failure(
        ErrorCodes.CROSS_BOUNDARY_VIOLATION,
        '非法操作：父任务和子任务必须同时在待分配区或同时在阶段中',
        { parentStage: parent.stage, childStage }
      );
    }

    // 如果都已分配，检查阶段关系：子任务必须在父任务的下一阶段
    if (!parentIsUnassigned && !childIsUnassigned) {
      if (childStage !== parent.stage! + 1) {
        return failure(
          ErrorCodes.CROSS_BOUNDARY_VIOLATION,
          '非法操作：子任务必须在父任务的下一阶段',
          { parentStage: parent.stage, childStage, expectedChildStage: parent.stage! + 1 }
        );
      }
    }

    return success(undefined);
  }

  /**
   * 确保子节点的 rank 始终大于父节点的 rank
   */
  fixSubtreeRanks(rootId: string, tasks: Task[]): void {
    const taskMap = new Map(tasks.map(t => [t.id, t] as const));
    const stack: { taskId: string; parentRank: number }[] = [];
    const rootTask = taskMap.get(rootId);
    if (!rootTask) return;

    // 获取根任务的直接子节点
    const rootChildren = tasks.filter(t => t.parentId === rootId && !t.deletedAt);
    rootChildren.forEach(child => {
      stack.push({ taskId: child.id, parentRank: rootTask.rank });
    });

    let iterations = 0;
    const maxIterations = tasks.length * 10;

    while (stack.length > 0 && iterations < maxIterations) {
      iterations++;
      const { taskId, parentRank } = stack.pop()!;
      const task = taskMap.get(taskId);
      if (!task) continue;

      // 确保子节点 rank > 父节点 rank
      if (task.rank <= parentRank) {
        task.rank = parentRank + LAYOUT_CONFIG.RANK_STEP;
      }

      // 将子节点加入栈中继续处理
      const children = tasks.filter(t => t.parentId === taskId && !t.deletedAt);
      children.forEach(child => {
        stack.push({ taskId: child.id, parentRank: task.rank });
      });
    }
  }

  /**
   * 检查插入操作是否会产生循环依赖
   */
  wouldCreateCycle(taskId: string, sourceId: string, targetId: string, tasks: Task[]): boolean {
    const taskMap = new Map(tasks.map(t => [t.id, t] as const));
    let current = taskMap.get(sourceId);
    while (current && current.parentId) {
      if (current.parentId === taskId) {
        return true;
      }
      current = taskMap.get(current!.parentId);
    }

    const targetSubtree = this.collectSubtreeIds(targetId, tasks);
    if (targetSubtree.has(taskId)) {
      return true;
    }

    return false;
  }

  /**
   * 级联更新子任务的 stage
   * 当父任务移动到新阶段时，所有子任务的 stage 需要同步更新
   */
  cascadeUpdateChildrenStage(parentId: string, parentNewStage: number, tasks: Task[]): void {
    const taskMap = new Map(tasks.map(t => [t.id, t] as const));
    const MAX_DEPTH = 500;
    const queue: { taskId: string; parentStage: number; depth: number }[] = [];

    // 获取父任务的直接子节点
    const directChildren = tasks.filter(t => t.parentId === parentId && !t.deletedAt);
    directChildren.forEach(child => {
      queue.push({ taskId: child.id, parentStage: parentNewStage, depth: 1 });
    });

    const visited = new Set<string>();
    let iterations = 0;
    const maxIterations = tasks.length * 2;

    while (queue.length > 0 && iterations < maxIterations) {
      iterations++;
      const { taskId, parentStage, depth } = queue.shift()!;

      if (visited.has(taskId) || depth > MAX_DEPTH) continue;
      visited.add(taskId);

      const task = taskMap.get(taskId);
      if (!task || task.deletedAt) continue;

      // 更新阶段：父阶段 + 1
      task.stage = parentStage + 1;
      task.updatedAt = new Date().toISOString();

      // 将子节点加入队列
      const children = tasks.filter(t => t.parentId === taskId && !t.deletedAt);
      children.forEach(child => {
        queue.push({ taskId: child.id, parentStage: task.stage!, depth: depth + 1 });
      });
    }
  }

  // ========== 子树分配操作 ==========

  /**
   * 将待分配块子树整体分配到目标阶段
   * 更新所有任务的 stage，设置根节点的 parentId
   * 
   * @returns 更新后的任务数组（可变）
   */
  assignSubtreeToStage(
    targetId: string,
    sourceTaskId: string,
    targetStage: number,
    tasks: Task[]
  ): void {
    const taskMap = new Map(tasks.map(t => [t.id, t] as const));
    const target = taskMap.get(targetId)!;
    const targetSubtreeIds = this.collectSubtreeIds(targetId, tasks);
    const queue: { task: Task; depth: number }[] = [{ task: target, depth: 0 }];
    const visited = new Set<string>();
    const now = new Date().toISOString();

    while (queue.length > 0) {
      const { task, depth } = queue.shift()!;
      if (visited.has(task.id)) continue;
      visited.add(task.id);

      // 设置阶段：根节点为 targetStage，子节点递增
      task.stage = targetStage + depth;
      task.updatedAt = now;

      // 根节点设置新的父节点为源任务
      if (depth === 0) {
        task.parentId = sourceTaskId;
      }

      // 收集子节点（限制深度防止无限循环）
      if (depth < FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH) {
        const children = tasks.filter(t => t.parentId === task.id && !t.deletedAt);
        children.forEach(child => {
          if (targetSubtreeIds.has(child.id)) {
            queue.push({ task: child, depth: depth + 1 });
          }
        });
      }
    }
  }

  /**
   * 将子任务子树剥离为待分配块
   * 
   * @param childrenToDetach 要剥离的子任务列表
   * @param tasks 所有任务（可变）
   * @returns 被剥离的第一个子任务 ID（子树根）
   */
  detachChildrenAsUnassigned(
    childrenToDetach: Task[],
    tasks: Task[]
  ): string | null {
    if (childrenToDetach.length === 0) return null;

    const taskMap = new Map(tasks.map(t => [t.id, t] as const));
    const now = new Date().toISOString();

    // 选择第一个子节点作为剥离子树的根
    const detachedRootId = childrenToDetach[0].id;

    // 收集被剥离子任务的子树，设置为待分配
    childrenToDetach.forEach(child => {
      const childSubtreeIds = this.collectSubtreeIds(child.id, tasks);
      childSubtreeIds.forEach(id => {
        const t = taskMap.get(id);
        if (t) {
          t.stage = null;
          t.updatedAt = now;
          t.displayId = '?';
        }
      });
      // 断开与源任务的父子关系
      child.parentId = null;
    });

    // 计算待分配区的位置
    const existingUnassignedIds = new Set<string>();
    childrenToDetach.forEach(c => {
      this.collectSubtreeIds(c.id, tasks).forEach(id => existingUnassignedIds.add(id));
    });
    const unassignedCount = tasks.filter(t => t.stage === null && !existingUnassignedIds.has(t.id)).length;

    childrenToDetach.forEach((child, index) => {
      child.order = unassignedCount + index + 1;
      const pos = this.layoutService.getUnassignedPosition(unassignedCount + index);
      child.x = pos.x;
      child.y = pos.y;
      child.rank = LAYOUT_CONFIG.RANK_ROOT_BASE + (unassignedCount + index) * LAYOUT_CONFIG.RANK_STEP;
    });

    return detachedRootId;
  }

  /**
   * 更新子树所有任务的 stage（根据偏移量）
   */
  updateSubtreeStages(
    subtreeIds: Set<string>,
    stageOffset: number,
    tasks: Task[]
  ): void {
    const taskMap = new Map(tasks.map(t => [t.id, t] as const));
    const now = new Date().toISOString();
    subtreeIds.forEach(id => {
      const t = taskMap.get(id);
      if (t && t.stage !== null) {
        t.stage = t.stage + stageOffset;
        t.updatedAt = now;
      }
    });
  }

  /**
   * 为迁移的根任务计算新的 rank
   */
  computeNewRankForMigratedTask(
    taskId: string,
    newParentId: string | null,
    tasks: Task[]
  ): number {
    if (newParentId === null) {
      // 根节点：找 stage 1 的根任务
      const stage1Roots = tasks.filter(t =>
        t.stage === 1 &&
        !t.parentId &&
        t.id !== taskId &&
        !t.deletedAt
      ).sort((a, b) => a.rank - b.rank);

      if (stage1Roots.length > 0) {
        const lastRoot = stage1Roots[stage1Roots.length - 1];
        return lastRoot.rank + LAYOUT_CONFIG.RANK_STEP;
      } else {
        return LAYOUT_CONFIG.RANK_ROOT_BASE;
      }
    } else {
      const taskMap = new Map(tasks.map(t => [t.id, t] as const));
      const newParent = taskMap.get(newParentId);
      if (!newParent) return LAYOUT_CONFIG.RANK_ROOT_BASE;

      // 有父节点：rank 必须大于父节点，且放在兄弟节点末尾
      const siblings = tasks.filter(t =>
        t.parentId === newParentId &&
        t.id !== taskId &&
        !t.deletedAt
      ).sort((a, b) => a.rank - b.rank);

      const parentRank = newParent.rank;

      if (siblings.length > 0) {
        const lastSibling = siblings[siblings.length - 1];
        return Math.max(parentRank + LAYOUT_CONFIG.RANK_STEP, lastSibling.rank + LAYOUT_CONFIG.RANK_STEP);
      } else {
        return parentRank + LAYOUT_CONFIG.RANK_STEP;
      }
    }
  }

  /**
   * 更新连接：移除旧的父子连接，添加新的父子连接
   */
  updateParentChildConnections(
    taskId: string,
    oldParentId: string | null,
    newParentId: string | null,
    connections: Connection[]
  ): Connection[] {
    let result = [...connections];

    // 移除旧的父子连接（如果存在）
    if (oldParentId) {
      result = result.filter(c =>
        !(c.source === oldParentId && c.target === taskId)
      );
    }

    // 添加新的父子连接（如果新父节点存在）
    if (newParentId) {
      const existingConn = result.find(c =>
        c.source === newParentId && c.target === taskId
      );
      if (!existingConn) {
        result.push({
          id: crypto.randomUUID(),
          source: newParentId,
          target: taskId
        });
      }
    }

    return result;
  }
}
