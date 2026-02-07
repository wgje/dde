/**
 * TaskMoveService 单元测试
 *
 * 使用 Injector 隔离模式，无需 TestBed。
 * 覆盖：moveTaskToStage 四分支、边界校验、子树操作、辅助查询方法
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Injector } from '@angular/core';

import { TaskMoveService, MoveTaskParams } from './task-move.service';
import { LayoutService } from './layout.service';
import { SubtreeOperationsService } from './subtree-operations.service';
import { ProjectStateService } from './project-state.service';
import { TaskRecordTrackingService } from './task-record-tracking.service';
import { LoggerService } from './logger.service';
import { Project, Task, Connection } from '../models';
import { success, ErrorCodes } from '../utils/result';

// ─── 辅助工厂 ────────────────────────────────────────────────

function createTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? crypto.randomUUID(),
    title: overrides.title ?? 'T',
    content: overrides.content ?? '',
    stage: 'stage' in overrides ? (overrides.stage as number | null) : 1,
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
    hasIncompleteTask: overrides.hasIncompleteTask,
    deletedAt: overrides.deletedAt,
    deletedConnections: overrides.deletedConnections,
    deletedMeta: overrides.deletedMeta,
    attachments: overrides.attachments,
    tags: overrides.tags,
    priority: overrides.priority,
    dueDate: overrides.dueDate,
  };
}

function createProject(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? 'p1',
    name: overrides.name ?? 'P',
    description: overrides.description ?? '',
    createdDate: overrides.createdDate ?? now,
    tasks: overrides.tasks ?? [],
    connections: overrides.connections ?? [],
    updatedAt: overrides.updatedAt,
    version: overrides.version,
    viewState: overrides.viewState,
    flowchartUrl: overrides.flowchartUrl,
    flowchartThumbnailUrl: overrides.flowchartThumbnailUrl,
  };
}

// ─── Mock 工厂 ────────────────────────────────────────────────

function createMockLayoutService() {
  return {
    detectCycle: vi.fn().mockReturnValue(false),
    rebalance: vi.fn((p: Project) => p),
    getUnassignedPosition: vi.fn().mockReturnValue({ x: 100, y: 100 }),
    maxParentRank: vi.fn().mockReturnValue(0),
    minChildRank: vi.fn().mockReturnValue(Infinity),
    isStageRebalancing: vi.fn().mockReturnValue(false),
    computeInsertRank: vi.fn().mockReturnValue({ rank: 1500, needsRebalance: false }),
    applyRefusalStrategy: vi.fn().mockReturnValue({ ok: true, rank: 1500 }),
  };
}

function createMockSubtreeOps() {
  return {
    collectSubtreeIds: vi.fn().mockReturnValue(new Set<string>()),
    getSubtreeDepth: vi.fn().mockReturnValue(1),
    getMaxStageIndex: vi.fn().mockReturnValue(5),
    validateStageCapacity: vi.fn().mockReturnValue(success(undefined)),
    fixSubtreeRanks: vi.fn(),
    cascadeUpdateChildrenStage: vi.fn(),
    assignSubtreeToStage: vi.fn(),
    detachChildrenAsUnassigned: vi.fn().mockReturnValue(null),
    updateSubtreeStages: vi.fn(),
    computeNewRankForMigratedTask: vi.fn().mockReturnValue(2000),
    updateParentChildConnections: vi.fn().mockReturnValue([]),
  };
}

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockLoggerService = {
  category: vi.fn(() => mockLoggerCategory),
};

// ─── 测试主体 ────────────────────────────────────────────────

describe('TaskMoveService', () => {
  let service: TaskMoveService;
  let mockLayoutService: ReturnType<typeof createMockLayoutService>;
  let mockSubtreeOps: ReturnType<typeof createMockSubtreeOps>;
  let mockProjectState: { activeProject: ReturnType<typeof vi.fn>; getTask: ReturnType<typeof vi.fn> };
  let mockRecorder: { recordAndUpdate: ReturnType<typeof vi.fn>; recordAndUpdateDebounced: ReturnType<typeof vi.fn> };
  let activeProject: Project | null;
  let recordedMutators: Array<(p: Project) => Project>;
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
    // 静默控制台噪音
    consoleSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'debug').mockImplementation(() => {}),
    ];

    mockLayoutService = createMockLayoutService();
    mockSubtreeOps = createMockSubtreeOps();
    recordedMutators = [];
    activeProject = null;

    mockProjectState = {
      activeProject: vi.fn(() => activeProject),
      getTask: vi.fn((taskId: string) => activeProject?.tasks.find(t => t.id === taskId) ?? null),
    };

    mockRecorder = {
      recordAndUpdate: vi.fn((mutator: (p: Project) => Project) => {
        recordedMutators.push(mutator);
        if (activeProject) {
          activeProject = mutator(activeProject);
        }
      }),
      recordAndUpdateDebounced: vi.fn(),
    };

    const injector = Injector.create({
      providers: [
        { provide: TaskMoveService, useClass: TaskMoveService },
        { provide: LayoutService, useValue: mockLayoutService },
        { provide: SubtreeOperationsService, useValue: mockSubtreeOps },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: TaskRecordTrackingService, useValue: mockRecorder },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    });

    service = injector.get(TaskMoveService);
  });

  afterEach(() => {
    consoleSpies.forEach(s => s.mockRestore());
    vi.restoreAllMocks();
  });

  // ═══════════════════════════════════════════
  // moveTaskToStage — 公共入口校验
  // ═══════════════════════════════════════════

  describe('moveTaskToStage - 公共校验', () => {
    it('没有活动项目时返回 DATA_NOT_FOUND', () => {
      activeProject = null;
      const result = service.moveTaskToStage({ taskId: 'x', newStage: 1 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.DATA_NOT_FOUND);
      }
    });

    it('任务不存在时返回 DATA_NOT_FOUND', () => {
      activeProject = createProject({ tasks: [] });
      const result = service.moveTaskToStage({ taskId: 'missing', newStage: 1 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.DATA_NOT_FOUND);
      }
    });
  });

  // ═══════════════════════════════════════════
  // 分支 1: null → null (待分配区内部重组)
  // ═══════════════════════════════════════════

  describe('moveTaskToStage - 分支1: null→null (待分配区内部重组)', () => {
    it('成功更新父子关系', () => {
      const parent = createTask({ id: 'parent', stage: null });
      const child = createTask({ id: 'child', stage: null, parentId: null });
      activeProject = createProject({ tasks: [parent, child] });

      const result = service.moveTaskToStage({
        taskId: 'child',
        newStage: null,
        newParentId: 'parent',
      });

      expect(result.ok).toBe(true);
      // 验证 mutator 被调用
      expect(recordedMutators.length).toBe(1);
      // 验证任务 parentId 被更新
      const updatedChild = activeProject!.tasks.find(t => t.id === 'child');
      expect(updatedChild?.parentId).toBe('parent');
    });

    it('newParentId 为 null 时断开父子关系', () => {
      const parent = createTask({ id: 'parent', stage: null });
      const child = createTask({ id: 'child', stage: null, parentId: 'parent' });
      activeProject = createProject({ tasks: [parent, child] });

      const result = service.moveTaskToStage({
        taskId: 'child',
        newStage: null,
        newParentId: null,
      });

      expect(result.ok).toBe(true);
      const updatedChild = activeProject!.tasks.find(t => t.id === 'child');
      expect(updatedChild?.parentId).toBeNull();
    });

    it('目标父任务在已分配区时返回 CROSS_BOUNDARY_VIOLATION', () => {
      const parent = createTask({ id: 'parent', stage: 2 });
      const child = createTask({ id: 'child', stage: null });
      activeProject = createProject({ tasks: [parent, child] });

      const result = service.moveTaskToStage({
        taskId: 'child',
        newStage: null,
        newParentId: 'parent',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.CROSS_BOUNDARY_VIOLATION);
      }
    });

    it('会导致循环依赖时返回 LAYOUT_CYCLE_DETECTED', () => {
      mockLayoutService.detectCycle.mockReturnValue(true);
      const parent = createTask({ id: 'parent', stage: null });
      const child = createTask({ id: 'child', stage: null });
      activeProject = createProject({ tasks: [parent, child] });

      const result = service.moveTaskToStage({
        taskId: 'child',
        newStage: null,
        newParentId: 'parent',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.LAYOUT_CYCLE_DETECTED);
      }
    });

    it('目标父任务不存在时返回 DATA_NOT_FOUND', () => {
      const child = createTask({ id: 'child', stage: null });
      activeProject = createProject({ tasks: [child] });

      const result = service.moveTaskToStage({
        taskId: 'child',
        newStage: null,
        newParentId: 'nonexistent',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.DATA_NOT_FOUND);
      }
    });
  });

  // ═══════════════════════════════════════════
  // 分支 2: null → stage (浮动树整体分配)
  // ═══════════════════════════════════════════

  describe('moveTaskToStage - 分支2: null→stage (浮动树整体分配)', () => {
    it('成功将待分配任务分配到阶段', () => {
      const task = createTask({ id: 't1', stage: null });
      activeProject = createProject({ tasks: [task] });

      const result = service.moveTaskToStage({
        taskId: 't1',
        newStage: 1,
      });

      expect(result.ok).toBe(true);
      expect(mockSubtreeOps.validateStageCapacity).toHaveBeenCalledWith('t1', 1, expect.any(Array));
      expect(mockSubtreeOps.fixSubtreeRanks).toHaveBeenCalled();
    });

    it('阶段溢出时返回容量校验失败', () => {
      mockSubtreeOps.validateStageCapacity.mockReturnValue(
        { ok: false, error: { code: ErrorCodes.STAGE_OVERFLOW, message: '阶段已满' } }
      );
      const task = createTask({ id: 't1', stage: null });
      activeProject = createProject({ tasks: [task] });

      const result = service.moveTaskToStage({ taskId: 't1', newStage: 5 });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.STAGE_OVERFLOW);
      }
    });

    it('指定的新父任务在待分配区时返回 CROSS_BOUNDARY_VIOLATION', () => {
      const parent = createTask({ id: 'parent', stage: null });
      const child = createTask({ id: 'child', stage: null });
      activeProject = createProject({ tasks: [parent, child] });

      const result = service.moveTaskToStage({
        taskId: 'child',
        newStage: 2,
        newParentId: 'parent',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.CROSS_BOUNDARY_VIOLATION);
      }
    });

    it('新父任务阶段与目标阶段不匹配时返回 CROSS_BOUNDARY_VIOLATION', () => {
      const parent = createTask({ id: 'parent', stage: 3 }); // stage 3，但目标 stage=2，期望 parent.stage=1
      const child = createTask({ id: 'child', stage: null });
      activeProject = createProject({ tasks: [parent, child] });

      const result = service.moveTaskToStage({
        taskId: 'child',
        newStage: 2,
        newParentId: 'parent',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.CROSS_BOUNDARY_VIOLATION);
      }
    });
  });

  // ═══════════════════════════════════════════
  // 分支 3: stage → null (已分配树整体回收)
  // ═══════════════════════════════════════════

  describe('moveTaskToStage - 分支3: stage→null (已分配树整体回收)', () => {
    it('成功将子树移回待分配区', () => {
      const task = createTask({ id: 't1', stage: 2, parentId: 'p0' });
      activeProject = createProject({ tasks: [task] });
      mockSubtreeOps.collectSubtreeIds.mockReturnValue(new Set(['t1']));

      const result = service.moveTaskToStage({ taskId: 't1', newStage: null });

      expect(result.ok).toBe(true);
      expect(mockSubtreeOps.collectSubtreeIds).toHaveBeenCalledWith('t1', expect.any(Array));
      // 验证 root.parentId 被置空
      const updated = activeProject!.tasks.find(t => t.id === 't1');
      expect(updated?.stage).toBeNull();
      expect(updated?.parentId).toBeNull();
    });
  });

  // ═══════════════════════════════════════════
  // 分支 4: stage → stage (已分配任务阶段变更)
  // ═══════════════════════════════════════════

  describe('moveTaskToStage - 分支4: stage→stage (阶段变更)', () => {
    it('成功移动任务到新阶段', () => {
      const task = createTask({ id: 't1', stage: 1, rank: 1000 });
      activeProject = createProject({ tasks: [task] });

      const result = service.moveTaskToStage({ taskId: 't1', newStage: 2 });

      expect(result.ok).toBe(true);
      expect(mockSubtreeOps.cascadeUpdateChildrenStage).toHaveBeenCalled();
    });

    it('阶段正在重新排序时返回 LAYOUT_RANK_CONFLICT', () => {
      const task = createTask({ id: 't1', stage: 1 });
      activeProject = createProject({ tasks: [task] });

      // 设置 isStageRebalancing 返回 true
      mockLayoutService.isStageRebalancing.mockReturnValue(true);

      const result = service.moveTaskToStage({ taskId: 't1', newStage: 2 });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.LAYOUT_RANK_CONFLICT);
      }
    });

    it('移动时检测到循环依赖返回 LAYOUT_CYCLE_DETECTED', () => {
      mockLayoutService.detectCycle.mockReturnValue(true);
      const parent = createTask({ id: 'parent', stage: 1 });
      const child = createTask({ id: 'child', stage: 2, parentId: 'parent' });
      activeProject = createProject({ tasks: [parent, child] });

      const result = service.moveTaskToStage({
        taskId: 'child',
        newStage: 2,
        newParentId: 'parent',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.LAYOUT_CYCLE_DETECTED);
      }
    });

    it('放置策略拒绝时返回 LAYOUT_PARENT_CHILD_CONFLICT', () => {
      const task = createTask({ id: 't1', stage: 1 });
      activeProject = createProject({ tasks: [task] });

      mockLayoutService.applyRefusalStrategy.mockReturnValue({ ok: false, rank: 0 });

      const result = service.moveTaskToStage({ taskId: 't1', newStage: 2 });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.LAYOUT_PARENT_CHILD_CONFLICT);
      }
    });

    it('无效 parentId 会被自动清除', () => {
      // 父任务在 stage 3，但任务移到 stage 2（需要父在 stage 1 才合法），parentId 应被清除
      const parent = createTask({ id: 'parent', stage: 3 });
      const child = createTask({ id: 'child', stage: 1, parentId: 'parent' });
      activeProject = createProject({ tasks: [parent, child] });

      const result = service.moveTaskToStage({ taskId: 'child', newStage: 2 });

      expect(result.ok).toBe(true);
      const updated = activeProject!.tasks.find(t => t.id === 'child');
      expect(updated?.parentId).toBeNull();
    });
  });

  // ═══════════════════════════════════════════
  // getDirectChildren
  // ═══════════════════════════════════════════

  describe('getDirectChildren', () => {
    it('返回直接子任务（排除已删除）', () => {
      const parent = createTask({ id: 'p1', stage: 1 });
      const child1 = createTask({ id: 'c1', parentId: 'p1', stage: 2 });
      const child2 = createTask({ id: 'c2', parentId: 'p1', stage: 2, deletedAt: new Date().toISOString() });
      const child3 = createTask({ id: 'c3', parentId: 'p1', stage: 2 });
      activeProject = createProject({ tasks: [parent, child1, child2, child3] });

      const children = service.getDirectChildren('p1');

      expect(children).toHaveLength(2);
      expect(children.map(c => c.id)).toContain('c1');
      expect(children.map(c => c.id)).toContain('c3');
    });

    it('没有活动项目时返回空数组', () => {
      activeProject = null;
      expect(service.getDirectChildren('any')).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════
  // getUnassignedParent
  // ═══════════════════════════════════════════

  describe('getUnassignedParent', () => {
    it('返回待分配区的父任务 ID', () => {
      const parent = createTask({ id: 'up', stage: null });
      const child = createTask({ id: 'uc', stage: null, parentId: 'up' });
      activeProject = createProject({ tasks: [parent, child] });

      expect(service.getUnassignedParent('uc')).toBe('up');
    });

    it('父任务在已分配区时返回 null', () => {
      const parent = createTask({ id: 'ap', stage: 1 });
      const child = createTask({ id: 'uc', stage: null, parentId: 'ap' });
      activeProject = createProject({ tasks: [parent, child] });

      expect(service.getUnassignedParent('uc')).toBeNull();
    });

    it('任务自身在已分配区时返回 null', () => {
      const task = createTask({ id: 't1', stage: 1, parentId: null });
      activeProject = createProject({ tasks: [task] });

      expect(service.getUnassignedParent('t1')).toBeNull();
    });

    it('没有活动项目时返回 null', () => {
      activeProject = null;
      expect(service.getUnassignedParent('any')).toBeNull();
    });

    it('任务无父节点时返回 null', () => {
      const task = createTask({ id: 't1', stage: null, parentId: null });
      activeProject = createProject({ tasks: [task] });

      expect(service.getUnassignedParent('t1')).toBeNull();
    });
  });

  // ═══════════════════════════════════════════
  // detachTask
  // ═══════════════════════════════════════════

  describe('detachTask', () => {
    it('将任务分离到待分配区且子节点提升', () => {
      const grandParent = createTask({ id: 'gp', stage: 1, parentId: null });
      const parent = createTask({ id: 'p', stage: 2, parentId: 'gp' });
      const child = createTask({ id: 'c', stage: 3, parentId: 'p' });
      activeProject = createProject({ tasks: [grandParent, parent, child] });

      service.detachTask('p');

      const updatedParent = activeProject!.tasks.find(t => t.id === 'p');
      const updatedChild = activeProject!.tasks.find(t => t.id === 'c');

      // 被分离的任务移到待分配区
      expect(updatedParent?.stage).toBeNull();
      expect(updatedParent?.parentId).toBeNull();
      // 子节点提升到祖父节点下
      expect(updatedChild?.parentId).toBe('gp');
    });

    it('任务不存在时不出错', () => {
      activeProject = createProject({ tasks: [] });
      service.detachTask('nonexistent');
      // 不抛异常即可
      expect(recordedMutators.length).toBe(1);
    });
  });

  // ═══════════════════════════════════════════
  // deleteTaskKeepChildren
  // ═══════════════════════════════════════════

  describe('deleteTaskKeepChildren', () => {
    it('删除任务，子节点提升，相关连接移除', () => {
      const parent = createTask({ id: 'p', stage: 1, parentId: null });
      const target = createTask({ id: 't', stage: 2, parentId: 'p' });
      const child = createTask({ id: 'c', stage: 3, parentId: 't' });
      const conn: Connection = { id: 'conn1', source: 't', target: 'c' };
      const otherConn: Connection = { id: 'conn2', source: 'p', target: 'c' };
      activeProject = createProject({
        tasks: [parent, target, child],
        connections: [conn, otherConn],
      });

      service.deleteTaskKeepChildren('t');

      // 目标任务被删除
      expect(activeProject!.tasks.find(t => t.id === 't')).toBeUndefined();
      // 子节点提升到父节点下
      const updatedChild = activeProject!.tasks.find(t => t.id === 'c');
      expect(updatedChild?.parentId).toBe('p');
      // 与被删除任务相关的连接被移除
      expect(activeProject!.connections.find(c => c.id === 'conn1')).toBeUndefined();
      // 无关连接保留
      expect(activeProject!.connections.find(c => c.id === 'conn2')).toBeDefined();
    });

    it('没有活动项目时静默返回', () => {
      activeProject = null;
      service.deleteTaskKeepChildren('any');
      expect(recordedMutators.length).toBe(0);
    });
  });

  // ═══════════════════════════════════════════
  // moveSubtreeToNewParent
  // ═══════════════════════════════════════════

  describe('moveSubtreeToNewParent', () => {
    it('成功迁移子树到新父节点', () => {
      const oldParent = createTask({ id: 'op', stage: 1 });
      const newParent = createTask({ id: 'np', stage: 1 });
      const task = createTask({ id: 't1', stage: 2, parentId: 'op' });
      activeProject = createProject({ tasks: [oldParent, newParent, task] });
      mockSubtreeOps.collectSubtreeIds.mockReturnValue(new Set(['t1']));

      const result = service.moveSubtreeToNewParent('t1', 'np');

      expect(result.ok).toBe(true);
      expect(mockSubtreeOps.updateSubtreeStages).toHaveBeenCalled();
      expect(mockSubtreeOps.computeNewRankForMigratedTask).toHaveBeenCalled();
      expect(mockSubtreeOps.updateParentChildConnections).toHaveBeenCalled();
    });

    it('新旧父节点相同时直接返回成功', () => {
      const parent = createTask({ id: 'p', stage: 1 });
      const task = createTask({ id: 't1', stage: 2, parentId: 'p' });
      activeProject = createProject({ tasks: [parent, task] });

      const result = service.moveSubtreeToNewParent('t1', 'p');

      expect(result.ok).toBe(true);
      expect(recordedMutators.length).toBe(0); // 无需执行 mutator
    });

    it('检测到循环依赖时返回 LAYOUT_CYCLE_DETECTED', () => {
      mockLayoutService.detectCycle.mockReturnValue(true);
      const parent = createTask({ id: 'p', stage: 1 });
      const task = createTask({ id: 't1', stage: 2, parentId: null });
      activeProject = createProject({ tasks: [parent, task] });

      const result = service.moveSubtreeToNewParent('t1', 'p');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.LAYOUT_CYCLE_DETECTED);
      }
    });

    it('没有活动项目时返回 DATA_NOT_FOUND', () => {
      activeProject = null;
      const result = service.moveSubtreeToNewParent('t1', 'p');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.DATA_NOT_FOUND);
      }
    });

    it('目标任务不存在时返回 DATA_NOT_FOUND', () => {
      activeProject = createProject({ tasks: [] });
      const result = service.moveSubtreeToNewParent('missing', 'p');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.DATA_NOT_FOUND);
      }
    });

    it('迁移到 null 父节点（根级）成功', () => {
      const parent = createTask({ id: 'p', stage: 1 });
      const task = createTask({ id: 't1', stage: 2, parentId: 'p' });
      activeProject = createProject({ tasks: [parent, task] });
      mockSubtreeOps.collectSubtreeIds.mockReturnValue(new Set(['t1']));

      const result = service.moveSubtreeToNewParent('t1', null);

      expect(result.ok).toBe(true);
      const updated = activeProject!.tasks.find(t => t.id === 't1');
      expect(updated?.parentId).toBeNull();
    });
  });

  // ═══════════════════════════════════════════
  // replaceChildSubtreeWithUnassigned
  // ═══════════════════════════════════════════

  describe('replaceChildSubtreeWithUnassigned', () => {
    it('成功执行替换操作', () => {
      const source = createTask({ id: 'src', stage: 1 });
      const target = createTask({ id: 'tgt', stage: null });
      activeProject = createProject({ tasks: [source, target] });
      mockSubtreeOps.collectSubtreeIds.mockReturnValue(new Set(['tgt']));

      const result = service.replaceChildSubtreeWithUnassigned('src', 'tgt');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveProperty('detachedSubtreeRootId');
      }
      expect(mockSubtreeOps.assignSubtreeToStage).toHaveBeenCalled();
    });

    it('没有活动项目时返回 DATA_NOT_FOUND', () => {
      activeProject = null;
      const result = service.replaceChildSubtreeWithUnassigned('src', 'tgt');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.DATA_NOT_FOUND);
      }
    });

    it('源任务在待分配区时返回 VALIDATION_ERROR', () => {
      const source = createTask({ id: 'src', stage: null });
      const target = createTask({ id: 'tgt', stage: null });
      activeProject = createProject({ tasks: [source, target] });

      const result = service.replaceChildSubtreeWithUnassigned('src', 'tgt');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
      }
    });

    it('目标任务在已分配区时返回 VALIDATION_ERROR', () => {
      const source = createTask({ id: 'src', stage: 1 });
      const target = createTask({ id: 'tgt', stage: 2 });
      activeProject = createProject({ tasks: [source, target] });

      const result = service.replaceChildSubtreeWithUnassigned('src', 'tgt');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
      }
    });
  });

  // ═══════════════════════════════════════════
  // assignUnassignedToTask
  // ═══════════════════════════════════════════

  describe('assignUnassignedToTask', () => {
    it('成功将待分配块分配给任务', () => {
      const source = createTask({ id: 'src', stage: 1 });
      const target = createTask({ id: 'tgt', stage: null });
      activeProject = createProject({ tasks: [source, target] });
      mockSubtreeOps.collectSubtreeIds.mockReturnValue(new Set(['tgt']));

      const result = service.assignUnassignedToTask('src', 'tgt');

      expect(result.ok).toBe(true);
      expect(mockSubtreeOps.assignSubtreeToStage).toHaveBeenCalled();
      expect(mockSubtreeOps.fixSubtreeRanks).toHaveBeenCalled();
    });

    it('没有活动项目时返回 DATA_NOT_FOUND', () => {
      activeProject = null;
      const result = service.assignUnassignedToTask('src', 'tgt');
      expect(result.ok).toBe(false);
    });

    it('源任务在待分配区时返回 VALIDATION_ERROR', () => {
      const source = createTask({ id: 'src', stage: null });
      const target = createTask({ id: 'tgt', stage: null });
      activeProject = createProject({ tasks: [source, target] });

      const result = service.assignUnassignedToTask('src', 'tgt');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
      }
    });

    it('目标任务在已分配区时返回 VALIDATION_ERROR', () => {
      const source = createTask({ id: 'src', stage: 1 });
      const target = createTask({ id: 'tgt', stage: 2 });
      activeProject = createProject({ tasks: [source, target] });

      const result = service.assignUnassignedToTask('src', 'tgt');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
      }
    });
  });
});
