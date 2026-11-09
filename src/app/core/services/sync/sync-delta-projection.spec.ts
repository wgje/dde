import { describe, it, expect } from 'vitest';
import {
  dedupeTasksByLatest,
  dedupeConnectionsByLatest,
  computeProjectSyncCursor,
  isProjectRowAfterCursor,
  buildProjectSyncCursorFromProject,
} from './sync-delta-projection';
import type { Task, Connection, Project } from '../../../../models';
import type { TaskRow, ConnectionRow } from '../../../../models/supabase-types';
import type { ProjectSyncCursor } from '../../state/persistence';

function task(id: string, updatedAt: string): Task {
  return { id, updatedAt } as unknown as Task;
}
function conn(id: string, updatedAt: string): Connection {
  return { id, updatedAt } as unknown as Connection;
}

describe('sync-delta-projection · dedupe', () => {
  it('dedupeTasksByLatest 保留最新 updatedAt', () => {
    const result = dedupeTasksByLatest([
      task('a', '2026-01-01T00:00:00.000Z'),
      task('a', '2026-03-01T00:00:00.000Z'),
      task('b', '2026-02-01T00:00:00.000Z'),
    ]);
    expect(result).toHaveLength(2);
    expect(result.find(t => t.id === 'a')?.updatedAt).toBe('2026-03-01T00:00:00.000Z');
  });

  it('dedupeConnectionsByLatest 时间戳相等时保留后者', () => {
    const result = dedupeConnectionsByLatest([
      conn('c', '2026-01-01T00:00:00.000Z'),
      conn('c', '2026-01-01T00:00:00.000Z'),
    ]);
    expect(result).toHaveLength(1);
  });
});

describe('sync-delta-projection · cursor', () => {
  it('computeProjectSyncCursor 取最大游标', () => {
    const taskRows = [
      { id: 't1', updated_at: '2026-01-01T00:00:00.000Z' },
      { id: 't2', updated_at: '2026-05-01T00:00:00.000Z' },
    ] as unknown as TaskRow[];
    const connRows = [
      { id: 'c1', updated_at: '2026-02-01T00:00:00.000Z' },
    ] as unknown as ConnectionRow[];
    const cursor = computeProjectSyncCursor(taskRows, connRows);
    expect(cursor?.updatedAt).toBe('2026-05-01T00:00:00.000Z');
    expect(cursor?.id).toBe('t2');
  });

  it('computeProjectSyncCursor 空输入返回 null', () => {
    expect(computeProjectSyncCursor([], [])).toBeNull();
  });

  it('isProjectRowAfterCursor 无游标视为全量通过', () => {
    expect(isProjectRowAfterCursor('task', 't1', '2026-01-01T00:00:00.000Z', null)).toBe(true);
  });

  it('isProjectRowAfterCursor 早于游标返回 false', () => {
    const cursor: ProjectSyncCursor = { updatedAt: '2026-05-01T00:00:00.000Z', entityType: 'task', id: 't9' };
    expect(isProjectRowAfterCursor('task', 't1', '2026-01-01T00:00:00.000Z', cursor)).toBe(false);
  });

  it('isProjectRowAfterCursor 非字符串入参返回 false（有游标时）', () => {
    const cursor: ProjectSyncCursor = { updatedAt: '2026-05-01T00:00:00.000Z', entityType: 'task', id: 't9' };
    expect(isProjectRowAfterCursor('task', 123, '2026-06-01T00:00:00.000Z', cursor)).toBe(false);
  });

  it('buildProjectSyncCursorFromProject 综合项目/任务/连接取最大', () => {
    const project = {
      id: 'p1',
      updatedAt: '2026-01-01T00:00:00.000Z',
      tasks: [task('t1', '2026-04-01T00:00:00.000Z')],
      connections: [conn('c1', '2026-02-01T00:00:00.000Z')],
    } as unknown as Project;
    const cursor = buildProjectSyncCursorFromProject(project);
    expect(cursor?.updatedAt).toBe('2026-04-01T00:00:00.000Z');
    expect(cursor?.entityType).toBe('task');
  });
});
