import { describe, expect, it } from 'vitest';
import {
  buildBatchTombstoneCacheData,
  parseLocalTombstoneProjectRecord,
  parseTombstoneTimestamp,
  rowsFromTaskTombstoneCache,
  type TombstoneCache,
} from './tombstone.helpers';

describe('tombstone.helpers', () => {
  it('解析 tombstone 时间戳时忽略空值和非法日期', () => {
    expect(parseTombstoneTimestamp(null)).toBeUndefined();
    expect(parseTombstoneTimestamp(undefined)).toBeUndefined();
    expect(parseTombstoneTimestamp('not-a-date')).toBeUndefined();
    expect(parseTombstoneTimestamp('2026-06-09T00:00:00.000Z')).toBe(Date.parse('2026-06-09T00:00:00.000Z'));
  });

  it('兼容旧版本地 tombstone 数组并只保留字符串任务 ID', () => {
    const parsed = parseLocalTombstoneProjectRecord(['task-1', 42, 'task-2'], 1780000000000);

    expect([...parsed.entries()]).toEqual([
      ['task-1', 1780000000000],
      ['task-2', 1780000000000],
    ]);
  });

  it('解析带时间戳的本地 tombstone 记录并用 fallback 填补非数字时间', () => {
    const parsed = parseLocalTombstoneProjectRecord({
      'task-1': 1770000000000,
      'task-2': 'invalid',
    }, 1780000000000);

    expect([...parsed.entries()]).toEqual([
      ['task-1', 1770000000000],
      ['task-2', 1780000000000],
    ]);
  });

  it('从任务 tombstone 缓存生成 RPC 兼容行并保留 deleted_at 水位', () => {
    const cache: TombstoneCache = {
      ids: new Set(['task-1', 'task-2']),
      timestamp: 1780000000000,
      taskDeletedAt: new Map([
        ['task-1', Date.parse('2026-06-09T00:00:00.000Z')],
      ]),
    };

    expect(rowsFromTaskTombstoneCache(cache)).toEqual([
      { task_id: 'task-1', deleted_at: '2026-06-09T00:00:00.000Z' },
      { task_id: 'task-2', deleted_at: undefined },
    ]);
  });

  it('批量 tombstone 结果按项目分组并标记缺失 deleted_at 的项目', () => {
    const grouped = buildBatchTombstoneCacheData({
      task_tombstones: [
        { project_id: 'project-1', task_id: 'task-1', deleted_at: '2026-06-09T00:00:00.000Z' },
        { project_id: 'project-1', task_id: 'task-2', deleted_at: null },
        { project_id: 'project-2', task_id: 'task-3' },
      ],
      connection_tombstones: [
        { project_id: 'project-1', connection_id: 'conn-1' },
        { project_id: 'project-2', connection_id: 'conn-2' },
      ],
    });

    expect([...grouped.taskMap.get('project-1') ?? []]).toEqual(['task-1', 'task-2']);
    expect([...grouped.taskMap.get('project-2') ?? []]).toEqual(['task-3']);
    expect(grouped.taskDeletedAtMap.get('project-1')?.get('task-1')).toBe(Date.parse('2026-06-09T00:00:00.000Z'));
    expect([...grouped.taskProjectsMissingDeletedAt]).toEqual(['project-1', 'project-2']);
    expect([...grouped.connMap.get('project-1') ?? []]).toEqual(['conn-1']);
    expect([...grouped.connMap.get('project-2') ?? []]).toEqual(['conn-2']);
  });
});
