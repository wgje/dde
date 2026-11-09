import type { Connection, Task } from '../models';
import type { InvariantCheckResult, InvariantSeverity } from './flow-logic-export';

export interface InvariantInput {
  readonly tasks: readonly Task[];
  readonly crossTreeConnections: readonly Connection[];
  readonly orphanConnections: readonly Connection[];
  readonly duplicateParentChildConnections: readonly Connection[];
  readonly cycles: readonly (readonly string[])[];
  readonly maxDepth: number;
  readonly actualMaxDepth: number;
  readonly depthExceeded: boolean;
}

interface InvariantDescriptor {
  readonly code: string;
  readonly severity: InvariantSeverity;
  readonly message: string;
}

export function checkInvariants(input: InvariantInput): InvariantCheckResult[] {
  const taskMap = new Map(input.tasks.map(t => [t.id, t] as const));
  const results: InvariantCheckResult[] = [];
  appendOffenderInvariant(results, {
    offenders: findStageContinuityOffenders(input.tasks, taskMap),
    code: 'STAGE_CONTINUITY',
    severity: 'error',
    message: 'child.stage 必须等于 parent.stage + 1，或两者同为 null',
  });
  appendOffenderInvariant(results, {
    offenders: findFloatingParentOffenders(input.tasks, taskMap),
    code: 'FLOATING_AS_ASSIGNED_PARENT',
    severity: 'error',
    message: '待分配任务不能作为已分配任务的父节点',
  });
  appendOffenderInvariant(results, {
    offenders: findParkingStatusOffenders(input.tasks),
    code: 'PARKING_STATUS',
    severity: 'warning',
    message: 'parkingMeta 非空时要求 status === "active"',
  });
  appendConnectionInvariant(results, input.orphanConnections, {
    code: 'ORPHAN_CONNECTIONS',
    severity: 'error',
    message: 'connection.source/target 指向的 task 不存在（已归档/软删/脏数据）',
  });
  appendConnectionInvariant(results, input.duplicateParentChildConnections, {
    code: 'DUPLICATE_PARENT_CHILD_EDGE',
    severity: 'warning',
    message: 'connections 含与 parentId 重复的历史父子边，建议清理',
  });
  appendCycleInvariant(results, input.cycles);
  appendDepthInvariant(results, input);
  appendOffenderInvariant(results, {
    offenders: findSelfLoopConnections(input.crossTreeConnections),
    code: 'SELF_LOOP_CONNECTION',
    severity: 'error',
    message: 'connection.source === connection.target（自环）',
  });
  return results;
}

function appendOffenderInvariant(
  results: InvariantCheckResult[],
  descriptor: InvariantDescriptor & { readonly offenders: readonly string[] },
): void {
  if (descriptor.offenders.length === 0) return;
  results.push({
    code: descriptor.code,
    severity: descriptor.severity,
    message: descriptor.message,
    offenders: descriptor.offenders,
  });
}

function appendConnectionInvariant(
  results: InvariantCheckResult[],
  connections: readonly Connection[],
  descriptor: InvariantDescriptor,
): void {
  appendOffenderInvariant(results, {
    ...descriptor,
    offenders: connections.map(connection => connection.id),
  });
}

function findStageContinuityOffenders(
  tasks: readonly Task[],
  taskMap: ReadonlyMap<string, Task>,
): string[] {
  const stageOffenders: string[] = [];
  for (const task of tasks) {
    if (!task.parentId) continue;
    const parent = taskMap.get(task.parentId);
    if (!parent) continue;
    const parentStage = parent.stage;
    const childStage = task.stage;
    if (parentStage === null && childStage !== null) {
      stageOffenders.push(task.id);
      continue;
    }
    if (parentStage !== null && childStage === null) {
      stageOffenders.push(task.id);
      continue;
    }
    if (parentStage !== null && childStage !== null && childStage !== parentStage + 1) {
      stageOffenders.push(task.id);
    }
  }
  return stageOffenders;
}

function findFloatingParentOffenders(
  tasks: readonly Task[],
  taskMap: ReadonlyMap<string, Task>,
): string[] {
  const floatingParentOffenders: string[] = [];
  for (const task of tasks) {
    if (!task.parentId) continue;
    const parent = taskMap.get(task.parentId);
    if (!parent) continue;
    if (parent.stage === null && task.stage !== null) {
      floatingParentOffenders.push(task.id);
    }
  }
  return floatingParentOffenders;
}

function findParkingStatusOffenders(tasks: readonly Task[]): string[] {
  const parkingOffenders: string[] = [];
  for (const task of tasks) {
    if (task.parkingMeta && task.status !== 'active') {
      parkingOffenders.push(task.id);
    }
  }
  return parkingOffenders;
}

function appendCycleInvariant(
  results: InvariantCheckResult[],
  cycles: readonly (readonly string[])[],
): void {
  if (cycles.length > 0) {
    results.push({
      code: 'CROSS_TREE_CYCLE',
      severity: 'error',
      message: '任务图存在有向环，可能导致依赖推理死锁',
      offenders: cycles.map(c => c.join('->')),
    });
  }
}

function appendDepthInvariant(results: InvariantCheckResult[], input: InvariantInput): void {
  if (input.depthExceeded) {
    results.push({
      code: 'TREE_DEPTH_EXCEEDED',
      severity: 'error',
      message: `任务树深度至少为 ${input.maxDepth + 1}，超过上限 ${input.maxDepth}`,
      offenders: [],
    });
  }
}

function findSelfLoopConnections(crossTreeConnections: readonly Connection[]): string[] {
  const crossTreeSelfLoop: string[] = [];
  for (const connection of crossTreeConnections) {
    if (connection.source === connection.target) crossTreeSelfLoop.push(connection.id);
  }
  return crossTreeSelfLoop;
}
