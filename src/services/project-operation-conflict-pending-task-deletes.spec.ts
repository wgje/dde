import { describe, expect, it } from 'vitest';

import {
  createPendingTaskDeleteOperationId,
  resolveRefreshedPendingTaskDeleteBaseUpdatedAtMap,
  resolveEffectivePendingTaskDeleteBaseUpdatedAtMap,
  resolveEffectivePendingTaskDeleteIds,
} from './project-operation-conflict-pending-task-deletes';
import { isSyncOperationId } from '../utils/sync-operation-id';

describe('project-operation-conflict-pending-task-deletes', () => {
  it('returns no pending deletes when preservation is disabled', () => {
    const taskIds = resolveEffectivePendingTaskDeleteIds(
      { preservePendingTaskDeletes: false },
      { pendingTaskDeleteIds: ['active-task'] },
      { pendingTaskDeleteIds: ['stored-task'] },
    );

    expect(taskIds).toEqual([]);
  });

  it('merges active and stored pending delete ids while preserving first-seen order', () => {
    const taskIds = resolveEffectivePendingTaskDeleteIds(
      { preservePendingTaskDeletes: true },
      { pendingTaskDeleteIds: ['active-task', '', 'shared-task'] },
      { pendingTaskDeleteIds: ['shared-task', 'stored-task'] },
    );

    expect(taskIds).toEqual(['active-task', 'shared-task', 'stored-task']);
  });

  it('applies plan filters after merging pending delete ids', () => {
    const taskIds = resolveEffectivePendingTaskDeleteIds(
      {
        preservePendingTaskDeletes: true,
        filterPendingTaskDeletes: ids => ids.filter(id => id !== 'remote-task'),
      },
      { pendingTaskDeleteIds: ['local-task', 'remote-task'] },
      { pendingTaskDeleteIds: ['stored-task'] },
    );

    expect(taskIds).toEqual(['local-task', 'stored-task']);
  });

  it('prefers active conflict baseUpdatedAt values over stored conflict values', () => {
    const baseUpdatedAtMap = resolveEffectivePendingTaskDeleteBaseUpdatedAtMap(
      {
        pendingTaskDeleteBaseUpdatedAtMap: {
          'shared-task': '2026-06-15T02:00:00.000Z',
          'active-only': undefined,
        },
      },
      {
        pendingTaskDeleteBaseUpdatedAtMap: {
          'shared-task': '2026-06-15T01:00:00.000Z',
          'stored-only': '2026-06-15T00:00:00.000Z',
        },
      },
      ['shared-task', 'active-only', 'stored-only', 'missing-task'],
    );

    expect(baseUpdatedAtMap).toEqual({
      'shared-task': '2026-06-15T02:00:00.000Z',
      'active-only': null,
      'stored-only': '2026-06-15T00:00:00.000Z',
    });
  });

  it('returns undefined when none of the selected delete ids has baseUpdatedAt evidence', () => {
    const baseUpdatedAtMap = resolveEffectivePendingTaskDeleteBaseUpdatedAtMap(
      { pendingTaskDeleteBaseUpdatedAtMap: { unselected: '2026-06-15T00:00:00.000Z' } },
      null,
      ['selected'],
    );

    expect(baseUpdatedAtMap).toBeUndefined();
  });

  it('refreshes pending delete baselines from the fresh remote task snapshot', () => {
    const baseUpdatedAtMap = resolveRefreshedPendingTaskDeleteBaseUpdatedAtMap(
      {
        tasks: [
          { id: 'remote-task', updatedAt: '2026-06-15T04:00:00.000Z' },
        ],
      },
      ['remote-task', 'missing-task'],
      {
        'remote-task': '2026-06-15T02:00:00.000Z',
        'missing-task': '2026-06-15T01:00:00.000Z',
      },
    );

    expect(baseUpdatedAtMap).toEqual({
      'remote-task': '2026-06-15T04:00:00.000Z',
      'missing-task': '2026-06-15T01:00:00.000Z',
    });
  });

  it('uses compatibility remoteUpdatedAt for a single remotely deleted task', () => {
    expect(resolveRefreshedPendingTaskDeleteBaseUpdatedAtMap(
      { tasks: [] },
      ['deleted-task'],
      { 'deleted-task': '2026-06-15T01:00:00.000Z' },
      '2026-06-15T05:00:00.000Z',
    )).toEqual({
      'deleted-task': '2026-06-15T05:00:00.000Z',
    });
  });

  it('creates a stable operation id for the same pending task delete intent', () => {
    const project = {
      id: 'project-id',
      version: 12,
      updatedAt: '2026-06-15T03:00:00.000Z',
    };

    const firstOperationId = createPendingTaskDeleteOperationId(
      project,
      'task-id',
      'user-id',
      '2026-06-15T02:00:00.000Z',
    );
    const secondOperationId = createPendingTaskDeleteOperationId(
      project,
      'task-id',
      'user-id',
      '2026-06-15T02:00:00.000Z',
    );

    expect(isSyncOperationId(firstOperationId)).toBe(true);
    expect(secondOperationId).toBe(firstOperationId);
  });

  it('includes owner and baseUpdatedAt fallback values in the operation id input', () => {
    const project = {
      id: 'project-id',
      version: undefined,
      updatedAt: undefined,
    };

    const localOwnerOperationId = createPendingTaskDeleteOperationId(project, 'task-id', null, undefined);
    const remoteOwnerOperationId = createPendingTaskDeleteOperationId(project, 'task-id', 'user-id', undefined);
    const basedOperationId = createPendingTaskDeleteOperationId(project, 'task-id', null, null);

    expect(localOwnerOperationId).not.toBe(remoteOwnerOperationId);
    expect(localOwnerOperationId).toBe(basedOperationId);
  });

  it('creates a new operation id after project or task baseline advances', () => {
    const project = {
      id: 'project-id',
      version: 12,
      updatedAt: '2026-06-15T03:00:00.000Z',
    };
    const firstOperationId = createPendingTaskDeleteOperationId(
      project,
      'task-id',
      'user-id',
      '2026-06-15T02:00:00.000Z',
    );

    expect(createPendingTaskDeleteOperationId(
      { ...project, version: 13 },
      'task-id',
      'user-id',
      '2026-06-15T02:00:00.000Z',
    )).not.toBe(firstOperationId);
    expect(createPendingTaskDeleteOperationId(
      project,
      'task-id',
      'user-id',
      '2026-06-15T04:00:00.000Z',
    )).not.toBe(firstOperationId);
  });
});
