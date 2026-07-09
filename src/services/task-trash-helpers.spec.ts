import { describe, expect, it } from 'vitest';
import { Task, Connection, Project } from '../models';
import {
  applyTrashRestoreMutation,
  buildTrashChildrenByParent,
  collectTrashCascadeTaskIds,
  collectTrashSubtreeIds,
  groupTrashConnectionsByTaskId,
} from './task-trash-helpers';

function task(
  id: string,
  parentId: string | null = null,
  deletedAt: string | null = null,
  overrides: Partial<Task> = {},
): Task {
  return {
    id,
    title: id,
    content: '',
    stage: 1,
    parentId,
    order: 0,
    rank: 10000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    displayId: id,
    deletedAt,
    ...overrides,
  };
}

describe('task-trash-helpers', () => {
  it('级联收集会跳过已删除任务及其子树', () => {
    const tasks = [
      task('root'),
      task('child', 'root'),
      task('deleted-child', 'root', '2026-01-02T00:00:00.000Z'),
      task('grandchild', 'deleted-child'),
    ];
    const tasksById = new Map(tasks.map(item => [item.id, item] as const));
    const childrenByParent = buildTrashChildrenByParent(tasks, false);

    expect(collectTrashCascadeTaskIds(['root'], tasksById, childrenByParent)).toEqual(
      new Set(['root', 'child']),
    );
  });

  it('子树收集使用迭代遍历并避免重复节点', () => {
    const childrenByParent = new Map<string, Task[]>([
      ['root', [task('child-a', 'root'), task('child-b', 'root')]],
      ['child-a', [task('leaf', 'child-a')]],
      ['child-b', [task('leaf', 'child-b')]],
    ]);

    expect(collectTrashSubtreeIds('root', childrenByParent)).toEqual(
      new Set(['root', 'child-a', 'child-b', 'leaf']),
    );
  });

  it('按任务 ID 分组连接时 source 与 target 都可查到同一连接', () => {
    const connection: Connection = {
      id: 'conn-1',
      source: 'task-a',
      target: 'task-b',
    };

    const grouped = groupTrashConnectionsByTaskId([connection]);

    expect(grouped.get('task-a')).toEqual([connection]);
    expect(grouped.get('task-b')).toEqual([connection]);
  });

  it('恢复 mutation 会还原删除元数据并返回恢复的连接 ID', () => {
    const connection: Connection = {
      id: 'conn-restore',
      source: 'root',
      target: 'child',
    };
    const root = task('root', null, '2026-01-02T00:00:00.000Z', {
      deletedConnections: [connection],
      deletedMeta: {
        parentId: null,
        stage: 2,
        order: 7,
        rank: 70000,
        x: 12,
        y: 34,
        parkingMeta: null,
      },
      stage: null,
    });
    const child = task('child', 'root', '2026-01-02T00:00:00.000Z', {
      deletedMeta: {
        parentId: 'root',
        stage: 3,
        order: 8,
        rank: 80000,
        x: 56,
        y: 78,
        parkingMeta: null,
      },
      stage: null,
    });
    const rebalance = (project: Project) => ({
      ...project,
      name: 'rebalanced',
    });

    const result = applyTrashRestoreMutation({
      idsToRestore: new Set(['root', 'child']),
      now: '2026-01-03T00:00:00.000Z',
      project: {
        id: 'project-1',
        name: 'Project',
        description: '',
        createdDate: '2026-01-01T00:00:00.000Z',
        tasks: [root, child],
        connections: [],
      },
      rebalance,
      savedConnections: [connection],
    });

    expect(result.restoredConnectionIds).toEqual(['conn-restore']);
    expect(result.project.name).toBe('rebalanced');
    expect(result.project.connections).toEqual([connection]);
    expect(result.project.tasks).toEqual([
      expect.objectContaining({
        id: 'root',
        deletedAt: null,
        stage: 2,
        order: 7,
        rank: 70000,
        x: 12,
        y: 34,
      }),
      expect.objectContaining({
        id: 'child',
        deletedAt: null,
        parentId: 'root',
        stage: 3,
      }),
    ]);
  });
});
