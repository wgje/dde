import { Injectable, inject } from '@angular/core';
import { Task, Project } from '../models';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { LAYOUT_CONFIG, LETTERS } from '../config';
import { hasIncompleteMarkdownTodo } from '../utils/markdown-todo';
import {
  fixOrphanedTasks as fixOrphanedTasksIntegrity,
  validateAndFixTree as validateAndFixTreeIntegrity,
} from './layout-integrity.helpers';

/** 布局算法配置 */
const ALGORITHM_CONFIG = {
  /** 最大树深度限制（防止栈溢出） */
  MAX_TREE_DEPTH: 500,
  /** 基础最大迭代次数 */
  BASE_MAX_ITERATIONS: 10000,
  /** 每个任务增加的迭代次数 */
  ITERATIONS_PER_TASK: 100,
} as const;

/**
 * 计算动态迭代限制
 * 根据任务数量动态调整，确保大型项目能正常处理
 */
function calculateMaxIterations(taskCount: number): number {
  return Math.max(
    ALGORITHM_CONFIG.BASE_MAX_ITERATIONS,
    taskCount * ALGORITHM_CONFIG.ITERATIONS_PER_TASK
  );
}

/**
 * 布局服务
 * 负责任务排序、层级计算、重平衡等纯算法逻辑
 * 从 StoreService 中抽离，实现关注点分离
 * 
 * 改进：
 * - 所有递归算法改为基于栈的迭代算法
 * - 添加最大深度限制防止栈溢出
 * - 添加迭代次数限制防止死循环
 */
@Injectable({
  providedIn: 'root'
})
export class LayoutService {
  private toast = inject(ToastService);
  private loggerService = inject(LoggerService);
  private logger = this.loggerService.category('Layout');
  
  /** 是否已显示过迭代超限警告（避免重复提示） */
  private hasShownIterationWarning = false;

  /** 重平衡锁定的阶段（从 TaskOperationService 迁移，打破循环依赖） */
  private rebalancingStages = new Set<number>();

  /** 检查指定阶段是否正在重平衡 */
  isStageRebalancing(stage: number): boolean {
    return this.rebalancingStages.has(stage);
  }

  /** 标记阶段正在重平衡 */
  markStageRebalancing(stage: number): void {
    this.rebalancingStages.add(stage);
  }

  /** 清除阶段重平衡标记 */
  clearStageRebalancing(stage: number): void {
    this.rebalancingStages.delete(stage);
  }

  // ========== 公共方法 ==========

  /**
   * 重平衡项目中所有任务的层级和排序
   * 这是核心的布局算法，确保任务树的一致性
   */
  rebalance(project: Project): Project {
    // 空项目直接返回
    if (!project.tasks || project.tasks.length === 0) {
      return project;
    }
    
    const tasks = project.tasks.map(t => ({ ...t }));
    const isVisibleTask = this.isVisibleLayoutTask;
    const byId = this.createTaskMap(tasks);

    this.initializeRebalanceTasks(tasks, byId);

    this.repairMissingStageOne(tasks, byId, isVisibleTask);
    this.normalizeStageOrdersAndPositions(tasks);
    this.normalizeUnassignedTasks(tasks);

    this.refreshTaskMap(byId, tasks);
    const allRoots = this.getVisibleAssignedRoots(tasks);
    const stage1Roots = allRoots.filter(t => t.stage === 1);

    this.assignRootDisplayIds(allRoots, stage1Roots);
    this.assignChildDisplayIds(tasks, byId, allRoots);
    this.normalizeMissingDisplayIds(tasks);
    this.cascadeRanks(tasks, byId, stage1Roots);
    this.renumberAssignedOrders(tasks);

    return { ...project, tasks };
  }

  private isVisibleLayoutTask(task: Task): boolean {
    return !task.deletedAt && task.status !== 'archived';
  }

  private createTaskMap(tasks: Task[]): Map<string, Task> {
    const byId = new Map<string, Task>();
    tasks.forEach(task => byId.set(task.id, task));
    return byId;
  }

  private refreshTaskMap(byId: Map<string, Task>, tasks: Task[]): void {
    byId.clear();
    tasks.forEach(task => byId.set(task.id, task));
  }

  private initializeRebalanceTasks(tasks: Task[], byId: Map<string, Task>): void {
    tasks.forEach(task => {
      if (!task.shortId) {
        task.shortId = this.generateShortId(tasks);
      }
    });

    tasks.forEach(task => this.initializeTaskRankAndFlags(task));
    tasks.forEach(task => this.normalizeChildTaskAgainstParent(task, byId));
  }

  private initializeTaskRankAndFlags(task: Task): void {
    if (task.rank === undefined || task.rank === null) {
      const base = task.stage ? this.stageBase(task.stage) : LAYOUT_CONFIG.RANK_ROOT_BASE;
      task.rank = base + (task.order || 0) * LAYOUT_CONFIG.RANK_STEP;
    }
    task.hasIncompleteTask = this.detectIncomplete(task.content);
  }

  private normalizeChildTaskAgainstParent(task: Task, byId: Map<string, Task>): void {
    if (!task.parentId) return;

    const parent = byId.get(task.parentId);
    if (!parent || parent.stage === null) return;

    if (task.stage === null || task.stage <= parent.stage) {
      task.stage = parent.stage + 1;
    }
    if (task.rank <= parent.rank) {
      task.rank = parent.rank + LAYOUT_CONFIG.RANK_STEP;
    }
  }

  private normalizeStageOrdersAndPositions(tasks: Task[]): void {
    const grouped = new Map<number, Task[]>();
    tasks.forEach(task => {
      if (task.stage === null) return;
      if (!grouped.has(task.stage)) grouped.set(task.stage, []);
      grouped.get(task.stage)!.push(task);
    });

    grouped.forEach((list, stage) => {
      list.sort((a, b) => a.rank - b.rank || a.order - b.order);
      list.forEach((task, idx) => {
        task.order = idx + 1;
        if (task.x === undefined || task.y === undefined) {
          const pos = this.gridPosition(stage, idx);
          task.x = pos.x;
          task.y = pos.y;
        }
      });
    });
  }

  private normalizeUnassignedTasks(tasks: Task[]): void {
    const unassigned = tasks.filter(task => task.stage === null).sort((a, b) => a.rank - b.rank || a.order - b.order);
    unassigned.forEach((task, idx) => {
      task.order = idx + 1;
      task.displayId = '?';
    });
  }

  private getVisibleAssignedRoots(tasks: Task[]): Task[] {
    return tasks
      .filter(task => task.stage !== null && !task.parentId && this.isVisibleLayoutTask(task))
      .sort((a, b) => (a.stage ?? 0) - (b.stage ?? 0) || a.rank - b.rank);
  }

  private assignRootDisplayIds(allRoots: Task[], stage1Roots: Task[]): void {
    stage1Roots.forEach((task, idx) => {
      task.displayId = `${idx + 1}`;
    });

    allRoots
      .filter(task => task.stage !== 1)
      .forEach((task, idx) => {
        task.displayId = `O${idx + 1}`;
      });
  }

  private assignChildDisplayIds(tasks: Task[], byId: Map<string, Task>, allRoots: Task[]): void {
    const children = this.createVisibleChildrenMap(tasks);
    allRoots.forEach(root => this.assignChildrenIterative(root.id, tasks.length, byId, children));
  }

  private createVisibleChildrenMap(tasks: Task[]): Map<string, Task[]> {
    const children = new Map<string, Task[]>();
    tasks.forEach(task => {
      if (!task.parentId || !this.isVisibleLayoutTask(task)) return;
      if (!children.has(task.parentId)) children.set(task.parentId, []);
      children.get(task.parentId)!.push(task);
    });
    return children;
  }

  private assignChildrenIterative(
    rootId: string,
    taskCount: number,
    byId: Map<string, Task>,
    children: Map<string, Task[]>,
  ): void {
    const stack: { parentId: string; depth: number }[] = [{ parentId: rootId, depth: 0 }];
    let iterations = 0;
    const maxIterations = calculateMaxIterations(taskCount);

    while (stack.length > 0 && iterations < maxIterations) {
      iterations++;
      const { parentId, depth } = stack.pop()!;
      this.assignChildrenForParent(parentId, depth, byId, children, stack);
    }

    if (iterations >= maxIterations) {
      this.logger.error('displayId 分配迭代次数超限，可能存在循环依赖');
      this.notifyIterationLimit('displayId 分配');
    }
  }

  private assignChildrenForParent(
    parentId: string,
    depth: number,
    byId: Map<string, Task>,
    children: Map<string, Task[]>,
    stack: { parentId: string; depth: number }[],
  ): void {
    if (depth > ALGORITHM_CONFIG.MAX_TREE_DEPTH) {
      this.logger.warn('树深度超过限制，可能存在数据问题', { parentId, depth });
      return;
    }

    const parent = byId.get(parentId);
    if (!parent) return;

    const childList = (children.get(parentId) || []).sort((a, b) => a.rank - b.rank);
    childList.forEach((child, idx) => {
      if (parent.stage !== null && child.stage !== parent.stage + 1) {
        child.stage = parent.stage + 1;
      }
      const letter = LETTERS[idx % LETTERS.length];
      child.displayId = `${parent.displayId},${letter}`;
      stack.push({ parentId: child.id, depth: depth + 1 });
    });
  }

  private normalizeMissingDisplayIds(tasks: Task[]): void {
    tasks.forEach(task => {
      if (!task.displayId) task.displayId = '?';
      if (task.stage === null) task.displayId = '?';
    });
  }

  private cascadeRanks(tasks: Task[], byId: Map<string, Task>, stage1Roots: Task[]): void {
    const childrenMap = this.createVisibleChildrenMap(tasks);
    stage1Roots.forEach(root => this.cascadeRanksIterative(root.id, tasks.length, byId, childrenMap));
  }

  private cascadeRanksIterative(
    rootId: string,
    taskCount: number,
    byId: Map<string, Task>,
    childrenMap: Map<string, Task[]>,
  ): void {
    const queue: { nodeId: string; floor: number; depth: number }[] = [];
    const rootTask = byId.get(rootId);
    if (!rootTask) return;

    queue.push({ nodeId: rootId, floor: rootTask.rank, depth: 0 });
    let iterations = 0;
    const maxIterations = calculateMaxIterations(taskCount);

    while (queue.length > 0 && iterations < maxIterations) {
      iterations++;
      const { nodeId, floor: parentFloor, depth } = queue.shift()!;
      this.cascadeRanksForNode(nodeId, parentFloor, depth, childrenMap, queue);
    }

    if (iterations >= maxIterations) {
      this.logger.error('级联更新迭代次数超限');
      this.notifyIterationLimit('级联更新');
    }
  }

  private cascadeRanksForNode(
    nodeId: string,
    parentFloor: number,
    depth: number,
    childrenMap: Map<string, Task[]>,
    queue: { nodeId: string; floor: number; depth: number }[],
  ): void {
    if (depth > ALGORITHM_CONFIG.MAX_TREE_DEPTH) {
      this.logger.warn('级联更新深度超过限制', { nodeId, depth });
      return;
    }

    const kids = (childrenMap.get(nodeId) || []).sort((a, b) => a.rank - b.rank);
    let currentFloor = parentFloor;
    kids.forEach(child => {
      if (child.rank <= currentFloor) {
        child.rank = currentFloor + LAYOUT_CONFIG.RANK_STEP;
      }
      currentFloor = child.rank;
      queue.push({ nodeId: child.id, floor: child.rank, depth: depth + 1 });
    });
  }

  private renumberAssignedOrders(tasks: Task[]): void {
    tasks
      .filter(task => task.stage !== null)
      .sort((a, b) => a.stage! - b.stage! || a.rank - b.rank)
      .forEach((task, _idx, arr) => {
        const sameStage = arr.filter(candidate => candidate.stage === task.stage);
        const position = sameStage.findIndex(candidate => candidate.id === task.id);
        task.order = position + 1;
      });
  }

  /** 阶段 1 整层缺席时，将最早的可见阶段补回根层，避免后续阶段全部变成 O 系孤儿链。 */
  private repairMissingStageOne(
    tasks: Task[],
    byId: Map<string, Task>,
    isVisibleTask: (task: Task) => boolean
  ): void {
    const visibleAssignedTasks = tasks.filter(task => task.stage !== null && isVisibleTask(task));
    if (visibleAssignedTasks.length === 0 || visibleAssignedTasks.some(task => task.stage === 1)) {
      return;
    }

    const minVisibleStage = Math.min(...visibleAssignedTasks.map(task => task.stage ?? 1));
    if (!Number.isFinite(minVisibleStage) || minVisibleStage <= 1) {
      return;
    }

    const stageOffset = minVisibleStage - 1;
    const visibleTaskIds = new Set(visibleAssignedTasks.map(task => task.id));

    visibleAssignedTasks.forEach(task => {
      if (task.parentId) {
        const parent = byId.get(task.parentId);
        const parentVisible = parent && visibleTaskIds.has(parent.id) && isVisibleTask(parent);
        if (!parentVisible || parent?.stage === null) {
          task.parentId = null;
        }
      }

      task.stage = Math.max(1, (task.stage ?? minVisibleStage) - stageOffset);
      if (Number.isFinite(task.rank)) {
        task.rank = Math.max(LAYOUT_CONFIG.RANK_STEP, task.rank - stageOffset * LAYOUT_CONFIG.RANK_ROOT_BASE);
      }
      if (Number.isFinite(task.x)) {
        task.x = task.x - stageOffset * LAYOUT_CONFIG.STAGE_SPACING;
      }
      task.displayId = '?';
    });
  }

  /**
   * 计算网格位置
   */
  gridPosition(stage: number, index: number) {
    return {
      x: (stage - 1) * LAYOUT_CONFIG.STAGE_SPACING + 120,
      y: 100 + index * LAYOUT_CONFIG.ROW_SPACING
    };
  }

  /**
   * 计算未分配任务的位置
   * 
   * 【浮动任务树增强】
   * - 如果有父节点且父节点也在待分配区，放在父节点附近
   * - 否则使用网格布局
   * 
   * @param existingCount 已存在的未分配任务数量
   * @param parentId 父节点ID（可选）
   * @param tasks 所有任务（可选，用于查找父节点位置）
   */
  getUnassignedPosition(
    existingCount: number, 
    parentId?: string | null, 
    tasks?: Task[]
  ): { x: number; y: number } {
    // 如果有父节点且父节点也在待分配区，放在父节点附近
    if (parentId && tasks) {
      const parent = tasks.find(t => t.id === parentId);
      if (parent && parent.stage === null && parent.x !== undefined && parent.y !== undefined) {
        // 计算该父节点已有多少个子节点（用于垂直偏移）
        const siblingCount = tasks.filter(t => t.parentId === parentId && t.stage === null).length;
        return {
          x: parent.x + 180,  // 父节点右侧
          y: parent.y + siblingCount * 60  // 每个子节点垂直间隔 60px
        };
      }
    }
    
    // 默认网格布局
    const cols = 3; // 每行3个
    const row = Math.floor(existingCount / cols);
    const col = existingCount % cols;
    
    return {
      x: 80 + col * 180,
      y: 80 + row * 120
    };
  }

  /**
   * 智能计算新节点位置
   * 考虑同一阶段现有节点的实际位置，使新节点出现在附近
   * 
   * @param stage 目标阶段
   * @param index 节点在该阶段的索引
   * @param existingTasks 所有已存在的任务
   * @param parentId 父节点ID（如果有）
   * @returns 新节点的坐标
   */
  getSmartPosition(
    stage: number | null,
    index: number,
    existingTasks: Task[],
    parentId?: string | null
  ): { x: number; y: number } {
    // 未分配任务，使用增强的位置计算（支持父子关系）
    if (stage === null) {
      return this.getUnassignedPosition(
        existingTasks.filter(t => t.stage === null).length,
        parentId,
        existingTasks
      );
    }

    // 获取同一阶段的所有可见任务（排除已删除和归档的）
    const sameStageTasks = existingTasks.filter(
      t => t.stage === stage && !t.deletedAt && t.status !== 'archived'
    );

    // 如果有父节点，优先考虑父节点的位置
    const childPosition = this.getChildSmartPosition(parentId, existingTasks);
    if (childPosition) return childPosition;

    // 如果该阶段已有节点，找到最后一个节点的位置
    const stageTailPosition = this.getStageTailSmartPosition(stage, index, sameStageTasks);
    if (stageTailPosition) return stageTailPosition;

    // 如果该阶段没有节点，查找相邻阶段的节点位置作为参考
    const prevStageTasks = existingTasks.filter(
      t => t.stage === stage - 1 && !t.deletedAt && t.status !== 'archived' &&
           t.x !== undefined && t.y !== undefined
    );
    
    if (prevStageTasks.length > 0) {
      // 计算前一阶段节点的平均 Y 坐标
      const avgY = prevStageTasks.reduce((sum, t) => sum + (t.y || 0), 0) / prevStageTasks.length;
      return {
        x: (stage - 1) * LAYOUT_CONFIG.STAGE_SPACING + 120,
        y: avgY + (index * 60) // 使用前一阶段的平均高度，每个新节点偏移60
      };
    }

    // 兜底：使用固定网格位置
    return this.gridPosition(stage, index);
  }

  private getChildSmartPosition(parentId: string | null | undefined, existingTasks: Task[]): { x: number; y: number } | null {
    if (!parentId) return null;

    const parent = existingTasks.find(t => t.id === parentId);
    if (!parent || parent.x === undefined || parent.y === undefined) return null;

    const siblingCount = existingTasks.filter(
      t => t.parentId === parentId && !t.deletedAt && t.status !== 'archived'
    ).length;

    return {
      x: parent.x + LAYOUT_CONFIG.STAGE_SPACING,
      y: parent.y + (siblingCount * LAYOUT_CONFIG.ROW_SPACING)
    };
  }

  private getStageTailSmartPosition(
    stage: number,
    index: number,
    sameStageTasks: Task[],
  ): { x: number; y: number } | null {
    const sortedTasks = sameStageTasks
      .filter(t => t.x !== undefined && t.y !== undefined)
      .sort((a, b) => (a.y || 0) - (b.y || 0));

    if (sortedTasks.length === 0) return null;

    const lastTask = sortedTasks[sortedTasks.length - 1];
    return {
      x: lastTask.x || this.gridPosition(stage, index).x,
      y: (lastTask.y || 0) + LAYOUT_CONFIG.ROW_SPACING
    };
  }

  /**
   * 计算阶段的基础 rank 值
   */
  stageBase(stage: number) {
    return LAYOUT_CONFIG.RANK_ROOT_BASE + (stage - 1) * LAYOUT_CONFIG.RANK_ROOT_BASE;
  }

  /**
   * 计算插入位置的 rank 值
   */
  computeInsertRank(
    stage: number, 
    siblings: Task[], 
    beforeId?: string | null, 
    parentRank?: number | null
  ): { rank: number; needsRebalance: boolean } {
    const sorted = siblings.filter(t => t.stage === stage).sort((a, b) => a.rank - b.rank);
    const base = parentRank !== null && parentRank !== undefined 
      ? parentRank + LAYOUT_CONFIG.RANK_STEP 
      : this.stageBase(stage);
    
    let prev: Task | null = null;
    let next: Task | null = null;
    
    if (beforeId) {
      const idx = sorted.findIndex(t => t.id === beforeId);
      if (idx >= 0) {
        next = sorted[idx];
        prev = idx > 0 ? sorted[idx - 1] : null;
      }
    }
    if (!beforeId || !next) {
      prev = sorted[sorted.length - 1] || null;
      next = null;
    }

    let rank: number;
    let needsRebalance = false;
    
    if (prev && next) {
      rank = (prev.rank + next.rank) / 2;
      // 检测间隔是否过小
      const gap = next.rank - prev.rank;
      if (gap < LAYOUT_CONFIG.RANK_MIN_GAP) {
        needsRebalance = true;
      }
    } else if (prev && !next) {
      rank = prev.rank + LAYOUT_CONFIG.RANK_STEP;
    } else if (!prev && next) {
      rank = next.rank - LAYOUT_CONFIG.RANK_STEP;
    } else {
      rank = base;
    }

    return { rank, needsRebalance };
  }

  /**
   * 获取父节点的最大 rank
   */
  maxParentRank(task: Task | null, tasks: Task[]): number | null {
    if (!task?.parentId) return null;
    const parent = tasks.find(t => t.id === task.parentId);
    return parent ? parent.rank : null;
  }

  /**
   * 获取子节点的最小 rank
   */
  minChildRank(taskId: string, tasks: Task[]): number {
    const children = tasks.filter(t => t.parentId === taskId);
    if (children.length === 0) return Infinity;
    return Math.min(...children.map(c => c.rank));
  }

  /**
   * 应用拒绝策略（确保 rank 不违反父子约束）
   */
  applyRefusalStrategy(
    target: Task, 
    candidateRank: number, 
    parentRank: number | null, 
    minChildRank: number
  ): { ok: boolean; rank: number } {
    let nextRank = candidateRank;
    
    if (parentRank !== null && nextRank <= parentRank) {
      nextRank = parentRank + LAYOUT_CONFIG.RANK_STEP;
    }
    if (Number.isFinite(minChildRank) && nextRank >= minChildRank) {
      nextRank = minChildRank - LAYOUT_CONFIG.RANK_STEP;
    }
    
    const violatesParent = parentRank !== null && nextRank <= parentRank;
    const violatesChild = Number.isFinite(minChildRank) && nextRank >= minChildRank;
    
    if (violatesParent || violatesChild) {
      this.logger.warn('Refused ordering: violates parent/child constraints', {
        taskId: target.id,
        parentRank,
        minChildRank,
        requested: candidateRank
      });
      return { ok: false, rank: candidateRank };
    }
    return { ok: true, rank: nextRank };
  }

  /**
   * 检测循环依赖（使用迭代算法）
   */
  detectCycle(taskId: string, newParentId: string | null, tasks: Task[]): boolean {
    if (!newParentId) return false;
    if (taskId === newParentId) return true;

    const taskMap = new Map(tasks.map(t => [t.id, t] as const));
    const visited = new Set<string>();
    let current: string | null = newParentId;
    let iterations = 0;
    const maxIterations = calculateMaxIterations(tasks.length);

    while (current && iterations < maxIterations) {
      iterations++;

      if (visited.has(current)) return true;
      if (current === taskId) return true;
      visited.add(current);

      const parentTask = taskMap.get(current);
      current = parentTask?.parentId || null;
    }
    
    if (iterations >= maxIterations) {
      this.logger.error('循环检测迭代次数超限，假定存在循环');
      this.notifyIterationLimit('循环检测');
      return true;
    }
    
    return false;
  }

  /**
   * 检测内容中是否有未完成的待办项
   */
  detectIncomplete(content: string): boolean {
    return hasIncompleteMarkdownTodo(content || '');
  }
  
  /**
   * 通知用户迭代超限
   * 使用防抖避免多次弹窗
   */
  private notifyIterationLimit(operation: string): void {
    if (this.hasShownIterationWarning) return;
    
    this.hasShownIterationWarning = true;
    this.toast.warning(
      '数据结构异常',
      `${operation}过程中检测到异常，可能存在循环依赖。建议检查任务的父子关系。`
    );
    
    // 5秒后重置，允许再次显示
    setTimeout(() => {
      this.hasShownIterationWarning = false;
    }, 5000);
  }

  /**
   * 生成永久短 ID
   * 格式: NF-XXXX (X 为大写字母或数字)
   */
  generateShortId(existingTasks: Task[]): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const existingIds = new Set(existingTasks.map(t => t.shortId).filter(Boolean));
    
    let attempts = 0;
    const maxAttempts = 100;
    
    while (attempts < maxAttempts) {
      let id = 'NF-';
      for (let i = 0; i < 4; i++) {
        id += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      
      if (!existingIds.has(id)) {
        return id;
      }
      attempts++;
    }
    
    return `NF-${Date.now().toString(36).toUpperCase().slice(-4)}`;
  }

  /**
   * 重新平衡指定阶段的 rank 值
   * 将阶段内的任务 rank 重新均匀分布
   * 
   * 注意：仅重新分配指定 stage 内的顶层任务 rank，
   * 不会级联更新子任务的 rank。子任务的排序由其 parentId 关联的父任务决定。
   */
  rebalanceStageRanks(tasks: Task[], stages: number[]): Task[] {
    const result = tasks.map(t => ({ ...t }));
    const resultMap = new Map(result.map(t => [t.id, t] as const));

    for (const stage of stages) {
      const stageTasks = result.filter(t => t.stage === stage).sort((a, b) => a.rank - b.rank);
      if (stageTasks.length < 2) continue;

      const base = this.stageBase(stage);
      stageTasks.forEach((t, idx) => {
        const taskInResult = resultMap.get(t.id);
        if (taskInResult) {
          taskInResult.rank = base + (idx + 1) * LAYOUT_CONFIG.RANK_STEP;
        }
      });
    }
    
    return result;
  }

  // ========== 数据完整性检查 ==========

  /**
   * 修复孤儿节点
   * 检查并修复 parentId 指向不存在任务的情况
   */
  fixOrphanedTasks(tasks: Task[]): { tasks: Task[]; fixed: number } {
    return fixOrphanedTasksIntegrity(tasks, (message, context) => this.logger.warn(message, context));
  }

  /**
   * 完整的树结构健康检查
   * 包括循环检测、孤儿修复、rank 验证
   */
  validateAndFixTree(project: Project): { project: Project; issues: string[] } {
    return validateAndFixTreeIntegrity(project, {
      stageBase: stage => this.stageBase(stage),
      warn: (message, context) => this.logger.warn(message, context),
    });
  }
}
