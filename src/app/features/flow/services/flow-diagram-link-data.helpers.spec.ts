import { describe, expect, it } from 'vitest';
import type { Connection, Task } from '../../../../models';
import {
  buildFlowLinkDataSeed,
  createParentChildPairKeys,
  createStageNodeCount,
} from './flow-diagram-link-data.helpers';

function task(id: string, options: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    content: '',
    stage: Object.prototype.hasOwnProperty.call(options, 'stage')
      ? (options.stage ?? null)
      : 1,
    parentId: options.parentId ?? null,
    order: 1,
    rank: 100,
    status: options.status ?? 'active',
    x: 0,
    y: 0,
    createdDate: '2026-06-17T00:00:00.000Z',
    updatedAt: '2026-06-17T00:00:00.000Z',
    displayId: options.displayId ?? '1',
    attachments: [],
    tags: [],
  } as Task;
}

describe('flow diagram link data helpers', () => {
  it('creates parent-child pair keys from all tasks', () => {
    expect(createParentChildPairKeys([
      task('root'),
      task('child', { parentId: 'root' }),
    ])).toEqual(new Set(['root->child']));
  });

  it('counts only assigned visible task stages', () => {
    expect(createStageNodeCount([
      task('stage-1-a', { stage: 1 }),
      task('stage-1-b', { stage: 1 }),
      task('unassigned', { stage: null }),
    ])).toEqual(new Map([[1, 2]]));
  });

  it('builds visible parent-child and cross-tree seed links with filtering metadata', () => {
    const root = task('root', { stage: 1 });
    const child = task('child', { stage: 2, parentId: 'root' });
    const related = task('related', { stage: 2 });
    const hidden = task('hidden', { stage: 3, status: 'archived' });
    const connections: Connection[] = [
      { id: 'visible-cross', source: 'root', target: 'related', title: 'Visible', description: 'Keep' },
      { id: 'parent-child-duplicate', source: 'root', target: 'child', title: 'Duplicate' },
      { id: 'deleted-cross', source: 'child', target: 'related', deletedAt: '2026-06-17T00:00:00.000Z' },
      { id: 'hidden-endpoint', source: 'root', target: 'hidden' },
    ];

    const seed = buildFlowLinkDataSeed({
      tasks: [root, child, related, hidden],
      project: { connections },
      tasksToShow: [root, child, related],
      relationDisplay: { relationDisplayMode: 'all', focusedTaskId: null },
    });

    expect(seed.linkDataArray).toEqual([
      expect.objectContaining({ key: 'root-child', from: 'root', to: 'child', isCrossTree: false }),
      expect.objectContaining({
        key: 'cross-root-related',
        from: 'root',
        to: 'related',
        isCrossTree: true,
        category: 'crossTree',
        title: 'Visible',
        description: 'Keep',
      }),
    ]);
    expect(seed.crossTreeLinksToStagger).toEqual([seed.linkDataArray[1]]);
    expect(seed.taskStageMap).toEqual(new Map([
      ['root', 1],
      ['child', 2],
      ['related', 2],
    ]));
    expect(seed.stageNodeCount).toEqual(new Map([
      [1, 1],
      [2, 2],
    ]));
  });

  it('filters cross-tree links by relation display mode', () => {
    const focused = task('focused', { stage: 1 });
    const related = task('related', { stage: 2 });
    const unrelatedA = task('unrelated-a', { stage: 2 });
    const unrelatedB = task('unrelated-b', { stage: 3 });
    const connections: Connection[] = [
      { id: 'focused-cross', source: 'focused', target: 'related' },
      { id: 'unrelated-cross', source: 'unrelated-a', target: 'unrelated-b' },
    ];

    const seed = buildFlowLinkDataSeed({
      tasks: [focused, related, unrelatedA, unrelatedB],
      project: { connections },
      tasksToShow: [focused, related, unrelatedA, unrelatedB],
      relationDisplay: { relationDisplayMode: 'focused', focusedTaskId: 'focused' },
    });
    const hiddenSeed = buildFlowLinkDataSeed({
      tasks: [focused, related],
      project: { connections },
      tasksToShow: [focused, related],
      relationDisplay: { relationDisplayMode: 'hidden', focusedTaskId: null },
    });

    expect(seed.linkDataArray.map(link => link.key)).toEqual(['cross-focused-related']);
    expect(hiddenSeed.linkDataArray).toEqual([]);
  });
});
