import { describe, expect, it } from 'vitest';
import {
  filterConnectionTombstonesByVisibleProjects,
  filterTaskTombstonesByVisibleProjects,
  isLaunchSnapshotOwnedByCurrentUser,
  pickNewerDockSnapshot,
  readDockSnapshotSavedAt,
  toDockSnapshotCandidate,
} from './disaster-backup-local-state.helpers';

describe('disaster-backup-local-state.helpers', () => {
  it('只保留可见项目的任务 tombstone', () => {
    expect(filterTaskTombstonesByVisibleProjects({
      'project-1': { 'task-1': 123 },
      'project-2': { 'task-2': 456 },
    }, new Set(['project-1']))).toEqual({
      'project-1': { 'task-1': 123 },
    });
  });

  it('非法任务 tombstone 记录回退为空对象', () => {
    expect(filterTaskTombstonesByVisibleProjects(null, new Set(['project-1']))).toEqual({});
    expect(filterTaskTombstonesByVisibleProjects(['project-1'], new Set(['project-1']))).toEqual({});
  });

  it('只保留带可见项目 ID 的连接 tombstone', () => {
    expect(filterConnectionTombstonesByVisibleProjects([
      { projectId: 'project-1', connectionId: 'conn-1' },
      { projectId: 'project-2', connectionId: 'conn-2' },
      { connectionId: 'conn-3' },
      null,
    ], new Set(['project-1']))).toEqual([
      { projectId: 'project-1', connectionId: 'conn-1' },
    ]);
  });

  it('读取 dock snapshot savedAt 时拒绝空值和非字符串', () => {
    expect(readDockSnapshotSavedAt({ savedAt: '2026-03-10T00:00:00.000Z' })).toBe('2026-03-10T00:00:00.000Z');
    expect(readDockSnapshotSavedAt({ savedAt: '' })).toBeNull();
    expect(readDockSnapshotSavedAt({ savedAt: 123 })).toBeNull();
    expect(readDockSnapshotSavedAt(null)).toBeNull();
  });

  it('选择 savedAt 更新的 dock snapshot，非法时间让位给合法时间', () => {
    const current = { source: 'current', snapshot: { savedAt: 'bad-date' } };
    const incoming = { source: 'incoming', snapshot: { savedAt: '2026-03-10T00:00:00.000Z' } };

    expect(pickNewerDockSnapshot(current, incoming)).toBe(incoming);
    expect(pickNewerDockSnapshot(incoming, {
      source: 'older',
      snapshot: { savedAt: '2026-03-09T00:00:00.000Z' },
    })).toBe(incoming);
  });

  it('launch snapshot 只允许当前用户或匿名范围', () => {
    expect(isLaunchSnapshotOwnedByCurrentUser({ userId: 'user-1' }, 'user-1')).toBe(true);
    expect(isLaunchSnapshotOwnedByCurrentUser({ userId: 'user-2' }, 'user-1')).toBe(false);
    expect(isLaunchSnapshotOwnedByCurrentUser({ version: 1 }, null)).toBe(true);
    expect(isLaunchSnapshotOwnedByCurrentUser({ version: 1 }, 'user-1')).toBe(false);
  });

  it('将 IndexedDB 和 legacy localStorage 快照归一为 dock snapshot 候选', () => {
    expect(toDockSnapshotCandidate('idb-current', {
      savedAt: '2026-03-10T00:00:00.000Z',
      entries: [],
    })).toEqual({
      source: 'idb-current',
      snapshot: {
        savedAt: '2026-03-10T00:00:00.000Z',
        entries: [],
      },
      localStorageValue: null,
    });

    const legacyValue = JSON.stringify({ savedAt: '2026-03-11T00:00:00.000Z', entries: [] });
    expect(toDockSnapshotCandidate('legacy-current', legacyValue)).toEqual({
      source: 'legacy-current',
      snapshot: {
        savedAt: '2026-03-11T00:00:00.000Z',
        entries: [],
      },
      localStorageValue: legacyValue,
    });
  });

  it('拒绝缺少 savedAt 或类型不匹配的 dock snapshot 候选', () => {
    expect(toDockSnapshotCandidate('idb-current', { entries: [] })).toBeNull();
    expect(toDockSnapshotCandidate('idb-current', null)).toBeNull();
    expect(toDockSnapshotCandidate('legacy-current', { savedAt: '2026-03-10T00:00:00.000Z' })).toBeNull();
    expect(toDockSnapshotCandidate('legacy-current', '{bad json')).toBeNull();
  });
});
