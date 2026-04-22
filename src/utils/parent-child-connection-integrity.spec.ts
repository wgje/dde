import { describe, expect, it } from 'vitest';
import type { Connection, Task } from '../models';
import {
  buildActiveParentChildEdgeSet,
  filterParentChildDuplicateConnections,
  isParentChildDuplicateConnection,
  softDeleteParentChildDuplicateConnections,
} from './parent-child-connection-integrity';

function task(overrides: Partial<Task>): Task {
  return {
    id: overrides.id ?? 't-?',
    title: '',
    content: '',
    stage: 0,
    parentId: null,
    order: 0,
    rank: 0,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-01-01T00:00:00Z',
    displayId: overrides.id ?? 't-?',
    ...overrides,
  };
}

function connection(overrides: Partial<Connection> & { id: string; source: string; target: string }): Connection {
  return {
    updatedAt: '2026-01-01T00:00:00Z',
    deletedAt: null,
    ...overrides,
  };
}

describe('parent-child-connection-integrity — buildActiveParentChildEdgeSet', () => {
  it('只包含有 parentId 的活动任务', () => {
    const tasks = [
      task({ id: 'p1' }),
      task({ id: 'c1', parentId: 'p1' }),
      task({ id: 'c2', parentId: 'p1' }),
    ];
    const edges = buildActiveParentChildEdgeSet(tasks);
    expect(edges.has('p1->c1')).toBe(true);
    expect(edges.has('p1->c2')).toBe(true);
    expect(edges.size).toBe(2);
  });

  it('跳过已软删除任务', () => {
    const tasks = [
      task({ id: 'c1', parentId: 'p1', deletedAt: '2026-01-02T00:00:00Z' }),
      task({ id: 'c2', parentId: 'p1' }),
    ];
    const edges = buildActiveParentChildEdgeSet(tasks);
    expect(edges.has('p1->c1')).toBe(false);
    expect(edges.has('p1->c2')).toBe(true);
  });

  it('跳过自环（parentId === id）', () => {
    const tasks = [task({ id: 'a', parentId: 'a' })];
    expect(buildActiveParentChildEdgeSet(tasks).size).toBe(0);
  });

  it('跳过 parentId 为 null 的任务', () => {
    expect(buildActiveParentChildEdgeSet([task({ id: 'a', parentId: null })]).size).toBe(0);
  });

  it('空数组返回空 Set', () => {
    expect(buildActiveParentChildEdgeSet([]).size).toBe(0);
  });
});

describe('parent-child-connection-integrity — isParentChildDuplicateConnection', () => {
  it('命中已有父子边 → true', () => {
    const tasks = [task({ id: 'c', parentId: 'p' })];
    expect(isParentChildDuplicateConnection(tasks, 'p', 'c')).toBe(true);
  });

  it('方向不同（子→父）→ false', () => {
    const tasks = [task({ id: 'c', parentId: 'p' })];
    expect(isParentChildDuplicateConnection(tasks, 'c', 'p')).toBe(false);
  });

  it('任务已软删除 → false', () => {
    const tasks = [task({ id: 'c', parentId: 'p', deletedAt: '2026-02-01T00:00:00Z' })];
    expect(isParentChildDuplicateConnection(tasks, 'p', 'c')).toBe(false);
  });
});

describe('parent-child-connection-integrity — filterParentChildDuplicateConnections', () => {
  it('无父子边时直接返回原数组引用（性能友好）', () => {
    const tasks = [task({ id: 't1' })];
    const connections = [connection({ id: 'c1', source: 'a', target: 'b' })];
    const result = filterParentChildDuplicateConnections(tasks, connections);
    expect(result).toBe(connections);
  });

  it('过滤掉与活动父子关系重复的连接', () => {
    const tasks = [task({ id: 'c', parentId: 'p' })];
    const connections = [
      connection({ id: 'dup', source: 'p', target: 'c' }),
      connection({ id: 'other', source: 'x', target: 'y' }),
    ];
    const result = filterParentChildDuplicateConnections(tasks, connections);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('other');
  });

  it('已软删除的重复连接被保留（避免破坏可恢复状态）', () => {
    const tasks = [task({ id: 'c', parentId: 'p' })];
    const connections = [
      connection({ id: 'soft', source: 'p', target: 'c', deletedAt: '2026-02-01T00:00:00Z' }),
    ];
    const result = filterParentChildDuplicateConnections(tasks, connections);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('soft');
  });

  it('未发生变化时返回原引用', () => {
    const tasks = [task({ id: 'c', parentId: 'p' })];
    const connections = [connection({ id: 'other', source: 'x', target: 'y' })];
    const result = filterParentChildDuplicateConnections(tasks, connections);
    expect(result).toBe(connections);
  });
});

describe('parent-child-connection-integrity — softDeleteParentChildDuplicateConnections', () => {
  const NOW = '2026-04-01T12:00:00Z';

  it('无父子边时返回原引用', () => {
    const tasks = [task({ id: 't1' })];
    const connections = [connection({ id: 'c1', source: 'a', target: 'b' })];
    const result = softDeleteParentChildDuplicateConnections(tasks, connections, NOW);
    expect(result).toBe(connections);
  });

  it('对匹配的连接打上 deletedAt 与 updatedAt', () => {
    const tasks = [task({ id: 'c', parentId: 'p' })];
    const connections = [connection({ id: 'dup', source: 'p', target: 'c' })];
    const result = softDeleteParentChildDuplicateConnections(tasks, connections, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].deletedAt).toBe(NOW);
    expect(result[0].updatedAt).toBe(NOW);
    // 原数组未被就地修改
    expect(connections[0].deletedAt).toBeNull();
  });

  it('已有 deletedAt 的连接保持原样（不覆盖原有时间戳）', () => {
    const tasks = [task({ id: 'c', parentId: 'p' })];
    const original = connection({
      id: 'dup',
      source: 'p',
      target: 'c',
      deletedAt: '2026-01-01T00:00:00Z',
    });
    const result = softDeleteParentChildDuplicateConnections(tasks, [original], NOW);
    expect(result[0].deletedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('不匹配的活动连接保持原始对象引用不变', () => {
    const tasks = [task({ id: 'c', parentId: 'p' })];
    const keep = connection({ id: 'keep', source: 'x', target: 'y' });
    const result = softDeleteParentChildDuplicateConnections(tasks, [keep], NOW);
    expect(result[0]).toBe(keep);
  });

  it('无变化时返回原数组引用', () => {
    const tasks = [task({ id: 'c', parentId: 'p' })];
    const keep = connection({ id: 'k', source: 'x', target: 'y' });
    const connections = [keep];
    const result = softDeleteParentChildDuplicateConnections(tasks, connections, NOW);
    expect(result).toBe(connections);
  });
});
