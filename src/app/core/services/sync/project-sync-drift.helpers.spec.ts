import { describe, expect, it } from 'vitest';
import type { Task, Connection } from '../../../../models';
import type { ConnectionRow, TaskRow } from '../../../../models/supabase-types';
import {
  buildProjectDeltaDrift,
  createEmptyProjectDeltaDrift,
  resolveProjectDeltaWindow,
} from './project-sync-drift.helpers';

describe('project sync drift helpers', () => {
  it('computes the larger of safety lookback and current clock drift', () => {
    expect(resolveProjectDeltaWindow(
      '2026-04-29T08:00:30.000Z',
      -45_000,
      30_000,
    )).toEqual({
      lookbackMs: 45_000,
      effectiveSince: '2026-04-29T07:59:45.000Z',
    });
  });

  it('returns a fresh empty drift result', () => {
    const first = createEmptyProjectDeltaDrift();
    const second = createEmptyProjectDeltaDrift();

    first.tasks.push(task('mutated', '2026-04-29T08:00:00.000Z'));

    expect(second).toEqual({ tasks: [], connections: [], nextCursor: null });
  });

  it('filters already processed rows and computes the next cursor from remaining rows', () => {
    const drift = buildProjectDeltaDrift({
      taskRows: [
        taskRow('task-a', '2026-04-29T08:00:30.000Z', 'old'),
        taskRow('task-b', '2026-04-29T08:00:30.000Z', 'newer-same-timestamp'),
        taskRow('task-c', '2026-04-29T08:00:35.000Z', 'latest'),
        taskRow('task-c', '2026-04-29T08:00:31.000Z', 'stale-duplicate'),
      ],
      connectionRows: [
        connectionRow('conn-a', '2026-04-29T08:00:30.000Z'),
        connectionRow('conn-z', '2026-04-29T08:00:35.000Z'),
      ],
      lastCursor: { updatedAt: '2026-04-29T08:00:30.000Z', entityType: 'task', id: 'task-a' },
      rowToTask: (row) => task(row.id, row.updated_at, row.title),
      rowToConnection: (row) => connection(row.id, row.updated_at),
    });

    expect(drift.tasks.map((item) => [item.id, item.title])).toEqual([
      ['task-b', 'newer-same-timestamp'],
      ['task-c', 'latest'],
    ]);
    expect(drift.connections.map((item) => item.id)).toEqual(['conn-a', 'conn-z']);
    expect(drift.nextCursor).toEqual({
      updatedAt: '2026-04-29T08:00:35.000Z',
      entityType: 'connection',
      id: 'conn-z',
    });
  });
});

function taskRow(id: string, updatedAt: string, title: string): TaskRow {
  return {
    id,
    project_id: 'project-1',
    title,
    content: title,
    stage: 1,
    parent_id: null,
    order: 0,
    rank: 1000,
    status: 'active',
    x: 0,
    y: 0,
    updated_at: updatedAt,
    created_at: '2026-04-29T08:00:00.000Z',
    completed_at: null,
    deleted_at: null,
    short_id: id,
    priority: null,
    due_date: null,
    expected_minutes: null,
    cognitive_load: null,
    wait_minutes: null,
    parking_meta: null,
    attention_meta: null,
    attachments: [],
    tags: [],
  };
}

function connectionRow(id: string, updatedAt: string): ConnectionRow {
  return {
    id,
    project_id: 'project-1',
    source_id: 'task-a',
    target_id: 'task-b',
    title: '',
    description: '',
    created_at: '2026-04-29T08:00:00.000Z',
    deleted_at: null,
    updated_at: updatedAt,
  };
}

function task(id: string, updatedAt: string, title = id): Task {
  return {
    id,
    title,
    content: title,
    stage: 1,
    parentId: null,
    order: 0,
    rank: 1000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: updatedAt,
    updatedAt,
    displayId: id,
    attachments: [],
  };
}

function connection(id: string, updatedAt: string): Connection {
  return {
    id,
    source: 'task-a',
    target: 'task-b',
    title: '',
    description: '',
    deletedAt: null,
    updatedAt,
  };
}
