import { describe, it, expect } from 'vitest';
import { getProjectSaveFreshness, isProjectSaveNewer } from './project-save-freshness';
import type { Project } from '../../../../models';

function makeProject(partial: Partial<Project>): Project {
  return { tasks: [], connections: [], version: 0, ...partial } as unknown as Project;
}

describe('project-save-freshness', () => {
  it('getProjectSaveFreshness 取项目本体时间戳与版本', () => {
    const project = makeProject({ updatedAt: '2026-01-02T00:00:00.000Z', version: 3 });
    const f = getProjectSaveFreshness(project);
    expect(f.updatedAtMs).toBe(Date.parse('2026-01-02T00:00:00.000Z'));
    expect(f.version).toBe(3);
  });

  it('getProjectSaveFreshness 取任务/连接的最大时间戳', () => {
    const project = makeProject({
      updatedAt: '2026-01-01T00:00:00.000Z',
      tasks: [{ updatedAt: '2026-03-01T00:00:00.000Z', deletedAt: null }],
      connections: [{ updatedAt: '2026-02-01T00:00:00.000Z', deletedAt: null }],
    } as unknown as Partial<Project>);
    const f = getProjectSaveFreshness(project);
    expect(f.updatedAtMs).toBe(Date.parse('2026-03-01T00:00:00.000Z'));
  });

  it('isProjectSaveNewer: 时间戳更新者为 true', () => {
    const newer = makeProject({ updatedAt: '2026-05-01T00:00:00.000Z' });
    const older = makeProject({ updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(isProjectSaveNewer(newer, older)).toBe(true);
    expect(isProjectSaveNewer(older, newer)).toBe(false);
  });

  it('isProjectSaveNewer: 时间戳相等时比版本号', () => {
    const v2 = makeProject({ updatedAt: '2026-01-01T00:00:00.000Z', version: 2 });
    const v1 = makeProject({ updatedAt: '2026-01-01T00:00:00.000Z', version: 1 });
    expect(isProjectSaveNewer(v2, v1)).toBe(true);
    expect(isProjectSaveNewer(v1, v2)).toBe(false);
  });

  it('isProjectSaveNewer: 完全相等时返回 true（后到覆盖）', () => {
    const a = makeProject({ updatedAt: '2026-01-01T00:00:00.000Z', version: 1 });
    const b = makeProject({ updatedAt: '2026-01-01T00:00:00.000Z', version: 1 });
    expect(isProjectSaveNewer(a, b)).toBe(true);
  });
});
