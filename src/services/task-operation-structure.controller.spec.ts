import { describe, expect, it, vi } from 'vitest';

import type { Project, Task } from '../models';
import { TaskOperationStructureController } from './task-operation-structure.controller';

function createTask(overrides: Partial<Task>): Task {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? crypto.randomUUID(),
    title: overrides.title ?? 'T',
    content: overrides.content ?? '',
    stage: overrides.stage ?? 1,
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

function createProject(tasks: Task[]): Project {
  return {
    id: 'p1',
    name: 'P',
    description: '',
    createdDate: new Date().toISOString(),
    tasks,
    connections: [],
  };
}

function createController(project: Project) {
  const projectRef = { current: project };
  const recordAndUpdate = vi.fn((mutator: (project: Project) => Project) => {
    projectRef.current = mutator(projectRef.current);
  });
  const recordAndUpdateDurably = vi.fn(async (mutator: (project: Project) => Project) => {
    projectRef.current = mutator(projectRef.current);
    return true;
  });
  const controller = new TaskOperationStructureController({
    applyRefusalStrategy: vi.fn((_task, candidateRank: number) => ({
      ok: true,
      rank: candidateRank,
    })),
    getActiveProject: () => projectRef.current,
    getTask: taskId => projectRef.current.tasks.find(task => task.id === taskId),
    layoutService: {
      maxParentRank: vi.fn().mockReturnValue(0),
      minChildRank: vi.fn().mockReturnValue(Infinity),
      rebalance: vi.fn((nextProject: Project) => nextProject),
      stageBase: vi.fn().mockReturnValue(1000),
    },
    recordAndUpdate,
    recordAndUpdateDurably,
    subtreeOps: {
      collectSubtreeIds: vi.fn().mockReturnValue(new Set(['target'])),
      wouldCreateCycle: vi.fn().mockReturnValue(false),
    },
  });

  return { controller, projectRef, recordAndUpdate, recordAndUpdateDurably };
}

describe('TaskOperationStructureController', () => {
  it('default insertTaskBetween uses durable local persistence', async () => {
    const project = createProject([
      createTask({ id: 'source', stage: 1, parentId: null, rank: 1000 }),
      createTask({ id: 'target', stage: 2, parentId: 'source', rank: 2000 }),
      createTask({ id: 'inserted', stage: null, parentId: null, rank: 3000 }),
    ]);
    const { controller, projectRef, recordAndUpdate, recordAndUpdateDurably } = createController(project);

    const result = await controller.insertTaskBetween({
      taskId: 'inserted',
      sourceId: 'source',
      targetId: 'target',
    });

    expect(result.ok).toBe(true);
    expect(recordAndUpdateDurably).toHaveBeenCalledTimes(1);
    expect(recordAndUpdate).not.toHaveBeenCalled();
    expect(projectRef.current.tasks.find(task => task.id === 'inserted')?.parentId).toBe('source');
    expect(projectRef.current.tasks.find(task => task.id === 'target')?.parentId).toBe('inserted');
  });

  it('durably inserts a task between source and target', async () => {
    const project = createProject([
      createTask({ id: 'source', stage: 1, parentId: null, rank: 1000 }),
      createTask({ id: 'target', stage: 2, parentId: 'source', rank: 2000 }),
      createTask({ id: 'inserted', stage: null, parentId: null, rank: 3000 }),
    ]);
    const { controller, projectRef, recordAndUpdateDurably } = createController(project);

    const result = await controller.insertTaskBetweenDurably({
      taskId: 'inserted',
      sourceId: 'source',
      targetId: 'target',
    });

    expect(result.ok).toBe(true);
    expect(recordAndUpdateDurably).toHaveBeenCalledTimes(1);
    expect(projectRef.current.tasks.find(task => task.id === 'inserted')?.parentId).toBe('source');
    expect(projectRef.current.tasks.find(task => task.id === 'target')?.parentId).toBe('inserted');
  });

  it('durably inserts a task between source and target with its drop position in one commit', async () => {
    const project = createProject([
      createTask({ id: 'source', stage: 1, parentId: null, rank: 1000 }),
      createTask({ id: 'target', stage: 2, parentId: 'source', rank: 2000 }),
      createTask({ id: 'inserted', stage: null, parentId: null, rank: 3000, x: 0, y: 0 }),
    ]);
    const { controller, projectRef, recordAndUpdateDurably } = createController(project);

    const result = await controller.insertTaskBetweenAtPositionDurably({
      taskId: 'inserted',
      sourceId: 'source',
      targetId: 'target',
      x: 40,
      y: 60,
    });

    expect(result.ok).toBe(true);
    expect(recordAndUpdateDurably).toHaveBeenCalledTimes(1);
    expect(projectRef.current.tasks.find(task => task.id === 'inserted')).toMatchObject({
      parentId: 'source',
      stage: 2,
      rank: 2000,
      x: 40,
      y: 60,
    });
    expect(projectRef.current.tasks.find(task => task.id === 'target')?.parentId).toBe('inserted');
  });

  it('default reorderStage uses durable local persistence', async () => {
    const project = createProject([
      createTask({ id: 'first', stage: 1, rank: 1000 }),
      createTask({ id: 'second', stage: 1, rank: 2000 }),
    ]);
    const { controller, projectRef, recordAndUpdate, recordAndUpdateDurably } = createController(project);

    const saved = await controller.reorderStage(1, ['second', 'first']);

    expect(saved).toBe(true);
    expect(recordAndUpdateDurably).toHaveBeenCalledTimes(1);
    expect(recordAndUpdate).not.toHaveBeenCalled();
    expect(projectRef.current.tasks.find(task => task.id === 'second')?.rank).toBeLessThan(
      projectRef.current.tasks.find(task => task.id === 'first')!.rank,
    );
  });

  it('durably reorders stage tasks through the structure controller', async () => {
    const project = createProject([
      createTask({ id: 'first', stage: 1, rank: 1000 }),
      createTask({ id: 'second', stage: 1, rank: 2000 }),
    ]);
    const { controller, projectRef, recordAndUpdateDurably } = createController(project);

    const saved = await controller.reorderStageDurably(1, ['second', 'first']);

    expect(saved).toBe(true);
    expect(recordAndUpdateDurably).toHaveBeenCalledTimes(1);
    expect(projectRef.current.tasks.find(task => task.id === 'second')?.rank).toBeLessThan(
      projectRef.current.tasks.find(task => task.id === 'first')!.rank,
    );
  });
});
