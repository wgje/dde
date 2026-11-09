/**
 * TaskMoveService 单元测试
 *
 * 使用 Injector 隔离模式，无需 TestBed。
 * 覆盖：moveTaskToStage 四分支、边界校验、子树操作、辅助查询方法
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Injector } from '@angular/core';

import {
  TaskMoveService,
  MoveTaskParams,
} from './task-move.service';
import { LayoutService } from './layout.service';
import { SubtreeOperationsService } from './subtree-operations.service';
import { ProjectStateService } from './project-state.service';
import { TaskRecordTrackingService } from './task-record-tracking.service';
import { LoggerService } from './logger.service';
import { Project, Task, Connection } from '../models';
import { success, ErrorCodes } from '../utils/result';
import { registerTaskMoveAssignmentSpecs } from './task-move-assignment.spec-helpers';
import { registerTaskMoveTreeReparentSpecs } from './task-move-tree-reparent.spec-helpers';

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
  let mockRecorder: {
    recordAndUpdate: ReturnType<typeof vi.fn>;
    recordAndUpdateDebounced: ReturnType<typeof vi.fn>;
    recordAndUpdateDurably: ReturnType<typeof vi.fn>;
  };
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
      recordAndUpdateDurably: vi.fn(async (
        mutator: (p: Project) => Project,
        _options?: { updateType?: 'content' | 'structure' | 'position' },
      ) => {
        recordedMutators.push(mutator);
        if (activeProject) {
          activeProject = mutator(activeProject);
        }
        return true;
      }),
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

  it('只保留 durable 移动路径，不再维护未调用的同步私有 helper', () => {
    const source = readFileSync(join(__dirname, 'task-move.service.ts'), 'utf8');

    expect(source).toContain('moveTaskToStageDurably');
    expect(source).not.toMatch(/\n\s+private reparentWithinUnassigned\(/);
    expect(source).not.toMatch(/\n\s+private assignUnassignedSubtree\(/);
    expect(source).not.toMatch(/\n\s+private detachSubtreeToUnassigned\(/);
    expect(source).not.toMatch(/\n\s+private moveAssignedTaskToStage\(/);
  });

  describe('moveTaskToStage - 公共校验', () => {
    it('没有活动项目时返回 DATA_NOT_FOUND', async () => {
      activeProject = null;
      const result = await service.moveTaskToStage({ taskId: 'x', newStage: 1 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.DATA_NOT_FOUND);
      }
    });

    it('任务不存在时返回 DATA_NOT_FOUND', async () => {
      activeProject = createProject({ tasks: [] });
      const result = await service.moveTaskToStage({ taskId: 'missing', newStage: 1 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.DATA_NOT_FOUND);
      }
    });
  });

  describe('moveTaskToStageAtPositionDurably', () => {
    it('已分配任务结构移动和落点坐标应在同一次 durable mutator 中提交', async () => {
      const parent = createTask({ id: 'parent-1', stage: 1, parentId: null, rank: 1000 });
      const moved = createTask({ id: 'task-1', stage: 2, parentId: null, rank: 1100, x: 10, y: 20 });
      const before = createTask({ id: 'before-1', stage: 2, parentId: 'parent-1', rank: 2000 });
      activeProject = createProject({ tasks: [parent, moved, before] });

      const result = await service.moveTaskToStageAtPositionDurably({
        taskId: 'task-1',
        newStage: 2,
        beforeTaskId: 'before-1',
        newParentId: 'parent-1',
        x: 80,
        y: 160,
      });

      expect(result.ok).toBe(true);
      expect(mockRecorder.recordAndUpdateDurably).toHaveBeenCalledTimes(1);
      expect(mockRecorder.recordAndUpdateDurably).toHaveBeenCalledWith(
        expect.any(Function),
        { updateType: 'structure' },
      );
      const taskAfter = activeProject?.tasks.find(task => task.id === 'task-1');
      expect(taskAfter).toMatchObject({
        stage: 2,
        parentId: 'parent-1',
        rank: 1500,
        x: 80,
        y: 160,
      });
    });
  });

  // ═══════════════════════════════════════════
  // 分支 1: null → null (待分配区内部重组)
  // ═══════════════════════════════════════════

  describe('moveTaskToStage - 分支1: null→null (待分配区内部重组)', () => {
    it('成功更新父子关系', async () => {
      const parent = createTask({ id: 'parent', stage: null });
      const child = createTask({ id: 'child', stage: null, parentId: null });
      activeProject = createProject({ tasks: [parent, child] });

      const result = await service.moveTaskToStage({
        taskId: 'child',
        newStage: null,
        newParentId: 'parent',
      });

      expect(result.ok).toBe(true);
      expect(mockRecorder.recordAndUpdateDurably).toHaveBeenCalledWith(
        expect.any(Function),
        { updateType: 'structure' },
      );
      expect(mockRecorder.recordAndUpdate).not.toHaveBeenCalled();
      const updatedChild = activeProject!.tasks.find(t => t.id === 'child');
      expect(updatedChild?.parentId).toBe('parent');
    });

    it('newParentId 为 null 时断开父子关系', async () => {
      const parent = createTask({ id: 'parent', stage: null });
      const child = createTask({ id: 'child', stage: null, parentId: 'parent' });
      activeProject = createProject({ tasks: [parent, child] });

      const result = await service.moveTaskToStage({
        taskId: 'child',
        newStage: null,
        newParentId: null,
      });

      expect(result.ok).toBe(true);
      const updatedChild = activeProject!.tasks.find(t => t.id === 'child');
      expect(updatedChild?.parentId).toBeNull();
    });

    it('目标父任务在已分配区时返回 CROSS_BOUNDARY_VIOLATION', async () => {
      const parent = createTask({ id: 'parent', stage: 2 });
      const child = createTask({ id: 'child', stage: null });
      activeProject = createProject({ tasks: [parent, child] });

      const result = await service.moveTaskToStage({
        taskId: 'child',
        newStage: null,
        newParentId: 'parent',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.CROSS_BOUNDARY_VIOLATION);
      }
    });

    it('会导致循环依赖时返回 LAYOUT_CYCLE_DETECTED', async () => {
      mockLayoutService.detectCycle.mockReturnValue(true);
      const parent = createTask({ id: 'parent', stage: null });
      const child = createTask({ id: 'child', stage: null });
      activeProject = createProject({ tasks: [parent, child] });

      const result = await service.moveTaskToStage({
        taskId: 'child',
        newStage: null,
        newParentId: 'parent',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.LAYOUT_CYCLE_DETECTED);
      }
    });

    it('目标父任务不存在时返回 DATA_NOT_FOUND', async () => {
      const child = createTask({ id: 'child', stage: null });
      activeProject = createProject({ tasks: [child] });

      const result = await service.moveTaskToStage({
        taskId: 'child',
        newStage: null,
        newParentId: 'nonexistent',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.DATA_NOT_FOUND);
      }
    });

    it('moveTaskToStageDurably 先写入本地持久化队列再更新待分配父子关系', async () => {
      const parent = createTask({ id: 'parent', stage: null });
      const child = createTask({ id: 'child', stage: null, parentId: null });
      activeProject = createProject({ tasks: [parent, child] });

      const result = await service.moveTaskToStageDurably({
        taskId: 'child',
        newStage: null,
        newParentId: 'parent',
      });

      expect(result.ok).toBe(true);
      expect(mockRecorder.recordAndUpdateDurably).toHaveBeenCalledWith(
        expect.any(Function),
        { updateType: 'structure' },
      );
      expect(mockRecorder.recordAndUpdate).not.toHaveBeenCalled();
      expect(activeProject!.tasks.find(t => t.id === 'child')?.parentId).toBe('parent');
    });

    it('moveTaskToStageDurably 在本地持久化失败时不提交 UI 变更', async () => {
      const parent = createTask({ id: 'parent', stage: null });
      const child = createTask({ id: 'child', stage: null, parentId: null });
      activeProject = createProject({ tasks: [parent, child] });
      mockRecorder.recordAndUpdateDurably.mockResolvedValueOnce(false);

      const result = await service.moveTaskToStageDurably({
        taskId: 'child',
        newStage: null,
        newParentId: 'parent',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.OPERATION_FAILED);
      }
      expect(mockRecorder.recordAndUpdate).not.toHaveBeenCalled();
      expect(activeProject!.tasks.find(t => t.id === 'child')?.parentId).toBeNull();
    });
  });

  // ═══════════════════════════════════════════
  // 分支 2: null → stage (浮动树整体分配)
  // ═══════════════════════════════════════════

  describe('moveTaskToStage - 分支2: null→stage (浮动树整体分配)', () => {
    it('成功将待分配任务分配到阶段', async () => {
      const task = createTask({ id: 't1', stage: null });
      activeProject = createProject({ tasks: [task] });

      const result = await service.moveTaskToStage({
        taskId: 't1',
        newStage: 1,
      });

      expect(result.ok).toBe(true);
      expect(mockRecorder.recordAndUpdateDurably).toHaveBeenCalledWith(
        expect.any(Function),
        { updateType: 'structure' },
      );
      expect(mockRecorder.recordAndUpdate).not.toHaveBeenCalled();
      expect(mockSubtreeOps.validateStageCapacity).toHaveBeenCalledWith('t1', 1, expect.any(Array));
      expect(mockSubtreeOps.fixSubtreeRanks).toHaveBeenCalled();
    });

    it('阶段溢出时返回容量校验失败', async () => {
      mockSubtreeOps.validateStageCapacity.mockReturnValue(
        { ok: false, error: { code: ErrorCodes.STAGE_OVERFLOW, message: '阶段已满' } }
      );
      const task = createTask({ id: 't1', stage: null });
      activeProject = createProject({ tasks: [task] });

      const result = await service.moveTaskToStage({ taskId: 't1', newStage: 5 });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.STAGE_OVERFLOW);
      }
    });

    it('指定的新父任务在待分配区时返回 CROSS_BOUNDARY_VIOLATION', async () => {
      const parent = createTask({ id: 'parent', stage: null });
      const child = createTask({ id: 'child', stage: null });
      activeProject = createProject({ tasks: [parent, child] });

      const result = await service.moveTaskToStage({
        taskId: 'child',
        newStage: 2,
        newParentId: 'parent',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.CROSS_BOUNDARY_VIOLATION);
      }
    });

    it('新父任务阶段与目标阶段不匹配时返回 CROSS_BOUNDARY_VIOLATION', async () => {
      const parent = createTask({ id: 'parent', stage: 3 }); // stage 3，但目标 stage=2，期望 parent.stage=1
      const child = createTask({ id: 'child', stage: null });
      activeProject = createProject({ tasks: [parent, child] });

      const result = await service.moveTaskToStage({
        taskId: 'child',
        newStage: 2,
        newParentId: 'parent',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.CROSS_BOUNDARY_VIOLATION);
      }
    });

    it('moveTaskToStageDurably 先持久化再分配待分配子树', async () => {
      const task = createTask({ id: 't1', stage: null });
      activeProject = createProject({ tasks: [task] });

      const result = await service.moveTaskToStageDurably({
        taskId: 't1',
        newStage: 1,
      });

      expect(result.ok).toBe(true);
      expect(mockRecorder.recordAndUpdateDurably).toHaveBeenCalledWith(
        expect.any(Function),
        { updateType: 'structure' },
      );
      expect(mockRecorder.recordAndUpdate).not.toHaveBeenCalled();
      expect(activeProject!.tasks.find(t => t.id === 't1')?.stage).toBe(1);
      expect(mockSubtreeOps.fixSubtreeRanks).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════
  // 分支 3: stage → null (已分配树整体回收)
  // ═══════════════════════════════════════════

  describe('moveTaskToStage - 分支3: stage→null (已分配树整体回收)', () => {
    it('成功将子树移回待分配区', async () => {
      const task = createTask({ id: 't1', stage: 2, parentId: 'p0' });
      activeProject = createProject({ tasks: [task] });
      mockSubtreeOps.collectSubtreeIds.mockReturnValue(new Set(['t1']));

      const result = await service.moveTaskToStage({ taskId: 't1', newStage: null });

      expect(result.ok).toBe(true);
      expect(mockRecorder.recordAndUpdateDurably).toHaveBeenCalledWith(
        expect.any(Function),
        { updateType: 'structure' },
      );
      expect(mockRecorder.recordAndUpdate).not.toHaveBeenCalled();
      expect(mockSubtreeOps.collectSubtreeIds).toHaveBeenCalledWith('t1', expect.any(Array));
      const updated = activeProject!.tasks.find(t => t.id === 't1');
      expect(updated?.stage).toBeNull();
      expect(updated?.parentId).toBeNull();
    });

    it('moveTaskToStageDurably 先持久化再将已分配子树移回待分配区', async () => {
      const parent = createTask({ id: 'parent', stage: 1 });
      const child = createTask({ id: 'child', stage: 2, parentId: 'parent' });
      activeProject = createProject({ tasks: [parent, child] });
      mockSubtreeOps.collectSubtreeIds.mockReturnValue(new Set(['parent', 'child']));

      const result = await service.moveTaskToStageDurably({
        taskId: 'parent',
        newStage: null,
      });

      expect(result.ok).toBe(true);
      expect(mockRecorder.recordAndUpdateDurably).toHaveBeenCalledWith(
        expect.any(Function),
        { updateType: 'structure' },
      );
      expect(mockRecorder.recordAndUpdate).not.toHaveBeenCalled();
      expect(activeProject!.tasks.find(t => t.id === 'parent')?.stage).toBeNull();
      expect(activeProject!.tasks.find(t => t.id === 'child')?.stage).toBeNull();
    });
  });

  // ═══════════════════════════════════════════
  // 分支 4: stage → stage (已分配任务阶段变更)
  // ═══════════════════════════════════════════

  describe('moveTaskToStage - 分支4: stage→stage (阶段变更)', () => {
    it('成功移动任务到新阶段', async () => {
      const task = createTask({ id: 't1', stage: 1, rank: 1000 });
      activeProject = createProject({ tasks: [task] });

      const result = await service.moveTaskToStage({ taskId: 't1', newStage: 2 });

      expect(result.ok).toBe(true);
      expect(mockRecorder.recordAndUpdateDurably).toHaveBeenCalledWith(
        expect.any(Function),
        { updateType: 'structure' },
      );
      expect(mockRecorder.recordAndUpdate).not.toHaveBeenCalled();
      expect(mockSubtreeOps.cascadeUpdateChildrenStage).toHaveBeenCalled();
    });

    it('moveTaskToStageDurably 先持久化再移动已分配任务阶段', async () => {
      const task = createTask({ id: 't1', stage: 1, rank: 1000 });
      activeProject = createProject({ tasks: [task] });

      const result = await service.moveTaskToStageDurably({ taskId: 't1', newStage: 2 });

      expect(result.ok).toBe(true);
      expect(mockRecorder.recordAndUpdateDurably).toHaveBeenCalledWith(
        expect.any(Function),
        { updateType: 'structure' },
      );
      expect(mockRecorder.recordAndUpdate).not.toHaveBeenCalled();
      expect(activeProject!.tasks.find(t => t.id === 't1')?.stage).toBe(2);
    });

    it('改父节点时会清理旧父与新父重合的 shadow connection', async () => {
      const oldParent = createTask({ id: 'old-parent', stage: 1, rank: 1000 });
      const newParent = createTask({ id: 'new-parent', stage: 1, rank: 2000 });
      const child = createTask({ id: 'child', stage: 2, parentId: 'old-parent', rank: 1500 });
      const shadowOld: Connection = { id: 'shadow-old', source: 'old-parent', target: 'child' };
      const shadowNew: Connection = { id: 'shadow-new', source: 'new-parent', target: 'child' };
      const unrelated: Connection = { id: 'other', source: 'x', target: 'y' };
      const originalConnections = [shadowOld, shadowNew, unrelated];

      mockSubtreeOps.updateParentChildConnections.mockImplementation(
        (taskId: string, oldParentId: string | null, newParentId: string | null, connections: Connection[]) => {
          expect(taskId).toBe('child');
          expect(oldParentId).toBe('old-parent');
          expect(newParentId).toBe('new-parent');

          return connections.map(connection => (
            connection.target === 'child' && (connection.source === 'old-parent' || connection.source === 'new-parent')
              ? {
                  ...connection,
                  deletedAt: '2026-04-22T00:00:00.000Z',
                  updatedAt: '2026-04-22T00:00:00.000Z',
                }
              : connection
          ));
        }
      );

      activeProject = createProject({
        tasks: [oldParent, newParent, child],
        connections: originalConnections,
      });

      const result = await service.moveTaskToStage({
        taskId: 'child',
        newStage: 2,
        newParentId: 'new-parent',
      });

      expect(result.ok).toBe(true);
      expect(mockSubtreeOps.updateParentChildConnections).toHaveBeenCalledWith(
        'child',
        'old-parent',
        'new-parent',
        originalConnections,
      );
      expect(activeProject!.connections).toEqual([
        expect.objectContaining({
          id: 'shadow-old',
          deletedAt: '2026-04-22T00:00:00.000Z',
          updatedAt: '2026-04-22T00:00:00.000Z',
        }),
        expect.objectContaining({
          id: 'shadow-new',
          deletedAt: '2026-04-22T00:00:00.000Z',
          updatedAt: '2026-04-22T00:00:00.000Z',
        }),
        unrelated,
      ]);
      expect(activeProject!.tasks.find(task => task.id === 'child')?.parentId).toBe('new-parent');
    });

    it('阶段正在重新排序时返回 LAYOUT_RANK_CONFLICT', async () => {
      const task = createTask({ id: 't1', stage: 1 });
      activeProject = createProject({ tasks: [task] });

      // 设置 isStageRebalancing 返回 true
      mockLayoutService.isStageRebalancing.mockReturnValue(true);

      const result = await service.moveTaskToStage({ taskId: 't1', newStage: 2 });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.LAYOUT_RANK_CONFLICT);
      }
    });

    it('移动时检测到循环依赖返回 LAYOUT_CYCLE_DETECTED', async () => {
      mockLayoutService.detectCycle.mockReturnValue(true);
      const parent = createTask({ id: 'parent', stage: 1 });
      const child = createTask({ id: 'child', stage: 2, parentId: 'parent' });
      activeProject = createProject({ tasks: [parent, child] });

      const result = await service.moveTaskToStage({
        taskId: 'child',
        newStage: 2,
        newParentId: 'parent',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.LAYOUT_CYCLE_DETECTED);
      }
    });

    it('放置策略拒绝时返回 LAYOUT_PARENT_CHILD_CONFLICT', async () => {
      const task = createTask({ id: 't1', stage: 1 });
      activeProject = createProject({ tasks: [task] });

      mockLayoutService.applyRefusalStrategy.mockReturnValue({ ok: false, rank: 0 });

      const result = await service.moveTaskToStage({ taskId: 't1', newStage: 2 });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.LAYOUT_PARENT_CHILD_CONFLICT);
      }
    });

    it('无效 parentId 会被自动清除', async () => {
      // 父任务在 stage 3，但任务移到 stage 2（需要父在 stage 1 才合法），parentId 应被清除
      const parent = createTask({ id: 'parent', stage: 3 });
      const child = createTask({ id: 'child', stage: 1, parentId: 'parent' });
      activeProject = createProject({ tasks: [parent, child] });

      const result = await service.moveTaskToStage({ taskId: 'child', newStage: 2 });

      expect(result.ok).toBe(true);
      const updated = activeProject!.tasks.find(t => t.id === 'child');
      expect(updated?.parentId).toBeNull();
    });
  });

  // ═══════════════════════════════════════════
  // tree reparent delegated specs
  // ═══════════════════════════════════════════

  registerTaskMoveTreeReparentSpecs({
    service: () => service,
    activeProject: () => activeProject,
    setActiveProject: project => {
      activeProject = project;
    },
    createTask,
    createProject,
    recordedMutators: () => recordedMutators,
    mockLayoutService: () => mockLayoutService,
    mockRecorder: () => mockRecorder,
    mockSubtreeOps: () => mockSubtreeOps,
  });

  // ═══════════════════════════════════════════
  // replaceChildSubtreeWithUnassigned / assignUnassignedToTask
  // ═══════════════════════════════════════════

  registerTaskMoveAssignmentSpecs({
    service: () => service,
    setActiveProject: project => {
      activeProject = project;
    },
    createTask,
    createProject,
    mockRecorder: () => mockRecorder,
    mockSubtreeOps: () => mockSubtreeOps,
  });

  describe('assignment durable wrappers', () => {
    it('replaceChildSubtreeWithUnassignedDurably 通过本地持久化路径替换子树', async () => {
      const source = createTask({ id: 'src', stage: 1 });
      const target = createTask({ id: 'tgt', stage: null });
      activeProject = createProject({ tasks: [source, target] });
      mockSubtreeOps.collectSubtreeIds.mockReturnValue(new Set(['tgt']));

      const result = await service.replaceChildSubtreeWithUnassignedDurably('src', 'tgt');

      expect(result.ok).toBe(true);
      expect(mockRecorder.recordAndUpdateDurably).toHaveBeenCalledWith(
        expect.any(Function),
        { updateType: 'structure' },
      );
      expect(mockRecorder.recordAndUpdate).not.toHaveBeenCalled();
      expect(mockSubtreeOps.assignSubtreeToStage).toHaveBeenCalled();
    });

    it('assignUnassignedToTaskDurably 通过本地持久化路径分配待分配块', async () => {
      const source = createTask({ id: 'src', stage: 1 });
      const target = createTask({ id: 'tgt', stage: null });
      activeProject = createProject({ tasks: [source, target] });
      mockSubtreeOps.collectSubtreeIds.mockReturnValue(new Set(['tgt']));

      const result = await service.assignUnassignedToTaskDurably('src', 'tgt');

      expect(result.ok).toBe(true);
      expect(mockRecorder.recordAndUpdateDurably).toHaveBeenCalledWith(
        expect.any(Function),
        { updateType: 'structure' },
      );
      expect(mockRecorder.recordAndUpdate).not.toHaveBeenCalled();
      expect(mockSubtreeOps.assignSubtreeToStage).toHaveBeenCalled();
    });
  });
});
