import { describe, expect, it, vi } from 'vitest';

import type { Project, Task } from '../models';
import {
  assignUnassignedSubtreeInProject,
  assignUnassignedToTaskInProject,
  resolveAssignedMoveParentId,
  selectReplacementChildrenToDetach,
  validateUnassignedStageParent,
} from './task-move.helpers';

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

describe('validateUnassignedStageParent', () => {
  it('allows assignment without a new parent', () => {
    const result = validateUnassignedStageParent({
      newParentId: null,
      newStage: 2,
      getTask: () => null,
    });

    expect(result.ok).toBe(true);
  });

  it('allows assigned parent from the previous stage', () => {
    const result = validateUnassignedStageParent({
      newParentId: 'parent',
      newStage: 2,
      getTask: () => createTask({ id: 'parent', stage: 1 }),
    });

    expect(result.ok).toBe(true);
  });

  it('rejects missing or unassigned new parent', () => {
    const missing = validateUnassignedStageParent({
      newParentId: 'missing',
      newStage: 2,
      getTask: () => null,
    });
    const unassigned = validateUnassignedStageParent({
      newParentId: 'parent',
      newStage: 2,
      getTask: () => createTask({ id: 'parent', stage: null }),
    });

    expect(missing.ok).toBe(false);
    expect(unassigned.ok).toBe(false);
  });

  it('rejects assigned parent from a non-previous stage', () => {
    const result = validateUnassignedStageParent({
      newParentId: 'parent',
      newStage: 3,
      getTask: () => createTask({ id: 'parent', stage: 1 }),
    });

    expect(result.ok).toBe(false);
  });
});

describe('resolveAssignedMoveParentId', () => {
  it('prefers explicit parent when provided', () => {
    const result = resolveAssignedMoveParentId({
      newStage: 3,
      newParentId: 'explicit',
      currentParentId: 'current',
      getTask: () => createTask({ id: 'explicit', stage: 2 }),
    });

    expect(result.parentId).toBe('explicit');
    expect(result.cleared).toBe(false);
  });

  it('keeps current parent when still valid for target stage', () => {
    const result = resolveAssignedMoveParentId({
      newStage: 3,
      newParentId: undefined,
      currentParentId: 'current',
      getTask: () => createTask({ id: 'current', stage: 2 }),
    });

    expect(result.parentId).toBe('current');
    expect(result.cleared).toBe(false);
  });

  it('clears current parent when stage no longer matches', () => {
    const result = resolveAssignedMoveParentId({
      newStage: 2,
      newParentId: undefined,
      currentParentId: 'current',
      getTask: () => createTask({ id: 'current', stage: 3 }),
    });

    expect(result.parentId).toBeNull();
    expect(result.cleared).toBe(true);
  });

  it('passes through explicit null parent without clearing flag', () => {
    const result = resolveAssignedMoveParentId({
      newStage: 3,
      newParentId: null,
      currentParentId: 'current',
      getTask: () => createTask({ id: 'current', stage: 2 }),
    });

    expect(result).toEqual({ parentId: null, cleared: false });
  });
});

describe('selectReplacementChildrenToDetach', () => {
  it('only detaches children that belong to the source subtree', () => {
    const selected = selectReplacementChildrenToDetach({
      tasks: [
        createTask({ id: 'source', stage: 1 }),
        createTask({ id: 'child-a', stage: 2, parentId: 'source' }),
        createTask({ id: 'child-b', stage: 2, parentId: 'other' }),
      ],
      sourceTaskId: 'source',
    });

    expect(selected.map(task => task.id)).toEqual(['child-a']);
  });

  it('limits detached children to a specific child id when provided', () => {
    const selected = selectReplacementChildrenToDetach({
      tasks: [
        createTask({ id: 'source', stage: 1 }),
        createTask({ id: 'child-a', stage: 2, parentId: 'source' }),
        createTask({ id: 'child-b', stage: 2, parentId: 'source' }),
      ],
      sourceTaskId: 'source',
      specificChildId: 'child-b',
    });

    expect(selected.map(task => task.id)).toEqual(['child-b']);
  });
});

describe('assignUnassignedSubtreeInProject', () => {
  it('assigns the subtree stages and ranks through injected layout callbacks', () => {
    const fixSubtreeRanks = vi.fn();
    const rebalance = vi.fn((project: Project) => project);
    const setResult = vi.fn();
    const project = createProject({
      tasks: [
        createTask({ id: 'parent', stage: 1, rank: 500 }),
        createTask({ id: 'root', stage: null, parentId: null, rank: 0 }),
        createTask({ id: 'child', stage: null, parentId: 'root', rank: 0 }),
      ],
    });

    const result = assignUnassignedSubtreeInProject({
      applyRefusalStrategy: vi.fn().mockReturnValue({ ok: true, rank: 1500 }),
      beforeTaskId: null,
      computeInsertRank: vi.fn().mockReturnValue(1500),
      fixSubtreeRanks,
      maxDepth: 100,
      newParentId: 'parent',
      project,
      rebalance,
      setResult,
      targetStage: 2,
      taskId: 'root',
    });

    expect(result.tasks.find(task => task.id === 'root')).toMatchObject({
      parentId: 'parent',
      rank: 1500,
      stage: 2,
    });
    expect(result.tasks.find(task => task.id === 'child')).toMatchObject({
      parentId: 'root',
      stage: 3,
    });
    expect(fixSubtreeRanks).toHaveBeenCalledWith('root', expect.any(Array));
    expect(rebalance).toHaveBeenCalledTimes(1);
    expect(setResult).not.toHaveBeenCalled();
  });
});

describe('assignUnassignedToTaskInProject', () => {
  it('uses subtree collaborators to attach an unassigned block under an assigned task', () => {
    const assignSubtreeToStage = vi.fn();
    const collectSubtreeIds = vi.fn().mockReturnValue(new Set(['target', 'child']));
    const fixSubtreeRanks = vi.fn();
    const rebalance = vi.fn((project: Project) => project);
    const setResult = vi.fn();
    const project = createProject({
      tasks: [
        createTask({ id: 'source', stage: 1, rank: 1000 }),
        createTask({ id: 'target', stage: null, rank: 0 }),
        createTask({ id: 'child', stage: null, parentId: 'target', rank: 0 }),
        createTask({ id: 'peer', stage: 2, rank: 2000 }),
      ],
    });

    const result = assignUnassignedToTaskInProject({
      applyRefusalStrategy: vi.fn().mockReturnValue({ ok: true, rank: 1500 }),
      assignSubtreeToStage,
      collectSubtreeIds,
      computeInsertRank: vi.fn().mockReturnValue(1500),
      fixSubtreeRanks,
      project,
      rebalance,
      setResult,
      sourceTaskId: 'source',
      targetStage: 2,
      targetUnassignedId: 'target',
    });

    expect(assignSubtreeToStage).toHaveBeenCalledWith('target', 'source', 2, expect.any(Array));
    expect(collectSubtreeIds).toHaveBeenCalledWith('target', expect.any(Array));
    expect(result.tasks.find(task => task.id === 'target')).toMatchObject({ rank: 1500 });
    expect(fixSubtreeRanks).toHaveBeenCalledWith('target', expect.any(Array));
    expect(rebalance).toHaveBeenCalledTimes(1);
    expect(setResult).not.toHaveBeenCalled();
  });
});
