import { describe, expect, it } from 'vitest';
import type { Connection, Project, Task } from '../models';
import { buildStrategicReviewMarkdown } from './flow-strategic-review';

function task(overrides: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  return {
    id: overrides.id,
    title: overrides.title,
    content: overrides.content ?? '',
    stage: overrides.stage ?? 1,
    parentId: overrides.parentId ?? null,
    order: overrides.order ?? 0,
    rank: overrides.rank ?? 1000,
    status: overrides.status ?? 'active',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    createdDate: overrides.createdDate ?? '2026-01-01T00:00:00.000Z',
    displayId: overrides.displayId ?? overrides.id,
    deletedAt: overrides.deletedAt,
  };
}

function connection(overrides: Pick<Connection, 'id' | 'source' | 'target'> & Partial<Connection>): Connection {
  return {
    id: overrides.id,
    source: overrides.source,
    target: overrides.target,
    title: overrides.title,
    description: overrides.description,
    updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
    deletedAt: overrides.deletedAt,
  };
}

function project(overrides: Partial<Project>): Project {
  return {
    id: 'project-1',
    name: '战略项目',
    description: '用任务关系复盘主线',
    createdDate: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    tasks: [],
    connections: [],
    version: 1,
    ...overrides,
  };
}

describe('buildStrategicReviewMarkdown', () => {
  it('builds deterministic review markdown around the strongest root task', () => {
    const result = buildStrategicReviewMarkdown(project({
      tasks: [
        task({ id: 'main', title: '主任务', content: '第一行说明', order: 2 }),
        task({ id: 'child', title: '子任务', parentId: 'main', order: 1 }),
        task({ id: 'floating', title: '浮动草稿', stage: null, order: 1 }),
        task({ id: 'completed', title: '已完成推进', parentId: 'main', status: 'completed', order: 2 }),
        task({ id: 'archived', title: '归档任务', status: 'archived' }),
        task({ id: 'deleted', title: '已删除任务', deletedAt: '2026-01-02T00:00:00.000Z' }),
      ],
      connections: [
        connection({
          id: 'link-1',
          source: 'main',
          target: 'floating',
          title: '支撑关系',
          description: '横向说明',
        }),
        connection({ id: 'link-deleted', source: 'main', target: 'child', deletedAt: '2026-01-02T00:00:00.000Z' }),
        connection({ id: 'link-missing', source: 'main', target: 'missing' }),
      ],
    }));

    expect(result.stats).toEqual({
      totalTasks: 4,
      totalConnections: 1,
      mainTaskTitle: '主任务',
      roots: 2,
      maxTreeDepth: 2,
    });
    expect(result.warnings).toEqual([]);
    expect(result.markdown).toContain('## 项目：战略项目');
    expect(result.markdown).toContain('**主任务**');
    expect(result.markdown).toContain('- 子任务');
    expect(result.markdown).toContain('- ✓ 已完成推进');
    expect(result.markdown).toContain('**主任务** ↔ **浮动草稿**：');
    expect(result.markdown).not.toContain('归档任务');
    expect(result.markdown).not.toContain('已删除任务');
  });

  it('can exclude completed tasks and redact readable text', () => {
    const result = buildStrategicReviewMarkdown(project({
      name: '敏感项目',
      description: '敏感说明',
      tasks: [
        task({ id: 'root', title: '核心目标', content: '敏感正文' }),
        task({ id: 'done', title: '完成项', parentId: 'root', status: 'completed' }),
      ],
    }), {
      includeCompleted: false,
      redactPII: true,
    });

    expect(result.stats.totalTasks).toBe(1);
    expect(result.markdown).toContain('敏***目');
    expect(result.markdown).toContain('核***标');
    expect(result.markdown).not.toContain('完成项');
  });
});
