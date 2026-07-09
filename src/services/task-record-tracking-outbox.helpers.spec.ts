import { describe, expect, it, vi } from 'vitest';

import {
  collectTaskRecordTrackingOutboxActions,
  getTaskRecordChangedFields,
  hasMissingRecoverableTaskRecordTrackingOutboxIntent,
} from './task-record-tracking-outbox.helpers';
import { createConnection, createProject, createTask } from './task-record-tracking.service.spec-helpers';

describe('task record tracking outbox helpers', () => {
  it('collects task create/update/delete and removed connection actions', () => {
    const beforeTask = createTask({
      id: 'task-existing',
      title: 'Before',
      updatedAt: '2026-06-13T00:00:00.000Z',
    });
    const removedTask = createTask({
      id: 'task-removed',
      updatedAt: '2026-06-13T00:10:00.000Z',
    });
    const removedConnection = createConnection({ id: 'conn-removed' });
    const project = createProject({
      tasks: [
        { ...beforeTask, title: 'After', updatedAt: '2026-06-13T01:00:00.000Z' },
        createTask({ id: 'task-created', title: 'Created' }),
      ],
      connections: [],
    });

    const actions = collectTaskRecordTrackingOutboxActions({
      project,
      beforeTaskMap: new Map([
        [beforeTask.id, beforeTask],
        [removedTask.id, removedTask],
      ]),
      beforeConnectionMap: new Map([[removedConnection.id, removedConnection]]),
      sourceUserId: 'user-1',
      logger: { warn: vi.fn(), debug: vi.fn() },
    });

    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'update', entityType: 'task', entityId: 'task-existing' }),
      expect.objectContaining({ type: 'create', entityType: 'task', entityId: 'task-created' }),
      expect.objectContaining({
        type: 'delete',
        entityType: 'task',
        entityId: 'task-removed',
        payload: expect.objectContaining({ baseUpdatedAt: '2026-06-13T00:10:00.000Z' }),
      }),
      expect.objectContaining({
        type: 'delete',
        entityType: 'connection',
        entityId: 'conn-removed',
        payload: expect.objectContaining({
          connection: expect.objectContaining({
            id: 'conn-removed',
            deletedAt: expect.any(String),
            updatedAt: expect.any(String),
          }),
        }),
      }),
    ]));
  });

  it('keeps task sidecar fields in the dirty field list', () => {
    const before = createTask({
      tags: ['old'],
      attachments: [{ id: 'attachment-before', name: 'before.txt' } as never],
      attentionMeta: null,
    });
    const after = createTask({
      ...before,
      tags: ['new'],
      attachments: [{ id: 'attachment-after', name: 'after.txt' } as never],
      attentionMeta: { updatedAt: '2026-06-13T02:00:00.000Z', items: [] },
    });

    expect(getTaskRecordChangedFields(before, after)).toEqual(expect.arrayContaining([
      'tags',
      'attachments',
      'attentionMeta',
    ]));
  });

  it('skips outbox actions for local-only projects', () => {
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const project = createProject({
      syncSource: 'local-only',
      tasks: [createTask({ id: 'task-created' })],
    });

    const actions = collectTaskRecordTrackingOutboxActions({
      project,
      beforeTaskMap: new Map(),
      beforeConnectionMap: new Map(),
      sourceUserId: 'user-1',
      logger,
    });

    expect(actions).toEqual([]);
    expect(logger.debug).toHaveBeenCalledWith(
      'local-only 项目跳过任务 ActionQueue 入队',
      expect.objectContaining({ projectId: project.id, taskId: 'task-created', type: 'create' }),
    );
  });

  it('detects a missing recoverable outbox intent when a cloud task changed but no action was built', () => {
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const beforeTask = createTask({ id: 'task-existing', title: 'Before' });
    const project = createProject({
      tasks: [{ ...beforeTask, title: 'After' }],
    });

    expect(hasMissingRecoverableTaskRecordTrackingOutboxIntent({
      project,
      beforeTaskMap: new Map([[beforeTask.id, beforeTask]]),
      beforeConnectionMap: new Map(),
      outboxActions: [],
      logger,
    })).toBe(true);
  });

  it('does not report missing recoverable intent when an outbox action exists', () => {
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const beforeTask = createTask({ id: 'task-existing', title: 'Before' });
    const project = createProject({
      tasks: [{ ...beforeTask, title: 'After' }],
    });
    const beforeTaskMap = new Map([[beforeTask.id, beforeTask]]);
    const outboxActions = collectTaskRecordTrackingOutboxActions({
      project,
      beforeTaskMap,
      beforeConnectionMap: new Map(),
      sourceUserId: 'user-1',
      logger,
    });

    expect(hasMissingRecoverableTaskRecordTrackingOutboxIntent({
      project,
      beforeTaskMap,
      beforeConnectionMap: new Map(),
      outboxActions,
      logger,
    })).toBe(false);
  });

  it('does not report missing recoverable intent for local-only project mutations', () => {
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const beforeTask = createTask({ id: 'task-existing', title: 'Before' });
    const project = createProject({
      syncSource: 'local-only',
      tasks: [{ ...beforeTask, title: 'After' }],
    });

    expect(hasMissingRecoverableTaskRecordTrackingOutboxIntent({
      project,
      beforeTaskMap: new Map([[beforeTask.id, beforeTask]]),
      beforeConnectionMap: new Map(),
      outboxActions: [],
      logger,
    })).toBe(false);
  });
});
