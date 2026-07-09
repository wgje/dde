import { describe, expect, it } from 'vitest';
import type { Project } from '../models';
import { detectMigrationNeed } from './migration-detection.helpers';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? 'project-1',
    name: overrides.name ?? 'Project',
    description: overrides.description ?? '',
    createdDate: overrides.createdDate ?? '2026-01-01T00:00:00.000Z',
    tasks: overrides.tasks ?? [],
    connections: overrides.connections ?? [],
    updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
    version: overrides.version ?? 1,
    syncSource: overrides.syncSource,
    pendingSync: overrides.pendingSync,
  };
}

describe('migration-detection.helpers', () => {
  it('本地存在远程没有的项目时需要迁移', () => {
    expect(detectMigrationNeed([project({ id: 'local-only' })], [])).toBe(true);
  });

  it('远程 local-only 影子不应阻止迁移提示', () => {
    const local = project({ id: 'shadowed' });
    const remoteShadow = project({ id: 'shadowed', syncSource: 'local-only', pendingSync: true });

    expect(detectMigrationNeed([local], [remoteShadow])).toBe(true);
  });

  it('同一项目本地版本高于远程 synced 版本时需要迁移', () => {
    const local = project({ id: 'changed', version: 3 });
    const remote = project({ id: 'changed', syncSource: 'synced', version: 2 });

    expect(detectMigrationNeed([local], [remote])).toBe(true);
  });

  it('本地与 synced 远程版本一致时不需要迁移', () => {
    const local = project({ id: 'same', version: 2 });
    const remote = project({ id: 'same', syncSource: 'synced', version: 2 });

    expect(detectMigrationNeed([local], [remote])).toBe(false);
  });
});
