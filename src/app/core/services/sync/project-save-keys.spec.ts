import { describe, it, expect } from 'vitest';
import { buildProjectSaveFlightKey, buildProjectSaveSignature } from './project-save-keys';
import type { Project } from '../../../../models';

function makeProject(partial: Partial<Project>): Project {
  return { id: 'p1', tasks: [], connections: [], version: 0, ...partial } as unknown as Project;
}

describe('project-save-keys', () => {
  it('buildProjectSaveFlightKey 拼接 userId:projectId', () => {
    expect(buildProjectSaveFlightKey('proj-1', 'user-9')).toBe('user-9:proj-1');
  });

  it('buildProjectSaveSignature 对相同输入稳定', () => {
    const project = makeProject({ updatedAt: '2026-01-01T00:00:00.000Z' });
    const a = buildProjectSaveSignature(project, ['t2', 't1']);
    const b = buildProjectSaveSignature(project, ['t2', 't1']);
    expect(a).toBe(b);
  });

  it('buildProjectSaveSignature 对待删除 id 排序后归一（顺序无关）', () => {
    const project = makeProject({ updatedAt: '2026-01-01T00:00:00.000Z' });
    const a = buildProjectSaveSignature(project, ['t1', 't2']);
    const b = buildProjectSaveSignature(project, ['t2', 't1']);
    expect(a).toBe(b);
  });

  it('buildProjectSaveSignature 不同待删除集合产生不同签名', () => {
    const project = makeProject({ updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(buildProjectSaveSignature(project, ['t1'])).not.toBe(buildProjectSaveSignature(project, ['t1', 't2']));
  });

  it('buildProjectSaveSignature 省略待删除参数视为空列表', () => {
    const project = makeProject({ updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(buildProjectSaveSignature(project)).toBe(buildProjectSaveSignature(project, []));
  });
});
