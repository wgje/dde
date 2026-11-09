import { describe, expect, it } from 'vitest';
import type { Connection, Project, Task } from '../models';
import { exportProjectLogic } from './flow-logic-export';

function task(overrides: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  return {
    id: overrides.id,
    title: overrides.title,
    content: overrides.content ?? '',
    stage: Object.prototype.hasOwnProperty.call(overrides, 'stage') ? overrides.stage ?? null : 1,
    parentId: overrides.parentId ?? null,
    order: overrides.order ?? 0,
    rank: overrides.rank ?? 1000,
    status: overrides.status ?? 'active',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    createdDate: overrides.createdDate ?? '2026-01-01T00:00:00.000Z',
    displayId: overrides.displayId ?? overrides.id,
    parkingMeta: overrides.parkingMeta,
    expected_minutes: overrides.expected_minutes,
    cognitive_load: overrides.cognitive_load,
    wait_minutes: overrides.wait_minutes,
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
    name: '逻辑网项目',
    description: '',
    createdDate: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    tasks: [],
    connections: [],
    version: 1,
    ...overrides,
  };
}

describe('exportProjectLogic', () => {
  it('exports full Mermaid and YAML with dirty-data invariants preserved', () => {
    const result = exportProjectLogic(project({
      tasks: [
        task({ id: 'root', title: 'Root', displayId: 'R', stage: 1, order: 1 }),
        task({
          id: 'child',
          title: 'Child',
          displayId: 'C',
          parentId: 'root',
          stage: 2,
          order: 2,
          expected_minutes: 30,
          cognitive_load: 'high',
          wait_minutes: 5,
        }),
        task({
          id: 'floating',
          title: 'Floating',
          displayId: 'F',
          stage: null,
          order: 3,
          parkingMeta: {
            state: 'parked',
            parkedAt: '2026-01-02T00:00:00.000Z',
            lastVisitedAt: null,
            contextSnapshot: null,
            reminder: null,
            pinned: true,
          },
        }),
      ],
      connections: [
        connection({ id: 'cross', source: 'root', target: 'floating', title: 'Cross' }),
        connection({ id: 'duplicate-parent-child', source: 'root', target: 'child', title: 'Duplicate' }),
        connection({ id: 'orphan', source: 'root', target: 'missing', title: 'Orphan' }),
        connection({ id: 'self-loop', source: 'floating', target: 'floating', title: 'Loop' }),
      ],
    }), {
      format: 'both',
    });

    expect(result.stats).toEqual({
      totalTasks: 3,
      totalConnections: 2,
      roots: 1,
      floatingRoots: 1,
      maxTreeDepth: 2,
    });
    expect(result.invariants.map(item => item.code)).toEqual(expect.arrayContaining([
      'ORPHAN_CONNECTIONS',
      'DUPLICATE_PARENT_CHILD_EDGE',
      'CROSS_TREE_CYCLE',
      'SELF_LOOP_CONNECTION',
    ]));
    expect(result.warnings).toEqual(expect.arrayContaining([
      '发现 1 条孤儿连接（端点缺失）',
      '发现 1 条与 parentId 重复的历史父子边（数据污染，建议清理）',
    ]));
    expect(result.mermaid).toContain('flowchart TD');
    expect(result.mermaid).toContain('N_root ==> N_child');
    expect(result.mermaid).toContain('N_root -. "Cross" .-> N_floating');
    expect(result.yaml).toContain('project:');
    expect(result.yaml).toContain('parking_meta:');
    expect(result.yaml).toContain('expected_minutes: 30');
  });

  it('supports stage-filtered redacted YAML without planning or parking metadata', () => {
    const result = exportProjectLogic(project({
      tasks: [
        task({ id: 'root', title: '核心目标', displayId: 'R', stage: 1 }),
        task({ id: 'done', title: '完成项', displayId: 'D', parentId: 'root', stage: 2, status: 'completed' }),
        task({
          id: 'floating',
          title: '浮动根',
          displayId: 'F',
          stage: null,
          expected_minutes: 60,
          parkingMeta: {
            state: 'parked',
            parkedAt: null,
            lastVisitedAt: null,
            contextSnapshot: null,
            reminder: null,
            pinned: false,
          },
        }),
      ],
      connections: [],
    }), {
      format: 'yaml',
      mode: 'stage',
      stageFilter: [null],
      includeCompleted: false,
      includePlanning: false,
      includeParking: false,
      redactPII: true,
    });

    expect(result.mermaid).toBeUndefined();
    expect(result.stats).toEqual({
      totalTasks: 1,
      totalConnections: 0,
      roots: 0,
      floatingRoots: 1,
      maxTreeDepth: 1,
    });
    expect(result.yaml).toContain('title: "浮***根(len=3)"');
    expect(result.yaml).not.toContain('核心目标');
    expect(result.yaml).not.toContain('planning:');
    expect(result.yaml).not.toContain('parking_meta:');
  });
});
