import type { Project, Task } from '../models';
import { ErrorCodes, failure, type OperationError, type Result, success } from '../utils/result';

export interface ValidateUnassignedStageParentInput {
  newParentId: string | null | undefined;
  newStage: number;
  getTask: (taskId: string) => Task | null | undefined;
}

export interface ResolveAssignedMoveParentIdInput {
  currentParentId: string | null | undefined;
  newParentId: string | null | undefined;
  newStage: number;
  getTask: (taskId: string) => Task | null | undefined;
}

export interface ResolveAssignedMoveParentIdResult {
  parentId: string | null;
  cleared: boolean;
}

export interface SelectReplacementChildrenToDetachInput {
  tasks: Task[];
  sourceTaskId: string;
  specificChildId?: string | undefined;
}

export interface ValidateAssignedSourceAndUnassignedTargetInput {
  sourceTask?: Task | null;
  targetTask?: Task | null;
  sourceMissingMessage: string;
  targetMissingMessage: string;
  sourceUnassignedMessage: string;
  targetAssignedMessage: string;
}

export interface AssignUnassignedSubtreeInProjectInput {
  project: Project;
  taskId: string;
  targetStage: number;
  newParentId: string | null;
  beforeTaskId: string | null;
  maxDepth: number;
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
  fixSubtreeRanks: (taskId: string, tasks: Task[]) => void;
  rebalance: (project: Project) => Project;
  setResult: (result: Result<void, OperationError>) => void;
}

export interface AssignUnassignedToTaskInProjectInput {
  project: Project;
  sourceTaskId: string;
  targetUnassignedId: string;
  targetStage: number;
  assignSubtreeToStage: (
    targetId: string,
    sourceTaskId: string,
    targetStage: number,
    tasks: Task[],
  ) => void;
  collectSubtreeIds: (taskId: string, tasks: Task[]) => Set<string>;
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
  fixSubtreeRanks: (taskId: string, tasks: Task[]) => void;
  rebalance: (project: Project) => Project;
  setResult: (result: Result<void, OperationError>) => void;
}

export interface ReplaceChildSubtreeInProjectInput {
  project: Project;
  sourceTaskId: string;
  targetUnassignedId: string;
  targetStage: number;
  specificChildId?: string | undefined;
  assignSubtreeToStage: (
    targetId: string,
    sourceTaskId: string,
    targetStage: number,
    tasks: Task[],
  ) => void;
  collectSubtreeIds: (taskId: string, tasks: Task[]) => Set<string>;
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
  fixSubtreeRanks: (taskId: string, tasks: Task[]) => void;
  detachChildrenAsUnassigned: (children: Task[], tasks: Task[]) => string | null;
  rebalance: (project: Project) => Project;
  setResult: (result: Result<{ detachedSubtreeRootId: string | null }, OperationError>) => void;
}

export function validateUnassignedStageParent(
  input: ValidateUnassignedStageParentInput,
): Result<void, OperationError> {
  if (!input.newParentId) {
    return success(undefined);
  }

  const newParent = input.getTask(input.newParentId);
  if (!newParent || newParent.stage === null) {
    return failure(
      ErrorCodes.CROSS_BOUNDARY_VIOLATION,
      '新父任务必须已分配到阶段中',
    );
  }

  if (newParent.stage !== input.newStage - 1) {
    return failure(
      ErrorCodes.CROSS_BOUNDARY_VIOLATION,
      '子任务必须在父任务的下一阶段',
      { parentStage: newParent.stage, targetStage: input.newStage },
    );
  }

  return success(undefined);
}

export function resolveAssignedMoveParentId(
  input: ResolveAssignedMoveParentIdInput,
): ResolveAssignedMoveParentIdResult {
  if (input.newParentId !== undefined) {
    return { parentId: input.newParentId, cleared: false };
  }

  if (!input.currentParentId) {
    return { parentId: null, cleared: false };
  }

  const parent = input.getTask(input.currentParentId);
  if (!parent || parent.stage !== input.newStage - 1) {
    return { parentId: null, cleared: true };
  }

  return { parentId: input.currentParentId, cleared: false };
}

export function selectReplacementChildrenToDetach(
  input: SelectReplacementChildrenToDetachInput,
): Task[] {
  const directChildren = input.tasks.filter(t => t.parentId === input.sourceTaskId && !t.deletedAt);
  if (!input.specificChildId) {
    return directChildren;
  }

  return directChildren.filter(t => t.id === input.specificChildId);
}

export function validateAssignedSourceAndUnassignedTarget(
  input: ValidateAssignedSourceAndUnassignedTargetInput,
): Result<void, OperationError> {
  if (!input.sourceTask) {
    return failure(ErrorCodes.DATA_NOT_FOUND, input.sourceMissingMessage);
  }
  if (!input.targetTask) {
    return failure(ErrorCodes.DATA_NOT_FOUND, input.targetMissingMessage);
  }
  if (input.sourceTask.stage === null) {
    return failure(ErrorCodes.VALIDATION_ERROR, input.sourceUnassignedMessage);
  }
  if (input.targetTask.stage !== null) {
    return failure(ErrorCodes.VALIDATION_ERROR, input.targetAssignedMessage);
  }
  return success(undefined);
}

export function assignUnassignedSubtreeInProject(
  input: AssignUnassignedSubtreeInProjectInput,
): Project {
  const tasks = input.project.tasks.map(task => ({ ...task }));
  const taskMap = new Map(tasks.map(task => [task.id, task] as const));
  const root = taskMap.get(input.taskId);
  if (!root) {
    input.setResult(failure(ErrorCodes.DATA_NOT_FOUND, '任务不存在'));
    return input.project;
  }

  assignSubtreeStages(root, tasks, input.targetStage, input.newParentId, input.maxDepth);

  const stageTasks = tasks.filter(task => task.stage === input.targetStage && task.id !== input.taskId);
  const parent = input.newParentId ? taskMap.get(input.newParentId) : null;
  const candidateRank = input.computeInsertRank(
    input.targetStage,
    stageTasks,
    input.beforeTaskId,
    parent?.rank ?? null,
  );
  const placed = input.applyRefusalStrategy(root, candidateRank, parent?.rank ?? 0, Infinity, tasks);
  if (!placed.ok) {
    input.setResult(failure(ErrorCodes.LAYOUT_NO_SPACE, '无法在该位置放置任务'));
    return input.project;
  }

  root.rank = placed.rank;
  input.fixSubtreeRanks(input.taskId, tasks);

  return input.rebalance({ ...input.project, tasks });
}

export function assignUnassignedToTaskInProject(
  input: AssignUnassignedToTaskInProjectInput,
): Project {
  const tasks = input.project.tasks.map(task => ({ ...task }));
  const taskMap = new Map(tasks.map(task => [task.id, task] as const));
  const source = taskMap.get(input.sourceTaskId)!;
  const target = taskMap.get(input.targetUnassignedId)!;

  input.assignSubtreeToStage(
    input.targetUnassignedId,
    input.sourceTaskId,
    input.targetStage,
    tasks,
  );

  const targetSubtreeIds = input.collectSubtreeIds(input.targetUnassignedId, tasks);
  const stageTasks = tasks.filter(
    task => task.stage === input.targetStage
      && task.id !== input.targetUnassignedId
      && !targetSubtreeIds.has(task.id),
  );
  const candidateRank = input.computeInsertRank(
    input.targetStage,
    stageTasks,
    null,
    source.rank,
  );
  const placed = input.applyRefusalStrategy(target, candidateRank, source.rank, Infinity, tasks);
  if (!placed.ok) {
    input.setResult(failure(ErrorCodes.LAYOUT_NO_SPACE, '无法在该位置放置任务'));
    return input.project;
  }

  target.rank = placed.rank;
  input.fixSubtreeRanks(input.targetUnassignedId, tasks);
  return input.rebalance({ ...input.project, tasks });
}

export function replaceChildSubtreeInProject(
  input: ReplaceChildSubtreeInProjectInput,
): Project {
  const tasks = input.project.tasks.map(task => ({ ...task }));
  const taskMap = new Map(tasks.map(task => [task.id, task] as const));
  const source = taskMap.get(input.sourceTaskId)!;
  const target = taskMap.get(input.targetUnassignedId)!;
  const childrenToDetach = selectReplacementChildrenToDetach({
    tasks,
    sourceTaskId: input.sourceTaskId,
    specificChildId: input.specificChildId,
  });

  input.assignSubtreeToStage(
    input.targetUnassignedId,
    input.sourceTaskId,
    input.targetStage,
    tasks,
  );

  const targetSubtreeIds = input.collectSubtreeIds(input.targetUnassignedId, tasks);
  const stageTasks = tasks.filter(
    task => task.stage === input.targetStage
      && task.id !== input.targetUnassignedId
      && !targetSubtreeIds.has(task.id),
  );
  const candidateRank = input.computeInsertRank(input.targetStage, stageTasks, null, source.rank);
  const placed = input.applyRefusalStrategy(target, candidateRank, source.rank, Infinity, tasks);
  if (!placed.ok) {
    input.setResult(failure(ErrorCodes.LAYOUT_NO_SPACE, '无法在该位置放置任务'));
    return input.project;
  }
  target.rank = placed.rank;

  input.fixSubtreeRanks(input.targetUnassignedId, tasks);

  const detachedRootId = childrenToDetach.length > 0
    ? input.detachChildrenAsUnassigned(childrenToDetach, tasks)
    : null;
  input.setResult(success({ detachedSubtreeRootId: detachedRootId }));

  return input.rebalance({ ...input.project, tasks });
}

function assignSubtreeStages(
  root: Task,
  tasks: Task[],
  targetStage: number,
  newParentId: string | null,
  maxDepth: number,
): void {
  const now = new Date().toISOString();
  const queue: { task: Task; depth: number }[] = [{ task: root, depth: 0 }];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const { task, depth } = queue.shift()!;
    if (visited.has(task.id)) continue;
    visited.add(task.id);

    task.stage = targetStage + depth;
    task.updatedAt = now;
    if (depth === 0) {
      task.parentId = newParentId;
    }

    if (depth < maxDepth) {
      tasks
        .filter(candidate => candidate.parentId === task.id && !candidate.deletedAt)
        .forEach(child => queue.push({ task: child, depth: depth + 1 }));
    }
  }
}
