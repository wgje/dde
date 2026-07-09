import { describe, expect, it, vi } from 'vitest';

import type { Project, Task } from '../models';
import { success } from '../utils/result';
import { TaskMoveAssignmentController } from './task-move-assignment.controller';

function createTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? crypto.randomUUID(),
    title: overrides.title ?? 'T',
    content: overrides.content ?? '',
    stage: 'stage' in overrides ? (overrides.stage as number | null) : 1,
    parentId: overrides.parentId ?? null,
    order: overrides.order ?? 1,
    rank: overrides.rank ?? 1000,
    status: overrides.status ?? 'active',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    createdDate: overrides.createdDate ?? now,
    updatedAt: overrides.updatedAt ?? now,
    displayId: overrides.displayId ?? '?',
  };
}

function createProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? 'p1',
    name: overrides.name ?? 'P',
    description: overrides.description ?? '',
    createdDate: overrides.createdDate ?? new Date().toISOString(),
    tasks: overrides.tasks ?? [],
    connections: overrides.connections ?? [],
    updatedAt: overrides.updatedAt,
    version: overrides.version,
    viewState: overrides.viewState,
    flowchartUrl: overrides.flowchartUrl,
    flowchartThumbnailUrl: overrides.flowchartThumbnailUrl,
  };
}

function createController(activeProject: Project | null) {
  const projectRef = { current: activeProject };
  const recordAndUpdate = vi.fn((mutator: (project: Project) => Project) => {
    if (projectRef.current) {
      projectRef.current = mutator(projectRef.current);
    }
  });
  const recordAndUpdateDurably = vi.fn(async (mutator: (project: Project) => Project) => {
    if (projectRef.current) {
      projectRef.current = mutator(projectRef.current);
    }
    return true;
  });
  const subtreeOps = {
    assignSubtreeToStage: vi.fn(),
    collectSubtreeIds: vi.fn().mockReturnValue(new Set(['target'])),
    detachChildrenAsUnassigned: vi.fn().mockReturnValue(null),
    fixSubtreeRanks: vi.fn(),
    validateStageCapacity: vi.fn().mockReturnValue(success(undefined)),
  };
  const controller = new TaskMoveAssignmentController({
    applyRefusalStrategy: vi.fn().mockReturnValue({ ok: true, rank: 1500 }),
    computeInsertRank: vi.fn().mockReturnValue(1500),
    getActiveProject: () => projectRef.current,
    getTask: taskId => projectRef.current?.tasks.find(task => task.id === taskId),
    layoutService: { rebalance: vi.fn((project: Project) => project) },
    localPersistenceFailure: vi.fn(),
    recordAndUpdate,
    recordAndUpdateDurably,
    subtreeOps,
  });

  return { controller, projectRef, recordAndUpdate, recordAndUpdateDurably, subtreeOps };
}

describe('TaskMoveAssignmentController', () => {
  it('assigns an unassigned block through the durable local mutation path', async () => {
    const project = createProject({
      tasks: [
        createTask({ id: 'source', stage: 1, rank: 1000 }),
        createTask({ id: 'target', stage: null }),
      ],
    });
    const { controller, recordAndUpdate, recordAndUpdateDurably, subtreeOps } = createController(project);

    const result = await controller.assignUnassignedToTask('source', 'target');

    expect(result.ok).toBe(true);
    expect(recordAndUpdateDurably).toHaveBeenCalledWith(expect.any(Function));
    expect(recordAndUpdate).not.toHaveBeenCalled();
    expect(subtreeOps.assignSubtreeToStage).toHaveBeenCalledWith(
      'target',
      'source',
      2,
      expect.any(Array),
    );
  });

  it('rejects assignment from an unassigned source without mutating the project', async () => {
    const project = createProject({
      tasks: [
        createTask({ id: 'source', stage: null }),
        createTask({ id: 'target', stage: null }),
      ],
    });
    const { controller, recordAndUpdate, subtreeOps } = createController(project);

    const result = await controller.assignUnassignedToTask('source', 'target');

    expect(result.ok).toBe(false);
    expect(recordAndUpdate).not.toHaveBeenCalled();
    expect(subtreeOps.validateStageCapacity).not.toHaveBeenCalled();
  });
});
