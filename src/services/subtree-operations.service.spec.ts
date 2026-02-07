import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Injector } from '@angular/core';
import { SubtreeOperationsService } from './subtree-operations.service';
import { LayoutService } from './layout.service';
import { Task, Connection } from '../models';
import { LAYOUT_CONFIG, FLOATING_TREE_CONFIG } from '../config/layout.config';

function createTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? crypto.randomUUID(),
    title: overrides.title ?? 'Task',
    content: overrides.content ?? '',
    stage: 'stage' in overrides ? overrides.stage! : 1,
    parentId: overrides.parentId ?? null,
    order: overrides.order ?? 1,
    rank: overrides.rank ?? 1000,
    status: overrides.status ?? 'active',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    createdDate: overrides.createdDate ?? now,
    updatedAt: overrides.updatedAt ?? now,
    displayId: overrides.displayId ?? '?',
    shortId: overrides.shortId,
    deletedAt: overrides.deletedAt,
  };
}

describe('SubtreeOperationsService', () => {
  let service: SubtreeOperationsService;
  let mockLayoutService: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    mockLayoutService = {
      getUnassignedPosition: vi.fn().mockReturnValue({ x: 0, y: 0 }),
    };

    const injector = Injector.create({
      providers: [
        { provide: SubtreeOperationsService, useClass: SubtreeOperationsService },
        { provide: LayoutService, useValue: mockLayoutService },
      ],
    });

    service = injector.get(SubtreeOperationsService);
  });

  describe('collectSubtreeIds', () => {
    it('收集任务及其所有后代 ID', () => {
      const tasks = [
        createTask({ id: 'root', stage: 1 }),
        createTask({ id: 'child-1', parentId: 'root', stage: 2 }),
        createTask({ id: 'child-2', parentId: 'root', stage: 2 }),
        createTask({ id: 'grandchild', parentId: 'child-1', stage: 3 }),
        createTask({ id: 'unrelated', stage: 1 }),
      ];

      const ids = service.collectSubtreeIds('root', tasks);
      expect(ids.size).toBe(4);
      expect(ids.has('root')).toBe(true);
      expect(ids.has('child-1')).toBe(true);
      expect(ids.has('child-2')).toBe(true);
      expect(ids.has('grandchild')).toBe(true);
      expect(ids.has('unrelated')).toBe(false);
    });

    it('叶节点只返回自身', () => {
      const tasks = [createTask({ id: 'leaf', stage: 1 })];
      const ids = service.collectSubtreeIds('leaf', tasks);
      expect(ids.size).toBe(1);
      expect(ids.has('leaf')).toBe(true);
    });
  });

  describe('getSubtreeDepth', () => {
    it('叶节点深度为 0', () => {
      const tasks = [createTask({ id: 'leaf', stage: 1 })];
      expect(service.getSubtreeDepth('leaf', tasks)).toBe(0);
    });

    it('计算多层子树深度', () => {
      const tasks = [
        createTask({ id: 'root', stage: 1 }),
        createTask({ id: 'c1', parentId: 'root', stage: 2 }),
        createTask({ id: 'gc1', parentId: 'c1', stage: 3 }),
        createTask({ id: 'ggc1', parentId: 'gc1', stage: 4 }),
      ];
      expect(service.getSubtreeDepth('root', tasks)).toBe(3);
    });

    it('跳过软删除节点', () => {
      const tasks = [
        createTask({ id: 'root', stage: 1 }),
        createTask({ id: 'c1', parentId: 'root', stage: 2, deletedAt: new Date().toISOString() }),
        createTask({ id: 'gc1', parentId: 'c1', stage: 3 }),
      ];
      expect(service.getSubtreeDepth('root', tasks)).toBe(0);
    });
  });

  describe('getMaxStageIndex', () => {
    it('返回当前最大 stage + STAGE_BUFFER', () => {
      const tasks = [
        createTask({ id: '1', stage: 3 }),
        createTask({ id: '2', stage: 5 }),
        createTask({ id: '3', stage: 1 }),
      ];
      expect(service.getMaxStageIndex(tasks)).toBe(5 + FLOATING_TREE_CONFIG.STAGE_BUFFER);
    });

    it('无 stage 任务时返回 STAGE_BUFFER', () => {
      const tasks = [createTask({ id: '1', stage: null })];
      expect(service.getMaxStageIndex(tasks)).toBe(FLOATING_TREE_CONFIG.STAGE_BUFFER);
    });
  });

  describe('validateStageCapacity', () => {
    it('子树不会溢出时返回成功', () => {
      const tasks = [
        createTask({ id: 'root', stage: 1 }),
        createTask({ id: 'c1', parentId: 'root', stage: 2 }),
      ];
      const result = service.validateStageCapacity('root', 1, tasks);
      expect(result.ok).toBe(true);
    });

    it('子树会溢出时返回 STAGE_OVERFLOW', () => {
      // maxStageIndex = 2 + STAGE_BUFFER(10) = 12
      // targetStage(10) + depth(3) = 13 > 12
      const tasks = [
        createTask({ id: 'root', stage: 2 }),
        createTask({ id: 'c1', parentId: 'root', stage: null }),
        createTask({ id: 'gc1', parentId: 'c1', stage: null }),
        createTask({ id: 'ggc1', parentId: 'gc1', stage: null }),
      ];
      const result = service.validateStageCapacity('root', 10, tasks);
      expect(result.ok).toBe(false);
    });
  });

  describe('validateParentChildStageConsistency', () => {
    it('父子同在待分配区时返回成功', () => {
      const tasks = [createTask({ id: 'parent', stage: null })];
      const result = service.validateParentChildStageConsistency('parent', null, tasks);
      expect(result.ok).toBe(true);
    });

    it('父子同在分配区且阶段关系正确时返回成功', () => {
      const tasks = [createTask({ id: 'parent', stage: 1 })];
      const result = service.validateParentChildStageConsistency('parent', 2, tasks);
      expect(result.ok).toBe(true);
    });

    it('父在待分配区但子在分配区时返回 CROSS_BOUNDARY_VIOLATION', () => {
      const tasks = [createTask({ id: 'parent', stage: null })];
      const result = service.validateParentChildStageConsistency('parent', 1, tasks);
      expect(result.ok).toBe(false);
    });

    it('子阶段不是父阶段+1时返回 CROSS_BOUNDARY_VIOLATION', () => {
      const tasks = [createTask({ id: 'parent', stage: 1 })];
      const result = service.validateParentChildStageConsistency('parent', 3, tasks);
      expect(result.ok).toBe(false);
    });

    it('无 parentId 时返回成功', () => {
      const result = service.validateParentChildStageConsistency(null, 1, []);
      expect(result.ok).toBe(true);
    });

    it('父不存在时返回成功', () => {
      const result = service.validateParentChildStageConsistency('nonexistent', 1, []);
      expect(result.ok).toBe(true);
    });
  });

  describe('fixSubtreeRanks', () => {
    it('修复子节点 rank 使其大于父节点', () => {
      const tasks = [
        createTask({ id: 'root', rank: 2000 }),
        createTask({ id: 'child', parentId: 'root', rank: 500 }), // rank < parent
      ];
      service.fixSubtreeRanks('root', tasks);
      const child = tasks.find(t => t.id === 'child')!;
      expect(child.rank).toBeGreaterThan(2000);
    });

    it('子节点 rank 已正确时不修改', () => {
      const tasks = [
        createTask({ id: 'root', rank: 1000 }),
        createTask({ id: 'child', parentId: 'root', rank: 5000 }),
      ];
      service.fixSubtreeRanks('root', tasks);
      expect(tasks.find(t => t.id === 'child')!.rank).toBe(5000);
    });

    it('不存在根任务时静默返回', () => {
      expect(() => service.fixSubtreeRanks('nonexistent', [])).not.toThrow();
    });
  });

  describe('wouldCreateCycle', () => {
    it('检测到循环依赖时返回 true', () => {
      const tasks = [
        createTask({ id: 'A', parentId: 'B' }),
        createTask({ id: 'B', parentId: 'C' }),
        createTask({ id: 'C' }),
      ];
      // Moving C under A would create: C -> A -> B -> C (cycle)
      const result = service.wouldCreateCycle('C', 'A', 'A', tasks);
      expect(result).toBe(true);
    });

    it('无循环时返回 false', () => {
      const tasks = [
        createTask({ id: 'A' }),
        createTask({ id: 'B' }),
        createTask({ id: 'C' }),
      ];
      const result = service.wouldCreateCycle('A', 'B', 'C', tasks);
      expect(result).toBe(false);
    });
  });

  describe('cascadeUpdateChildrenStage', () => {
    it('级联更新所有子任务的 stage', () => {
      const tasks = [
        createTask({ id: 'root', stage: 3 }),
        createTask({ id: 'c1', parentId: 'root', stage: 2 }),
        createTask({ id: 'gc1', parentId: 'c1', stage: 3 }),
      ];
      service.cascadeUpdateChildrenStage('root', 3, tasks);
      expect(tasks.find(t => t.id === 'c1')!.stage).toBe(4); // 3+1
      expect(tasks.find(t => t.id === 'gc1')!.stage).toBe(5); // 4+1
    });

    it('跳过软删除任务', () => {
      const tasks = [
        createTask({ id: 'root', stage: 1 }),
        createTask({ id: 'c1', parentId: 'root', stage: 2, deletedAt: '2024-01-01' }),
      ];
      service.cascadeUpdateChildrenStage('root', 1, tasks);
      expect(tasks.find(t => t.id === 'c1')!.stage).toBe(2); // unchanged
    });
  });

  describe('assignSubtreeToStage', () => {
    it('将待分配子树整体分配到目标阶段', () => {
      const tasks = [
        createTask({ id: 'source', stage: 1 }),
        createTask({ id: 'target', stage: null }),
        createTask({ id: 'tc1', parentId: 'target', stage: null }),
      ];
      service.assignSubtreeToStage('target', 'source', 2, tasks);

      expect(tasks.find(t => t.id === 'target')!.stage).toBe(2);
      expect(tasks.find(t => t.id === 'target')!.parentId).toBe('source');
      expect(tasks.find(t => t.id === 'tc1')!.stage).toBe(3);
    });
  });

  describe('detachChildrenAsUnassigned', () => {
    it('将子任务剥离为待分配任务', () => {
      const tasks = [
        createTask({ id: 'root', stage: 1 }),
        createTask({ id: 'c1', parentId: 'root', stage: 2 }),
        createTask({ id: 'gc1', parentId: 'c1', stage: 3 }),
      ];
      const children = [tasks.find(t => t.id === 'c1')!];
      const rootId = service.detachChildrenAsUnassigned(children, tasks);

      expect(rootId).toBe('c1');
      expect(tasks.find(t => t.id === 'c1')!.stage).toBe(null);
      expect(tasks.find(t => t.id === 'c1')!.parentId).toBe(null);
      expect(tasks.find(t => t.id === 'gc1')!.stage).toBe(null);
    });

    it('空列表返回 null', () => {
      expect(service.detachChildrenAsUnassigned([], [])).toBe(null);
    });
  });

  describe('updateSubtreeStages', () => {
    it('按偏移量更新子树 stage', () => {
      const tasks = [
        createTask({ id: 'a', stage: 2 }),
        createTask({ id: 'b', stage: 3 }),
        createTask({ id: 'c', stage: null }),
      ];
      service.updateSubtreeStages(new Set(['a', 'b', 'c']), 5, tasks);
      expect(tasks.find(t => t.id === 'a')!.stage).toBe(7);
      expect(tasks.find(t => t.id === 'b')!.stage).toBe(8);
      expect(tasks.find(t => t.id === 'c')!.stage).toBe(null); // null stays null
    });
  });

  describe('computeNewRankForMigratedTask', () => {
    it('无父节点时放在 stage 1 根末尾', () => {
      const tasks = [
        createTask({ id: 'r1', stage: 1, parentId: null, rank: 1000 }),
        createTask({ id: 'r2', stage: 1, parentId: null, rank: 2000 }),
        createTask({ id: 'moved', stage: 1, rank: 500 }),
      ];
      const rank = service.computeNewRankForMigratedTask('moved', null, tasks);
      expect(rank).toBe(2000 + LAYOUT_CONFIG.RANK_STEP);
    });

    it('有父节点时 rank 在父后兄弟末尾', () => {
      const tasks = [
        createTask({ id: 'parent', stage: 1, rank: 1000 }),
        createTask({ id: 'sib', parentId: 'parent', stage: 2, rank: 2000 }),
        createTask({ id: 'moved', stage: 2, rank: 500 }),
      ];
      const rank = service.computeNewRankForMigratedTask('moved', 'parent', tasks);
      expect(rank).toBe(2000 + LAYOUT_CONFIG.RANK_STEP);
    });

    it('无兄弟时 rank 为父 rank + RANK_STEP', () => {
      const tasks = [
        createTask({ id: 'parent', stage: 1, rank: 1000 }),
        createTask({ id: 'moved', stage: 2, rank: 500 }),
      ];
      const rank = service.computeNewRankForMigratedTask('moved', 'parent', tasks);
      expect(rank).toBe(1000 + LAYOUT_CONFIG.RANK_STEP);
    });
  });

  describe('updateParentChildConnections', () => {
    it('移除旧连接并添加新连接', () => {
      const connections: Connection[] = [
        { id: 'c1', source: 'oldParent', target: 'task1' },
        { id: 'c2', source: 'x', target: 'y' },
      ];
      const result = service.updateParentChildConnections('task1', 'oldParent', 'newParent', connections);

      expect(result.length).toBe(2); // c2 + new
      expect(result.some(c => c.source === 'oldParent' && c.target === 'task1')).toBe(false);
      expect(result.some(c => c.source === 'newParent' && c.target === 'task1')).toBe(true);
    });

    it('新父节点为 null 时只移除旧连接', () => {
      const connections: Connection[] = [
        { id: 'c1', source: 'oldParent', target: 'task1' },
      ];
      const result = service.updateParentChildConnections('task1', 'oldParent', null, connections);
      expect(result.length).toBe(0);
    });

    it('不重复添加已存在的连接', () => {
      const connections: Connection[] = [
        { id: 'c1', source: 'parent', target: 'task1' },
      ];
      const result = service.updateParentChildConnections('task1', null, 'parent', connections);
      expect(result.length).toBe(1);
    });
  });
});
