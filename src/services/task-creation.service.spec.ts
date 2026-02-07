import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Injector } from '@angular/core';
import { TaskCreationService } from './task-creation.service';
import { LayoutService } from './layout.service';
import { SubtreeOperationsService } from './subtree-operations.service';
import { ProjectStateService } from './project-state.service';
import { TaskRecordTrackingService } from './task-record-tracking.service';
import { Task, Project } from '../models';

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
    attachments: overrides.attachments,
    tags: overrides.tags,
    priority: overrides.priority,
    dueDate: overrides.dueDate,
  };
}

function createProject(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? 'proj-1',
    name: overrides.name ?? 'Test Project',
    description: overrides.description ?? '',
    createdDate: overrides.createdDate ?? now,
    tasks: overrides.tasks ?? [],
    connections: overrides.connections ?? [],
    updatedAt: overrides.updatedAt,
    version: overrides.version,
    viewState: overrides.viewState,
  };
}

describe('TaskCreationService', () => {
  let service: TaskCreationService;
  let mockLayoutService: Record<string, ReturnType<typeof vi.fn>>;
  let mockSubtreeOps: Record<string, ReturnType<typeof vi.fn>>;
  let mockProjectState: { activeProject: ReturnType<typeof vi.fn>; getTask: ReturnType<typeof vi.fn> };
  let mockRecorder: { recordAndUpdate: ReturnType<typeof vi.fn>; recordAndUpdateDebounced: ReturnType<typeof vi.fn> };
  let project: Project;
  let lastMutator: ((p: Project) => Project) | null;

  beforeEach(() => {
    lastMutator = null;

    mockLayoutService = {
      getSmartPosition: vi.fn().mockReturnValue({ x: 100, y: 200 }),
      computeInsertRank: vi.fn().mockReturnValue({ rank: 2000, needsRebalance: false }),
      applyRefusalStrategy: vi.fn().mockReturnValue({ ok: true, rank: 2000 }),
      generateShortId: vi.fn().mockReturnValue('NF-TEST'),
      detectIncomplete: vi.fn().mockReturnValue(false),
      rebalance: vi.fn((p: Project) => p),
      detectCycle: vi.fn().mockReturnValue(false),
      isStageRebalancing: vi.fn().mockReturnValue(false),
    };

    mockSubtreeOps = {
      validateParentChildStageConsistency: vi.fn().mockReturnValue({ ok: true }),
      fixSubtreeRanks: vi.fn(),
    };

    project = createProject({
      tasks: [
        createTask({ id: 'root-1', title: 'Root', stage: 1, rank: 1000 }),
        createTask({ id: 'child-1', title: 'Child', stage: 2, parentId: 'root-1', rank: 1500 }),
      ],
      connections: [{ id: 'conn-1', source: 'root-1', target: 'child-1' }],
    });

    mockProjectState = {
      activeProject: vi.fn(() => project),
      getTask: vi.fn((taskId: string) => project?.tasks.find(t => t.id === taskId) ?? null),
    };

    mockRecorder = {
      recordAndUpdate: vi.fn((mutator: (p: Project) => Project) => { lastMutator = mutator; }),
      recordAndUpdateDebounced: vi.fn(),
    };

    const injector = Injector.create({
      providers: [
        { provide: TaskCreationService, useClass: TaskCreationService },
        { provide: LayoutService, useValue: mockLayoutService },
        { provide: SubtreeOperationsService, useValue: mockSubtreeOps },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: TaskRecordTrackingService, useValue: mockRecorder },
      ],
    });

    service = injector.get(TaskCreationService);
  });

  describe('addTask', () => {
    it('创建根任务（无父节点）成功返回新任务 ID', () => {
      const result = service.addTask({
        title: 'New Task',
        content: 'Some content',
        targetStage: 1,
        parentId: null,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(typeof result.value).toBe('string');
        expect(result.value.length).toBeGreaterThan(0);
      }
      expect(lastMutator).not.toBeNull();
    });

    it('创建子任务时自动创建 Connection', () => {
      const result = service.addTask({
        title: 'Child Task',
        content: '',
        targetStage: 2,
        parentId: 'root-1',
      });

      expect(result.ok).toBe(true);
      expect(lastMutator).not.toBeNull();
      // The mutator should add a connection and call rebalance
      const updated = lastMutator!(project);
      expect(mockLayoutService['rebalance']).toHaveBeenCalled();
      expect(updated.connections.length).toBe(2); // original + new
      expect(updated.connections.some(c => c.target !== 'child-1')).toBe(true);
    });

    it('title 和 content 均为空时默认标题为"新任务"', () => {
      const result = service.addTask({
        title: '',
        content: '',
        targetStage: 1,
        parentId: null,
      });

      expect(result.ok).toBe(true);
      const updated = lastMutator!(project);
      const newTask = updated.tasks[updated.tasks.length - 1];
      expect(newTask.title).toBe('新任务');
    });

    it('没有活动项目时返回 DATA_NOT_FOUND', () => {
      mockProjectState.activeProject.mockReturnValue(null);

      const result = service.addTask({
        title: 'Test',
        content: '',
        targetStage: 1,
        parentId: null,
      });

      expect(result.ok).toBe(false);
    });

    it('阶段正在重平衡时返回 LAYOUT_RANK_CONFLICT', () => {
      mockLayoutService['isStageRebalancing'].mockReturnValue(true);

      const result = service.addTask({
        title: 'Test',
        content: '',
        targetStage: 1,
        parentId: null,
      });

      expect(result.ok).toBe(false);
    });

    it('待分配区任务（stage=null）不调用 rebalance', () => {
      const result = service.addTask({
        title: 'Floating',
        content: '',
        targetStage: null,
        parentId: null,
      });

      expect(result.ok).toBe(true);
      expect(mockLayoutService['rebalance']).not.toHaveBeenCalled();
      // Verify task was added directly
      const updated = lastMutator!(project);
      const newTask = updated.tasks[updated.tasks.length - 1];
      expect(newTask.stage).toBe(null);
    });

    it('父子阶段一致性校验失败时返回错误', () => {
      mockSubtreeOps['validateParentChildStageConsistency'].mockReturnValue({
        ok: false,
        error: { code: 'CROSS_BOUNDARY_VIOLATION', message: '跨阶段约束违规' },
      });

      const result = service.addTask({
        title: 'Bad Child',
        content: '',
        targetStage: 1,
        parentId: 'root-1',
      });

      expect(result.ok).toBe(false);
    });

    it('生成的任务包含 UUID 和 shortId', () => {
      service.addTask({
        title: 'Test',
        content: '',
        targetStage: 1,
        parentId: null,
      });

      const updated = lastMutator!(project);
      const newTask = updated.tasks[updated.tasks.length - 1];
      expect(newTask.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(newTask.shortId).toBe('NF-TEST');
    });

    it('放置策略拒绝时返回 LAYOUT_NO_SPACE', () => {
      mockLayoutService['applyRefusalStrategy'].mockReturnValue({ ok: false, rank: 0 });

      const result = service.addTask({
        title: 'Test',
        content: '',
        targetStage: 1,
        parentId: null,
      });

      expect(result.ok).toBe(false);
    });
  });

  describe('addFloatingTask', () => {
    it('创建浮动任务，使用指定坐标', () => {
      service.addFloatingTask('Float', 'Content', 300, 400);

      expect(lastMutator).not.toBeNull();
      const updated = lastMutator!(project);
      const newTask = updated.tasks[updated.tasks.length - 1];
      expect(newTask.stage).toBe(null);
      expect(newTask.parentId).toBe(null);
      expect(newTask.x).toBe(300);
      expect(newTask.y).toBe(400);
      expect(newTask.title).toBe('Float');
    });

    it('没有活动项目时静默返回', () => {
      mockProjectState.activeProject.mockReturnValue(null);

      service.addFloatingTask('Float', '', 0, 0);
      expect(lastMutator).toBeNull();
    });

    it('空 title 和 content 默认为"新任务"', () => {
      service.addFloatingTask('', '', 0, 0);
      const updated = lastMutator!(project);
      const newTask = updated.tasks[updated.tasks.length - 1];
      expect(newTask.title).toBe('新任务');
    });
  });

  describe('copyTask', () => {
    it('复制任务成功，标题添加"(副本)"后缀', () => {
      const newId = service.copyTask('root-1', '');

      expect(newId).toBeTruthy();
      expect(typeof newId).toBe('string');
      const updated = lastMutator!(project);
      const copied = updated.tasks[updated.tasks.length - 1];
      expect(copied.title).toBe('Root (副本)');
      expect(copied.stage).toBe(1);
      expect(copied.content).toBe('');
    });

    it('复制任务时使用自定义标题', () => {
      const newId = service.copyTask('root-1', 'Custom Title');

      expect(newId).toBeTruthy();
      const updated = lastMutator!(project);
      const copied = updated.tasks[updated.tasks.length - 1];
      expect(copied.title).toBe('Custom Title');
    });

    it('没有活动项目时返回 null', () => {
      mockProjectState.activeProject.mockReturnValue(null);

      const result = service.copyTask('root-1', 'Copy');
      expect(result).toBeNull();
    });

    it('任务不存在时返回 null', () => {
      const result = service.copyTask('nonexistent', 'Copy');
      expect(result).toBeNull();
    });

    it('复制待分配区任务不调用 rebalance', () => {
      project.tasks.push(createTask({ id: 'float-1', title: 'Float', stage: null }));

      service.copyTask('float-1', '');

      expect(mockLayoutService['rebalance']).not.toHaveBeenCalled();
    });
  });
});
