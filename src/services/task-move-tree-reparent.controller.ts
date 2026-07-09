import type { Project, Task } from '../models';
import { LAYOUT_CONFIG } from '../config/layout.config';
import { ErrorCodes, failure, type OperationError, type Result, success } from '../utils/result';

export interface TaskMoveTreeReparentControllerOptions {
  getActiveProject: () => Project | null;
  getTask: (taskId: string) => Task | null | undefined;
  layoutService: {
    detectCycle(taskId: string, newParentId: string, tasks: Task[]): boolean;
    rebalance(project: Project): Project;
  };
  localPersistenceFailure: (context: Record<string, unknown>) => Result<void, OperationError>;
  recordAndUpdate: (mutator: (project: Project) => Project) => void;
  recordAndUpdateDurably: (mutator: (project: Project) => Project) => Promise<boolean>;
  subtreeOps: {
    collectSubtreeIds(taskId: string, tasks: Task[]): Set<string>;
    computeNewRankForMigratedTask(taskId: string, newParentId: string | null, tasks: Task[]): number;
    fixSubtreeRanks(taskId: string, tasks: Task[]): void;
    updateParentChildConnections(
      taskId: string,
      oldParentId: string | null,
      newParentId: string | null,
      connections: Project['connections'],
    ): Project['connections'];
    updateSubtreeStages(subtreeIds: Set<string>, stageOffset: number, tasks: Task[]): void;
  };
}

export class TaskMoveTreeReparentController {
  constructor(private readonly options: TaskMoveTreeReparentControllerOptions) {}

  getUnassignedParent(taskId: string): string | null {
    const activeP = this.options.getActiveProject();
    if (!activeP) return null;

    const task = this.options.getTask(taskId);
    if (!task || task.stage !== null) return null;

    if (task.parentId) {
      const parent = this.options.getTask(task.parentId);
      if (parent && parent.stage === null) {
        return parent.id;
      }
    }

    return null;
  }

  getDirectChildren(taskId: string): Task[] {
    const activeP = this.options.getActiveProject();
    if (!activeP) return [];

    return activeP.tasks.filter(task => task.parentId === taskId && !task.deletedAt);
  }

  detachTask(taskId: string): Promise<boolean> {
    return this.detachTaskDurably(taskId);
  }

  detachTaskDurably(taskId: string): Promise<boolean> {
    return this.options.recordAndUpdateDurably(project =>
      this.detachTaskInProject(project, taskId));
  }

  deleteTaskKeepChildren(taskId: string): Promise<boolean> {
    return this.deleteTaskKeepChildrenDurably(taskId);
  }

  async deleteTaskKeepChildrenDurably(taskId: string): Promise<boolean> {
    const activeP = this.options.getActiveProject();
    if (!activeP) return false;

    const target = this.options.getTask(taskId);
    if (!target) return false;

    return this.options.recordAndUpdateDurably(project =>
      this.deleteTaskKeepChildrenInProject(project, taskId));
  }

  moveSubtreeToNewParent(taskId: string, newParentId: string | null): Promise<Result<void, OperationError>> {
    return this.moveSubtreeToNewParentDurably(taskId, newParentId);
  }

  async moveSubtreeToNewParentDurably(
    taskId: string,
    newParentId: string | null,
  ): Promise<Result<void, OperationError>> {
    const validation = this.validateSubtreeReparent(taskId, newParentId);
    if (!validation.ok) return validation.result;

    let operationResult: Result<void, OperationError> = success(undefined);
    const saved = await this.options.recordAndUpdateDurably(project =>
      this.moveSubtreeInProject(project, taskId, newParentId, validation.oldParentId, result => {
        operationResult = result;
      }));

    if (!saved) {
      return this.options.localPersistenceFailure({ taskId, newParentId });
    }

    return operationResult;
  }

  private detachTaskInProject(project: Project, taskId: string): Project {
    const tasks = project.tasks.map(task => ({ ...task }));
    const taskMap = new Map(tasks.map(task => [task.id, task] as const));
    const target = taskMap.get(taskId);
    if (!target) return project;

    const parentId = target.parentId;
    const parent = parentId ? taskMap.get(parentId) : undefined;
    this.promoteChildrenToParent(tasks, target, parentId, parent);
    this.moveDetachedTaskToUnassigned(tasks, target);

    return this.options.layoutService.rebalance({ ...project, tasks });
  }

  private deleteTaskKeepChildrenInProject(project: Project, taskId: string): Project {
    const tasks = project.tasks.map(task => ({ ...task }));
    const taskMap = new Map(tasks.map(task => [task.id, task] as const));
    const targetTask = taskMap.get(taskId);
    if (!targetTask) return project;

    const parentId = targetTask.parentId;
    const parentTask = parentId ? taskMap.get(parentId) ?? null : null;
    this.promoteChildrenBeforeDelete(tasks, taskId, parentId, parentTask);

    const filteredTasks = tasks.filter(task => task.id !== taskId);
    const filteredConnections = project.connections.filter(
      connection => connection.source !== taskId && connection.target !== taskId,
    );

    return this.options.layoutService.rebalance({
      ...project,
      tasks: filteredTasks,
      connections: filteredConnections,
    });
  }

  private moveSubtreeInProject(
    project: Project,
    taskId: string,
    newParentId: string | null,
    oldParentId: string | null,
    setResult: (result: Result<void, OperationError>) => void,
  ): Project {
    const tasks = project.tasks.map(task => ({ ...task }));
    const taskMap = new Map(tasks.map(task => [task.id, task] as const));
    const target = taskMap.get(taskId);
    if (!target) {
      setResult(failure(ErrorCodes.DATA_NOT_FOUND, '任务不存在'));
      return project;
    }

    const newStage = this.resolveNewStage(newParentId, taskMap, setResult);
    if (newStage === null) return project;

    const stageOffset = newStage - (target.stage ?? 1);
    const subtreeIds = this.options.subtreeOps.collectSubtreeIds(taskId, tasks);
    this.options.subtreeOps.updateSubtreeStages(subtreeIds, stageOffset, tasks);

    target.parentId = newParentId;
    target.updatedAt = new Date().toISOString();
    target.rank = this.options.subtreeOps.computeNewRankForMigratedTask(taskId, newParentId, tasks);
    this.options.subtreeOps.fixSubtreeRanks(taskId, tasks);

    const connections = this.options.subtreeOps.updateParentChildConnections(
      taskId,
      oldParentId,
      newParentId,
      project.connections,
    );

    return this.options.layoutService.rebalance({ ...project, tasks, connections });
  }

  private validateSubtreeReparent(
    taskId: string,
    newParentId: string | null,
  ): { ok: true; oldParentId: string | null } | { ok: false; result: Result<void, OperationError> } {
    const activeP = this.options.getActiveProject();
    if (!activeP) {
      return { ok: false, result: failure(ErrorCodes.DATA_NOT_FOUND, '没有活动项目') };
    }

    const targetTask = this.options.getTask(taskId);
    if (!targetTask) {
      return { ok: false, result: failure(ErrorCodes.DATA_NOT_FOUND, '要迁移的任务不存在') };
    }

    const oldParentId = targetTask.parentId;
    if (oldParentId === newParentId) {
      return { ok: false, result: success(undefined) };
    }

    if (newParentId && this.options.layoutService.detectCycle(taskId, newParentId, activeP.tasks)) {
      return {
        ok: false,
        result: failure(ErrorCodes.LAYOUT_CYCLE_DETECTED, '无法迁移：目标父任务是当前任务的后代，会产生循环依赖'),
      };
    }

    return { ok: true, oldParentId };
  }

  private resolveNewStage(
    newParentId: string | null,
    taskMap: Map<string, Task>,
    setResult: (result: Result<void, OperationError>) => void,
  ): number | null {
    if (newParentId === null) return 1;

    const newParent = taskMap.get(newParentId) ?? null;
    if (newParent) return (newParent.stage ?? 0) + 1;

    setResult(failure(ErrorCodes.DATA_NOT_FOUND, '新父任务不存在'));
    return null;
  }

  private promoteChildrenToParent(
    tasks: Task[],
    target: Task,
    parentId: string | null,
    parent: Task | undefined,
  ): void {
    tasks.forEach(child => {
      if (child.parentId !== target.id) return;

      child.parentId = parentId;
      if (parent && parent.stage !== null && parent.stage !== undefined && Number.isFinite(parent.stage)) {
        child.stage = parent.stage + 1;
      }
    });
  }

  private moveDetachedTaskToUnassigned(tasks: Task[], target: Task): void {
    target.stage = null;
    target.parentId = null;
    const unassignedCount = tasks.filter(task => task.stage === null && task.id !== target.id).length;
    target.order = unassignedCount + 1;
    target.rank = LAYOUT_CONFIG.RANK_ROOT_BASE + unassignedCount * LAYOUT_CONFIG.RANK_STEP;
    target.displayId = '?';
  }

  private promoteChildrenBeforeDelete(
    tasks: Task[],
    taskId: string,
    parentId: string | null,
    parentTask: Task | null,
  ): void {
    tasks.forEach(child => {
      if (child.parentId !== taskId) return;

      child.parentId = parentId;
      if (parentTask?.stage !== null && parentTask?.stage !== undefined) {
        child.stage = parentTask.stage + 1;
      } else if (parentId === null) {
        child.stage = 1;
      }
    });
  }
}
