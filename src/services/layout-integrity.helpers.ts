import { LAYOUT_CONFIG } from '../config';
import type { Connection, Project, Task } from '../models';

interface LayoutIntegrityOptions {
  stageBase(stage: number): number;
  warn(message: string, context?: unknown): void;
}

export function fixOrphanedTasks(
  tasks: Task[],
  warn: LayoutIntegrityOptions['warn'],
): { tasks: Task[]; fixed: number } {
  const taskIds = new Set(tasks.map(t => t.id));
  let fixedCount = 0;

  const fixedTasks = tasks.map(t => {
    if (t.parentId && !taskIds.has(t.parentId)) {
      warn('Found orphaned task, resetting parent', { taskId: t.id, invalidParentId: t.parentId });
      fixedCount++;
      return {
        ...t,
        parentId: null,
        stage: t.stage ?? 1,
        displayId: '?',
      };
    }
    return t;
  });

  return { tasks: fixedTasks, fixed: fixedCount };
}

export function validateAndFixTree(
  project: Project,
  options: LayoutIntegrityOptions,
): { project: Project; issues: string[] } {
  const issues: string[] = [];
  let tasks = [...project.tasks];

  const orphanResult = fixOrphanedTasks(tasks, options.warn);
  tasks = orphanResult.tasks;
  if (orphanResult.fixed > 0) {
    issues.push(`修复了 ${orphanResult.fixed} 个孤儿任务`);
  }

  const cycleResult = detectAndFixCycles(tasks, options.warn);
  tasks = cycleResult.tasks;
  if (cycleResult.fixed > 0) {
    issues.push(`修复了 ${cycleResult.fixed} 个循环依赖`);
  }

  const rankResult = validateRanks(tasks, options);
  tasks = rankResult.tasks;
  if (rankResult.fixed > 0) {
    issues.push(`修复了 ${rankResult.fixed} 个无效 rank 值`);
  }

  const connections = validateConnections(project.connections, tasks);
  if (connections.removed > 0) {
    issues.push(`移除了 ${connections.removed} 个无效连接`);
  }

  return {
    project: {
      ...project,
      tasks,
      connections: connections.valid,
    },
    issues,
  };
}

function detectAndFixCycles(
  tasks: Task[],
  warn: LayoutIntegrityOptions['warn'],
): { tasks: Task[]; fixed: number } {
  const result = tasks.map(t => ({ ...t }));
  const resultMap = new Map(result.map(t => [t.id, t] as const));
  let fixedCount = 0;
  const confirmed = new Set<string>();

  for (const task of result) {
    if (!task.parentId || confirmed.has(task.id)) continue;

    const path = new Set<string>();
    let current: string | null = task.id;
    let foundCycle = false;

    while (current) {
      if (confirmed.has(current)) break;
      if (path.has(current)) {
        foundCycle = true;
        break;
      }
      path.add(current);
      const currentTask = resultMap.get(current);
      current = currentTask?.parentId ?? null;
    }

    if (foundCycle) {
      warn('Detected cycle, breaking at', { taskId: task.id, parentId: task.parentId });
      task.parentId = null;
      task.stage = 1;
      task.displayId = '?';
      fixedCount++;
    } else {
      path.forEach(id => confirmed.add(id));
    }
  }

  return { tasks: result, fixed: fixedCount };
}

function validateRanks(
  tasks: Task[],
  options: LayoutIntegrityOptions,
): { tasks: Task[]; fixed: number } {
  const result = tasks.map(t => ({ ...t }));
  let fixedCount = 0;

  for (const task of result) {
    if (!Number.isFinite(task.rank)) {
      task.rank = buildFallbackRank(task, options.stageBase);
      fixedCount++;
      options.warn('Fixed invalid rank', { taskId: task.id, newRank: task.rank });
    }

    if (task.rank < 0 || task.rank > 1000000000) {
      task.rank = buildFallbackRank(task, options.stageBase);
      fixedCount++;
    }
  }

  return { tasks: result, fixed: fixedCount };
}

function buildFallbackRank(task: Task, stageBase: (stage: number) => number): number {
  const base = task.stage ? stageBase(task.stage) : LAYOUT_CONFIG.RANK_ROOT_BASE;
  return base + (task.order || 0) * LAYOUT_CONFIG.RANK_STEP;
}

function validateConnections(
  connections: Connection[],
  tasks: Task[],
): { valid: Connection[]; removed: number } {
  const taskIds = new Set(tasks.map(t => t.id));
  const valid: Connection[] = [];
  let removed = 0;

  for (const conn of connections) {
    if (taskIds.has(conn.source) && taskIds.has(conn.target) && conn.source !== conn.target) {
      valid.push(conn);
    } else {
      removed++;
    }
  }

  return { valid, removed };
}
