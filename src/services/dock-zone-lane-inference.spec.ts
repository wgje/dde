import { describe, expect, it } from 'vitest';
import { inferDockAutoLane } from './dock-zone-lane-inference';
import type { Task } from '../models';

const makeTask = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title: id,
  content: '',
  stage: null,
  parentId: null,
  order: 0,
  rank: 1,
  status: 'active',
  x: 0,
  y: 0,
  createdDate: '2026-06-09T00:00:00.000Z',
  displayId: id,
  deletedAt: null,
  ...overrides,
});

describe('dock zone lane inference', () => {
  it('scores parent-child and direct connections into combo-select', () => {
    const result = inferDockAutoLane({
      task: makeTask('child', { parentId: 'main' }),
      referenceTask: makeTask('main'),
      treeDistance: 1,
      hasDirectConnection: true,
    });

    expect(result).toEqual({
      lane: 'combo-select',
      relationScore: 100,
      relationReason: 'auto:parent-child|direct-connection',
    });
  });

  it('scores tree distance, same stage, and adjacent order together', () => {
    const result = inferDockAutoLane({
      task: makeTask('nearby-a', { stage: 2, order: 4 }),
      referenceTask: makeTask('nearby-b', { stage: 2, order: 5 }),
      treeDistance: 3,
      hasDirectConnection: false,
    });

    expect(result).toEqual({
      lane: 'backup',
      relationScore: 47,
      relationReason: 'auto:tree-distance:3|same-stage|adjacent-order',
    });
  });

  it('uses backup for same-project tasks with no meaningful relation', () => {
    const result = inferDockAutoLane({
      task: makeTask('candidate', { stage: 1, order: 10 }),
      referenceTask: makeTask('main', { stage: 2, order: 0 }),
      treeDistance: null,
      hasDirectConnection: false,
    });

    expect(result).toEqual({
      lane: 'backup',
      relationScore: 0,
      relationReason: 'auto:same-project-low-relation',
    });
  });
});
