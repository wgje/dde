import type { Project, Task } from '../models';
import { LAYOUT_CONFIG } from '../config';
import { ErrorCodes, failure, type OperationError, type Result, success } from '../utils/result';

export interface InsertBetweenParams {
  taskId: string;
  sourceId: string;
  targetId: string;
}

export interface InsertBetweenAtPositionParams extends InsertBetweenParams {
  x: number;
  y: number;
}

export interface TaskOperationStructureControllerOptions {
  applyRefusalStrategy: (
    task: Task,
    candidateRank: number,
    parentRank: number,
    minChildRank: number,
    tasks: Task[],
  ) => { ok: boolean; rank: number };
  getActiveProject: () => Project | null;
  getTask: (taskId: string) => Task | null | undefined;
  layoutService: {
    maxParentRank(task: Task, tasks: Task[]): number;
    minChildRank(taskId: string, tasks: Task[]): number;
    rebalance(project: Project): Project;
    stageBase(stage: number): number;
  };
  recordAndUpdate: (mutator: (project: Project) => Project) => void;
  recordAndUpdateDurably: (mutator: (project: Project) => Project) => Promise<boolean>;
  subtreeOps: {
    collectSubtreeIds(taskId: string, tasks: Task[]): Set<string>;
    wouldCreateCycle(
      taskId: string,
      sourceId: string,
      targetId: string,
      tasks: Task[],
    ): boolean;
  };
}

export class TaskOperationStructureController {
  constructor(private readonly options: TaskOperationStructureControllerOptions) {}

  insertTaskBetween(params: InsertBetweenParams): Promise<Result<void, OperationError>> {
    return this.insertTaskBetweenDurably(params);
  }

  async insertTaskBetweenDurably(params: InsertBetweenParams): Promise<Result<void, OperationError>> {
    const validation = this.validateInsert(params);
    if (!validation.ok) return validation.result;

    const saved = await this.options.recordAndUpdateDurably(project =>
      this.insertTaskBetweenInProject(project, params));
    if (!saved) {
      return failure(ErrorCodes.OPERATION_FAILED, '任务本地持久化失败，未提交 UI 更新', {
        taskId: params.taskId,
        sourceId: params.sourceId,
        targetId: params.targetId,
      });
    }

    return success(undefined);
  }

  insertTaskBetweenAtPosition(params: InsertBetweenAtPositionParams): Promise<Result<void, OperationError>> {
    return this.insertTaskBetweenAtPositionDurably(params);
  }

  async insertTaskBetweenAtPositionDurably(
    params: InsertBetweenAtPositionParams,
  ): Promise<Result<void, OperationError>> {
    const validation = this.validateInsert(params);
    if (!validation.ok) return validation.result;

    const saved = await this.options.recordAndUpdateDurably(project =>
      this.applyTaskPosition(
        this.insertTaskBetweenInProject(project, params),
        params,
      ));
    if (!saved) {
      return failure(ErrorCodes.OPERATION_FAILED, '任务本地持久化失败，未提交 UI 更新', {
        taskId: params.taskId,
        sourceId: params.sourceId,
        targetId: params.targetId,
        x: params.x,
        y: params.y,
      });
    }

    return success(undefined);
  }

  reorderStage(stage: number, orderedIds: string[]): Promise<boolean> {
    return this.reorderStageDurably(stage, orderedIds);
  }

  reorderStageDurably(stage: number, orderedIds: string[]): Promise<boolean> {
    return this.options.recordAndUpdateDurably(project =>
      this.reorderStageInProject(project, stage, orderedIds));
  }

  private validateInsert(
    params: InsertBetweenParams,
  ): { ok: true } | { ok: false; result: Result<void, OperationError> } {
    const activeP = this.options.getActiveProject();
    if (!activeP) {
      return { ok: false, result: failure(ErrorCodes.DATA_NOT_FOUND, '没有活动项目') };
    }

    const sourceTask = this.options.getTask(params.sourceId);
    const targetTask = this.options.getTask(params.targetId);
    const insertTask = this.options.getTask(params.taskId);
    if (!sourceTask || !targetTask || !insertTask) {
      return { ok: false, result: failure(ErrorCodes.DATA_NOT_FOUND, '找不到相关任务') };
    }

    if (targetTask.parentId !== params.sourceId) {
      return { ok: false, result: failure(ErrorCodes.VALIDATION_ERROR, '目标任务不是源任务的直接子节点') };
    }

    if (this.options.subtreeOps.wouldCreateCycle(
      params.taskId,
      params.sourceId,
      params.targetId,
      activeP.tasks,
    )) {
      return { ok: false, result: failure(ErrorCodes.LAYOUT_CYCLE_DETECTED, '操作会产生循环依赖') };
    }

    return { ok: true };
  }

  private insertTaskBetweenInProject(project: Project, params: InsertBetweenParams): Project {
    const { taskId, sourceId, targetId } = params;
    const tasks = project.tasks.map(task => ({ ...task }));
    const taskMap = new Map(tasks.map(task => [task.id, task] as const));
    const source = taskMap.get(sourceId)!;
    const target = taskMap.get(targetId)!;
    const newTask = taskMap.get(taskId)!;
    const targetSubtreeIds = this.options.subtreeOps.collectSubtreeIds(targetId, tasks);

    const newTaskStage = (source.stage || 1) + 1;
    newTask.parentId = sourceId;
    newTask.stage = newTaskStage;
    target.parentId = taskId;

    targetSubtreeIds.forEach(id => {
      const task = taskMap.get(id);
      if (task && task.stage !== null) {
        task.stage += 1;
      }
    });

    newTask.rank = target.rank;
    target.rank = newTask.rank + LAYOUT_CONFIG.RANK_STEP / 2;
    return this.options.layoutService.rebalance({ ...project, tasks });
  }

  private applyTaskPosition(project: Project, params: InsertBetweenAtPositionParams): Project {
    const now = new Date().toISOString();
    return {
      ...project,
      tasks: project.tasks.map(task =>
        task.id === params.taskId
          ? { ...task, x: params.x, y: params.y, updatedAt: now }
          : task
      ),
    };
  }

  private reorderStageInProject(project: Project, stage: number, orderedIds: string[]): Project {
    const tasks = project.tasks.map(task => ({ ...task }));
    let cursorRank = tasks
      .filter(task => task.stage === stage)
      .sort((left, right) => left.rank - right.rank)[0]?.rank
      ?? this.options.layoutService.stageBase(stage);

    orderedIds.forEach(id => {
      const task = tasks.find(candidate => candidate.id === id && candidate.stage === stage);
      if (!task) return;

      const parentRank = this.options.layoutService.maxParentRank(task, tasks);
      const minChildRank = this.options.layoutService.minChildRank(task.id, tasks);
      const placed = this.options.applyRefusalStrategy(
        task,
        cursorRank,
        parentRank,
        minChildRank,
        tasks,
      );
      if (!placed.ok) return;

      task.rank = placed.rank;
      cursorRank = placed.rank + LAYOUT_CONFIG.RANK_STEP;
    });

    return this.options.layoutService.rebalance({ ...project, tasks });
  }
}
