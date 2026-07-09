import type { Project, Task } from '../models';
import { ErrorCodes, failure, type OperationError, type Result, success } from '../utils/result';
import {
  assignUnassignedToTaskInProject,
  replaceChildSubtreeInProject,
  validateAssignedSourceAndUnassignedTarget,
} from './task-move.helpers';

export interface TaskMoveAssignmentControllerOptions {
  getActiveProject: () => Project | null;
  getTask: (taskId: string) => Task | null | undefined;
  layoutService: {
    rebalance(project: Project): Project;
  };
  localPersistenceFailure: (context: Record<string, unknown>) => Result<void, OperationError>;
  recordAndUpdate: (mutator: (project: Project) => Project) => void;
  recordAndUpdateDurably: (mutator: (project: Project) => Project) => Promise<boolean>;
  subtreeOps: {
    assignSubtreeToStage(
      targetId: string,
      sourceTaskId: string,
      targetStage: number,
      tasks: Task[],
    ): void;
    collectSubtreeIds(taskId: string, tasks: Task[]): Set<string>;
    detachChildrenAsUnassigned(children: Task[], tasks: Task[]): string | null;
    fixSubtreeRanks(taskId: string, tasks: Task[]): void;
    validateStageCapacity(
      taskId: string,
      targetStage: number,
      tasks: Task[],
    ): Result<void, OperationError>;
  };
  computeInsertRank: (
    stage: number,
    siblings: Task[],
    beforeId?: string | null,
    parentRank?: number | null,
  ) => number;
  applyRefusalStrategy: (
    task: Task,
    candidateRank: number,
    parentRank: number,
    minChildRank: number,
    tasks: Task[],
  ) => { ok: boolean; rank: number };
}

export class TaskMoveAssignmentController {
  constructor(private readonly options: TaskMoveAssignmentControllerOptions) {}

  replaceChildSubtreeWithUnassigned(
    sourceTaskId: string,
    targetUnassignedId: string,
    specificChildId?: string,
  ): Promise<Result<{ detachedSubtreeRootId: string | null }, OperationError>> {
    return this.replaceChildSubtreeWithUnassignedDurably(
      sourceTaskId,
      targetUnassignedId,
      specificChildId,
    );
  }

  async replaceChildSubtreeWithUnassignedDurably(
    sourceTaskId: string,
    targetUnassignedId: string,
    specificChildId?: string,
  ): Promise<Result<{ detachedSubtreeRootId: string | null }, OperationError>> {
    const validation = this.validateAssignment(sourceTaskId, targetUnassignedId);
    if (!validation.ok) return validation.result;

    let operationResult: Result<{ detachedSubtreeRootId: string | null }, OperationError> =
      success({ detachedSubtreeRootId: null });
    const saved = await this.options.recordAndUpdateDurably(project => this.replaceChildSubtreeInProject(
      project,
      {
        sourceTaskId,
        targetUnassignedId,
        targetStage: validation.targetStage,
        specificChildId,
      },
      result => { operationResult = result; },
    ));

    if (!saved) {
      return failure(ErrorCodes.OPERATION_FAILED, '任务本地持久化失败，未提交 UI 更新', {
        sourceTaskId,
        targetUnassignedId,
      });
    }

    return operationResult;
  }

  assignUnassignedToTask(
    sourceTaskId: string,
    targetUnassignedId: string,
  ): Promise<Result<void, OperationError>> {
    return this.assignUnassignedToTaskDurably(sourceTaskId, targetUnassignedId);
  }

  async assignUnassignedToTaskDurably(
    sourceTaskId: string,
    targetUnassignedId: string,
  ): Promise<Result<void, OperationError>> {
    const validation = this.validateAssignment(sourceTaskId, targetUnassignedId);
    if (!validation.ok) return validation.result;

    let operationResult: Result<void, OperationError> = success(undefined);
    const saved = await this.options.recordAndUpdateDurably(project => this.assignUnassignedToTaskInProject(
      project,
      sourceTaskId,
      targetUnassignedId,
      validation.targetStage,
      result => { operationResult = result; },
    ));

    if (!saved) {
      return this.options.localPersistenceFailure({ sourceTaskId, targetUnassignedId });
    }

    return operationResult;
  }

  private validateAssignment(
    sourceTaskId: string,
    targetUnassignedId: string,
  ):
    | { ok: true; targetStage: number }
    | { ok: false; result: Result<never, OperationError> } {
    const activeP = this.options.getActiveProject();
    if (!activeP) {
      return { ok: false, result: failure(ErrorCodes.DATA_NOT_FOUND, '没有活动项目') };
    }

    const sourceTask = this.options.getTask(sourceTaskId);
    const targetTask = this.options.getTask(targetUnassignedId);
    const assignmentCheck = validateAssignedSourceAndUnassignedTarget({
      sourceTask,
      targetTask,
      sourceMissingMessage: '源任务不存在',
      targetMissingMessage: '目标待分配块不存在',
      sourceUnassignedMessage: '源任务必须是已分配的任务块',
      targetAssignedMessage: '目标必须是待分配块',
    });
    if (!assignmentCheck.ok) {
      return { ok: false, result: assignmentCheck };
    }

    const sourceStage = sourceTask?.stage;
    if (sourceStage === null || sourceStage === undefined) {
      return {
        ok: false,
        result: failure(ErrorCodes.VALIDATION_ERROR, '源任务必须是已分配的任务块'),
      };
    }
    const targetStage = sourceStage + 1;
    const capacityCheck = this.options.subtreeOps.validateStageCapacity(
      targetUnassignedId,
      targetStage,
      activeP.tasks,
    );
    if (!capacityCheck.ok) {
      return { ok: false, result: capacityCheck };
    }

    return { ok: true, targetStage };
  }

  private replaceChildSubtreeInProject(
    project: Project,
    params: {
      sourceTaskId: string;
      targetUnassignedId: string;
      targetStage: number;
      specificChildId: string | undefined;
    },
    setResult: (result: Result<{ detachedSubtreeRootId: string | null }, OperationError>) => void,
  ): Project {
    return replaceChildSubtreeInProject({
      applyRefusalStrategy: this.options.applyRefusalStrategy,
      assignSubtreeToStage: (targetId, sourceId, stage, tasks) =>
        this.options.subtreeOps.assignSubtreeToStage(targetId, sourceId, stage, tasks),
      collectSubtreeIds: (taskId, tasks) => this.options.subtreeOps.collectSubtreeIds(taskId, tasks),
      computeInsertRank: this.options.computeInsertRank,
      detachChildrenAsUnassigned: (children, tasks) =>
        this.options.subtreeOps.detachChildrenAsUnassigned(children, tasks),
      fixSubtreeRanks: (taskId, tasks) => this.options.subtreeOps.fixSubtreeRanks(taskId, tasks),
      project,
      rebalance: nextProject => this.options.layoutService.rebalance(nextProject),
      setResult,
      ...params,
    });
  }

  private assignUnassignedToTaskInProject(
    project: Project,
    sourceTaskId: string,
    targetUnassignedId: string,
    targetStage: number,
    setResult: (result: Result<void, OperationError>) => void,
  ): Project {
    return assignUnassignedToTaskInProject({
      applyRefusalStrategy: this.options.applyRefusalStrategy,
      assignSubtreeToStage: (targetId, sourceId, stage, tasks) =>
        this.options.subtreeOps.assignSubtreeToStage(targetId, sourceId, stage, tasks),
      collectSubtreeIds: (taskId, tasks) => this.options.subtreeOps.collectSubtreeIds(taskId, tasks),
      computeInsertRank: this.options.computeInsertRank,
      fixSubtreeRanks: (taskId, tasks) => this.options.subtreeOps.fixSubtreeRanks(taskId, tasks),
      project,
      rebalance: nextProject => this.options.layoutService.rebalance(nextProject),
      setResult,
      sourceTaskId,
      targetStage,
      targetUnassignedId,
    });
  }
}
