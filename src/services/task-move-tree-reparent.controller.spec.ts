import { describe, expect, it, vi } from 'vitest';

import type { Connection, Project, Task } from '../models';
import { ErrorCodes, failure, success } from '../utils/result';
import {
  TaskMoveTreeReparentController,
  type TaskMoveTreeReparentControllerOptions,
} from './task-move-tree-reparent.controller';

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
    shortId: overrides.shortId,
    hasIncompleteTask: overrides.hasIncompleteTask,
    deletedAt: overrides.deletedAt,
    deletedConnections: overrides.deletedConnections,
    deletedMeta: overrides.deletedMeta,
    attachments: overrides.attachments,
    tags: overrides.tags,
    priority: overrides.priority,
    dueDate: overrides.dueDate,
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

function createController(project: Project) {
  let currentProject = project;
  const recordAndUpdate = vi.fn((mutator: (project: Project) => Project) => {
    currentProject = mutator(currentProject);
  });
  const recordAndUpdateDurably = vi.fn(async (mutator: (project: Project) => Project) => {
    currentProject = mutator(currentProject);
    return true;
  });
  const options: TaskMoveTreeReparentControllerOptions = {
    getActiveProject: () => currentProject,
    getTask: taskId => currentProject.tasks.find(task => task.id === taskId) ?? null,
    layoutService: {
      detectCycle: vi.fn().mockReturnValue(false),
      rebalance: vi.fn((nextProject: Project) => nextProject),
    },
    localPersistenceFailure: vi.fn(context =>
      failure(ErrorCodes.OPERATION_FAILED, '任务本地持久化失败，未提交 UI 更新', context)),
    recordAndUpdate,
    recordAndUpdateDurably,
    subtreeOps: {
      collectSubtreeIds: vi.fn().mockReturnValue(new Set(['child', 'leaf'])),
      computeNewRankForMigratedTask: vi.fn().mockReturnValue(9000),
      fixSubtreeRanks: vi.fn(),
      updateParentChildConnections: vi.fn().mockReturnValue([
        { id: 'new-link', source: 'new-parent', target: 'child' } satisfies Connection,
      ]),
      updateSubtreeStages: vi.fn((subtreeIds: Set<string>, stageOffset: number, tasks: Task[]) => {
        for (const task of tasks) {
          if (subtreeIds.has(task.id) && task.stage !== null) {
            task.stage += stageOffset;
          }
        }
      }),
    },
  };
  const controller = new TaskMoveTreeReparentController(options);

  return {
    controller,
    get currentProject() {
      return currentProject;
    },
    options,
  };
}

describe('TaskMoveTreeReparentController', () => {
  it('moves a subtree to a new parent through the durable shared project mutator', async () => {
    const project = createProject({
      tasks: [
        createTask({ id: 'old-parent', stage: 1, rank: 1000 }),
        createTask({ id: 'new-parent', stage: 3, rank: 3000 }),
        createTask({ id: 'child', stage: 2, parentId: 'old-parent', rank: 2000 }),
        createTask({ id: 'leaf', stage: 3, parentId: 'child', rank: 2100 }),
      ],
      connections: [{ id: 'old-link', source: 'old-parent', target: 'child' }],
    });
    const harness = createController(project);

    const result = await harness.controller.moveSubtreeToNewParent('child', 'new-parent');

    expect(result).toEqual(success(undefined));
    expect(harness.options.recordAndUpdateDurably).toHaveBeenCalledTimes(1);
    expect(harness.options.recordAndUpdate).not.toHaveBeenCalled();
    expect(harness.options.subtreeOps.updateSubtreeStages).toHaveBeenCalledWith(
      new Set(['child', 'leaf']),
      2,
      expect.any(Array),
    );
    expect(harness.options.subtreeOps.updateParentChildConnections).toHaveBeenCalledWith(
      'child',
      'old-parent',
      'new-parent',
      project.connections,
    );
    expect(harness.currentProject.tasks.find(task => task.id === 'child')).toMatchObject({
      parentId: 'new-parent',
      rank: 9000,
      stage: 4,
    });
    expect(harness.currentProject.tasks.find(task => task.id === 'leaf')).toMatchObject({
      parentId: 'child',
      stage: 5,
    });
    expect(harness.currentProject.connections).toEqual([
      { id: 'new-link', source: 'new-parent', target: 'child' },
    ]);
  });

  it('returns the local persistence failure when durable subtree reparenting cannot be saved', async () => {
    const project = createProject({
      tasks: [
        createTask({ id: 'new-parent', stage: 2, rank: 2000 }),
        createTask({ id: 'child', stage: 1, parentId: null, rank: 1000 }),
      ],
    });
    const { controller, options } = createController(project);
    options.recordAndUpdateDurably = vi.fn().mockResolvedValue(false);

    const result = await controller.moveSubtreeToNewParentDurably('child', 'new-parent');

    expect(result.ok).toBe(false);
    expect(options.localPersistenceFailure).toHaveBeenCalledWith({
      taskId: 'child',
      newParentId: 'new-parent',
    });
  });
});
