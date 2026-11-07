import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DestroyRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { TaskOperationService } from '../../services/task-operation.service';
import { LayoutService } from '../../services/layout.service';
import { ToastService } from '../../services/toast.service';
import { LoggerService } from '../../services/logger.service';
import { ProjectStateService } from '../../services/project-state.service';
import { TaskRecordTrackingService } from '../../services/task-record-tracking.service';
import { TaskTrashService } from '../../services/task-trash.service';
import { SubtreeOperationsService } from '../../services/subtree-operations.service';
import { TaskCreationService } from '../../services/task-creation.service';
import { TaskMoveService } from '../../services/task-move.service';
import { TaskAttributeService } from '../../services/task-attribute.service';
import { TaskConnectionService } from '../../services/task-connection.service';
import { ParkingService } from '../../services/parking.service';
import { Project, Task } from '../../models';
import { isSuccess, isFailure, ErrorCodes } from '../../utils/result';

function createTask(overrides: Partial<Task>): Task {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? crypto.randomUUID(),
    title: overrides.title ?? 'T',
    content: overrides.content ?? '',
    // stage 显式传 null 表示待分配任务，必须保留；仅在未传入时才默认阶段 1
    stage: overrides.stage === undefined ? 1 : overrides.stage,
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
    deletedAt: overrides.deletedAt ?? null,
    deletedConnections: overrides.deletedConnections,
    deletedMeta: overrides.deletedMeta,
    attachments: overrides.attachments ?? [],
    tags: overrides.tags ?? [],
    priority: overrides.priority,
    dueDate: overrides.dueDate ?? null,
  };
}

function createProject(overrides: Partial<Project>): Project {
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

describe('浮动任务树 (Floating Task Tree)', () => {
  let service: TaskOperationService;
  let project: Project;

  beforeEach(() => {
    project = createProject({});

    const mockLogger = {
      category: vi.fn().mockReturnThis(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    const mockProjectState = {
      activeProject: () => project,
      getTask: (taskId: string) => project?.tasks.find((t: Task) => t.id === taskId),
    };
    const mockRecorder = {
      recordAndUpdate: (mutator: (p: Project) => Project) => {
        project = mutator(project);
      },
      recordAndUpdateDebounced: (mutator: (p: Project) => Project) => {
        project = mutator(project);
      },
      recordAndUpdateDurably: vi.fn(async (mutator: (p: Project) => Project) => {
        project = mutator(project);
        return true;
      }),
      lastUpdateType: 'structure' as const,
    };
    const mockParkingService = {
      handleTaskStatusChange: vi.fn(),
      handleTaskSoftDelete: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        TaskOperationService,
        LayoutService,
        ToastService,
        TaskTrashService,
        SubtreeOperationsService,
        TaskCreationService,
        TaskMoveService,
        TaskAttributeService,
        TaskConnectionService,
        { provide: DestroyRef, useValue: { onDestroy: vi.fn() } },
        { provide: LoggerService, useValue: mockLogger },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: TaskRecordTrackingService, useValue: mockRecorder },
        { provide: ParkingService, useValue: mockParkingService },
      ],
    });

    service = TestBed.inject(TaskOperationService);
  });

  describe('待分配区内创建树结构', () => {
    it('应允许在待分配任务下创建子任务', async () => {
      // 创建待分配父任务
      const parentResult = await service.addTask({
        title: '待分配父任务',
        content: '',
        targetStage: null,
        parentId: null,
        isSibling: false,
      });
      expect(isSuccess(parentResult)).toBe(true);
      const parentId = (parentResult as any).value;

      // 在待分配父任务下创建子任务
      const childResult = await service.addTask({
        title: '待分配子任务',
        content: '',
        targetStage: null,  // 子任务也在待分配区
        parentId: parentId,
        isSibling: false,
      });
      
      expect(isSuccess(childResult)).toBe(true);
      const childId = (childResult as any).value;

      // 验证子任务的 parentId 正确设置
      const child = project.tasks.find(t => t.id === childId);
      expect(child).toBeDefined();
      expect(child?.stage).toBeNull();
      expect(child?.parentId).toBe(parentId);
    });

    it('应允许在待分配任务旁创建同级任务', async () => {
      // 创建待分配任务
      const task1Result = await service.addTask({
        title: '任务1',
        content: '',
        targetStage: null,
        parentId: null,
        isSibling: false,
      });
      expect(isSuccess(task1Result)).toBe(true);

      // 创建同级任务
      const task2Result = await service.addTask({
        title: '任务2',
        content: '',
        targetStage: null,
        parentId: null,
        isSibling: true,
      });
      
      expect(isSuccess(task2Result)).toBe(true);
      
      // 验证两个任务都在待分配区
      const unassigned = project.tasks.filter(t => t.stage === null);
      expect(unassigned.length).toBe(2);
    });
  });

  describe('同源不变性 (Homogeneous Tree Invariant)', () => {
    it('应拒绝将待分配任务直接挂载到已分配任务下', async () => {
      // 创建已分配父任务
      const assignedParent = createTask({
        id: 'assigned-parent',
        stage: 1,
        parentId: null,
      });
      project = createProject({ tasks: [assignedParent] });

      // 尝试创建待分配子任务（应失败）
      const result = await service.addTask({
        title: '待分配子任务',
        content: '',
        targetStage: null,  // 待分配
        parentId: 'assigned-parent',  // 但父任务已分配
        isSibling: false,
      });

      expect(isFailure(result)).toBe(true);
      if (isFailure(result)) {
        expect(result.error.code).toBe(ErrorCodes.CROSS_BOUNDARY_VIOLATION);
      }
    });

    it('应拒绝将已分配任务直接挂载到待分配任务下', async () => {
      // 创建待分配父任务
      const unassignedParent = createTask({
        id: 'unassigned-parent',
        stage: null,
        parentId: null,
      });
      project = createProject({ tasks: [unassignedParent] });

      // 尝试创建已分配子任务（应失败）
      const result = await service.addTask({
        title: '已分配子任务',
        content: '',
        targetStage: 1,  // 已分配
        parentId: 'unassigned-parent',  // 但父任务未分配
        isSibling: false,
      });

      expect(isFailure(result)).toBe(true);
      if (isFailure(result)) {
        expect(result.error.code).toBe(ErrorCodes.CROSS_BOUNDARY_VIOLATION);
      }
    });
  });

  describe('阶段溢出检测', () => {
    it('应拒绝会导致阶段溢出的分配操作', async () => {
      // 创建一棵深度为 3 的待分配树
      const root = createTask({ id: 'root', stage: null, parentId: null });
      const child = createTask({ id: 'child', stage: null, parentId: 'root' });
      const grandchild = createTask({ id: 'grandchild', stage: null, parentId: 'child' });
      
      // 创建一个已在高阶段的任务（模拟接近最大阶段）
      const highStageTask = createTask({ id: 'high', stage: 15, parentId: null });
      
      project = createProject({ tasks: [root, child, grandchild, highStageTask] });

      // 尝试将待分配树分配到阶段 20（会导致孙任务超出 15+10=25 的限制）
      const result = await service.moveTaskToStage({
        taskId: 'root',
        newStage: 24,  // 子任务会到 25，孙任务会到 26，超出 25
      });

      expect(isFailure(result)).toBe(true);
      if (isFailure(result)) {
        expect(result.error.code).toBe(ErrorCodes.STAGE_OVERFLOW);
      }
    });

    it('应返回正确的错误信息包含所需阶段和最大阶段', async () => {
      const root = createTask({ id: 'root', stage: null, parentId: null });
      const child = createTask({ id: 'child', stage: null, parentId: 'root' });
      const highStageTask = createTask({ id: 'high', stage: 15, parentId: null });
      
      project = createProject({ tasks: [root, child, highStageTask] });

      const result = await service.moveTaskToStage({
        taskId: 'root',
        newStage: 25,  // 子任务会到 26，超出 15+10=25
      });

      expect(isFailure(result)).toBe(true);
      if (isFailure(result)) {
        expect(result.error.details).toBeDefined();
        expect(result.error.details?.requiredStage).toBe(26);  // 25 + 1(深度)
        expect(result.error.details?.maxStage).toBe(25);  // 15 + 10
      }
    });
  });

  describe('浮动树整体分配', () => {
    it('分配父任务应级联分配所有后代', async () => {
      // 创建待分配树：root -> child -> grandchild
      const root = createTask({ id: 'root', stage: null, parentId: null, title: 'Root' });
      const child = createTask({ id: 'child', stage: null, parentId: 'root', title: 'Child' });
      const grandchild = createTask({ id: 'grandchild', stage: null, parentId: 'child', title: 'Grandchild' });
      
      project = createProject({ tasks: [root, child, grandchild] });

      // 将根任务分配到阶段 1
      const result = await service.moveTaskToStage({
        taskId: 'root',
        newStage: 1,
      });

      expect(isSuccess(result)).toBe(true);

      // 验证所有任务都已分配
      const assignedRoot = project.tasks.find(t => t.id === 'root');
      const assignedChild = project.tasks.find(t => t.id === 'child');
      const assignedGrandchild = project.tasks.find(t => t.id === 'grandchild');

      expect(assignedRoot?.stage).toBe(1);
      expect(assignedChild?.stage).toBe(2);
      expect(assignedGrandchild?.stage).toBe(3);
    });

    it('应保留子树内部父子关系', async () => {
      const root = createTask({ id: 'root', stage: null, parentId: null });
      const child = createTask({ id: 'child', stage: null, parentId: 'root' });
      
      project = createProject({ tasks: [root, child] });

      await service.moveTaskToStage({ taskId: 'root', newStage: 1 });

      const assignedChild = project.tasks.find(t => t.id === 'child');
      expect(assignedChild?.parentId).toBe('root');
    });

    it('分配到现有父任务下时应正确更新 displayId', async () => {
      // 创建一个已分配的父任务
      const existingParent = createTask({ 
        id: 'existing-parent', 
        stage: 1, 
        parentId: null, 
        rank: 1000,
        displayId: '1'
      });
      
      // 创建待分配树：floatRoot -> floatChild
      const floatRoot = createTask({ 
        id: 'float-root', 
        stage: null, 
        parentId: null 
      });
      const floatChild = createTask({ 
        id: 'float-child', 
        stage: null, 
        parentId: 'float-root' 
      });
      
      project = createProject({ 
        tasks: [existingParent, floatRoot, floatChild] 
      });

      // 将浮动树分配到 existingParent 下
      const result = await service.moveTaskToStage({
        taskId: 'float-root',
        newStage: 2,  // existingParent.stage + 1
        newParentId: 'existing-parent',
      });

      expect(isSuccess(result)).toBe(true);

      // 验证 stage 更新
      const assignedFloatRoot = project.tasks.find(t => t.id === 'float-root');
      const assignedFloatChild = project.tasks.find(t => t.id === 'float-child');
      
      expect(assignedFloatRoot?.stage).toBe(2);
      expect(assignedFloatChild?.stage).toBe(3);
      
      // 验证 parentId 更新
      expect(assignedFloatRoot?.parentId).toBe('existing-parent');
      expect(assignedFloatChild?.parentId).toBe('float-root');
      
      // 🔴 关键测试：验证 displayId 正确更新
      expect(assignedFloatRoot?.displayId).toBe('1,a');
      expect(assignedFloatChild?.displayId).toBe('1,a,a');
    });
  });

  describe('子树拆分分配', () => {
    it('可单独分配某个子任务及其后代', async () => {
      // 创建待分配树：root -> child -> grandchild
      const root = createTask({ id: 'root', stage: null, parentId: null });
      const child = createTask({ id: 'child', stage: null, parentId: 'root' });
      const grandchild = createTask({ id: 'grandchild', stage: null, parentId: 'child' });
      
      project = createProject({ tasks: [root, child, grandchild] });

      // 只分配 child 子树（不包括 root）
      const result = await service.moveTaskToStage({
        taskId: 'child',
        newStage: 1,
      });

      expect(isSuccess(result)).toBe(true);

      // root 应保留在待分配区
      const remainingRoot = project.tasks.find(t => t.id === 'root');
      expect(remainingRoot?.stage).toBeNull();

      // child 和 grandchild 应已分配
      const assignedChild = project.tasks.find(t => t.id === 'child');
      const assignedGrandchild = project.tasks.find(t => t.id === 'grandchild');
      
      expect(assignedChild?.stage).toBe(1);
      expect(assignedGrandchild?.stage).toBe(2);
      
      // child 的 parentId 应被清除（因为 root 还在待分配区）
      expect(assignedChild?.parentId).toBeNull();
    });

    it('分配一个待分配子任务后，其兄弟任务应保持与父任务的关系', async () => {
      // 创建待分配树：parent -> child1, child2, child3
      const parent = createTask({ id: 'parent', stage: null, parentId: null });
      const child1 = createTask({ id: 'child1', stage: null, parentId: 'parent' });
      const child2 = createTask({ id: 'child2', stage: null, parentId: 'parent' });
      const child3 = createTask({ id: 'child3', stage: null, parentId: 'parent' });
      
      project = createProject({ tasks: [parent, child1, child2, child3] });

      // 只分配 child2（将其认领到一个新的已分配父任务下）
      const result = await service.moveTaskToStage({
        taskId: 'child2',
        newStage: 1,
        newParentId: null,  // 成为根任务
      });

      expect(isSuccess(result)).toBe(true);

      // child2 应被分配
      const assignedChild2 = project.tasks.find(t => t.id === 'child2');
      expect(assignedChild2?.stage).toBe(1);
      expect(assignedChild2?.parentId).toBeNull();

      // parent, child1, child3 应保留在待分配区
      const remainingParent = project.tasks.find(t => t.id === 'parent');
      const remainingChild1 = project.tasks.find(t => t.id === 'child1');
      const remainingChild3 = project.tasks.find(t => t.id === 'child3');
      
      expect(remainingParent?.stage).toBeNull();
      expect(remainingChild1?.stage).toBeNull();
      expect(remainingChild3?.stage).toBeNull();

      // 🔴 关键测试：child1 和 child3 仍然是 parent 的子任务
      expect(remainingChild1?.parentId).toBe('parent');
      expect(remainingChild3?.parentId).toBe('parent');
    });
  });

  describe('整树回收', () => {
    it('解除分配应将整棵子树移回待分配区', async () => {
      // 创建已分配树
      const root = createTask({ id: 'root', stage: 1, parentId: null });
      const child = createTask({ id: 'child', stage: 2, parentId: 'root' });
      const grandchild = createTask({ id: 'grandchild', stage: 3, parentId: 'child' });
      
      project = createProject({ tasks: [root, child, grandchild] });

      // 将整棵树移回待分配区
      const result = await service.detachTaskWithSubtree('root');

      expect(isSuccess(result)).toBe(true);

      // 所有任务应回到待分配区
      const tasks = project.tasks;
      expect(tasks.find(t => t.id === 'root')?.stage).toBeNull();
      expect(tasks.find(t => t.id === 'child')?.stage).toBeNull();
      expect(tasks.find(t => t.id === 'grandchild')?.stage).toBeNull();
    });

    it('应保留子树内部父子关系', () => {
      const root = createTask({ id: 'root', stage: 1, parentId: null });
      const child = createTask({ id: 'child', stage: 2, parentId: 'root' });
      
      project = createProject({ tasks: [root, child] });

      service.detachTaskWithSubtree('root');

      // child 的 parentId 应保留
      const detachedChild = project.tasks.find(t => t.id === 'child');
      expect(detachedChild?.parentId).toBe('root');
    });

    it('应断开根节点与外部的连接', () => {
      // 根任务有外部父节点
      const externalParent = createTask({ id: 'external', stage: 1, parentId: null });
      const root = createTask({ id: 'root', stage: 2, parentId: 'external' });
      const child = createTask({ id: 'child', stage: 3, parentId: 'root' });
      
      project = createProject({ tasks: [externalParent, root, child] });

      service.detachTaskWithSubtree('root');

      // root 的 parentId 应被清除
      const detachedRoot = project.tasks.find(t => t.id === 'root');
      expect(detachedRoot?.parentId).toBeNull();
      
      // 但 child 的 parentId 应保留
      const detachedChild = project.tasks.find(t => t.id === 'child');
      expect(detachedChild?.parentId).toBe('root');
    });
  });

  describe('待分配区内部重组', () => {
    it('可在待分配区内重新组织父子关系', async () => {
      // 创建两个独立的待分配任务
      const task1 = createTask({ id: 'task1', stage: null, parentId: null });
      const task2 = createTask({ id: 'task2', stage: null, parentId: null });
      
      project = createProject({ tasks: [task1, task2] });

      // 将 task2 设为 task1 的子任务
      const result = await service.moveTaskToStage({
        taskId: 'task2',
        newStage: null,
        newParentId: 'task1',
      });

      expect(isSuccess(result)).toBe(true);

      const updatedTask2 = project.tasks.find(t => t.id === 'task2');
      expect(updatedTask2?.stage).toBeNull();
      expect(updatedTask2?.parentId).toBe('task1');
    });

    it('应检测循环依赖', async () => {
      // 创建链式待分配任务：task1 -> task2 -> task3
      const task1 = createTask({ id: 'task1', stage: null, parentId: null });
      const task2 = createTask({ id: 'task2', stage: null, parentId: 'task1' });
      const task3 = createTask({ id: 'task3', stage: null, parentId: 'task2' });
      
      project = createProject({ tasks: [task1, task2, task3] });

      // 尝试将 task1 设为 task3 的子任务（会形成循环）
      const result = await service.moveTaskToStage({
        taskId: 'task1',
        newStage: null,
        newParentId: 'task3',
      });

      expect(isFailure(result)).toBe(true);
      if (isFailure(result)) {
        expect(result.error.code).toBe(ErrorCodes.LAYOUT_CYCLE_DETECTED);
      }
    });

    it('应拒绝将待分配任务挂载到已分配任务下', async () => {
      const unassigned = createTask({ id: 'unassigned', stage: null, parentId: null });
      const assigned = createTask({ id: 'assigned', stage: 1, parentId: null });
      
      project = createProject({ tasks: [unassigned, assigned] });

      // 尝试在待分配区内重组时指向已分配任务（应失败）
      const result = await service.moveTaskToStage({
        taskId: 'unassigned',
        newStage: null,  // 保持待分配
        newParentId: 'assigned',  // 但新父任务已分配
      });

      expect(isFailure(result)).toBe(true);
      if (isFailure(result)) {
        expect(result.error.code).toBe(ErrorCodes.CROSS_BOUNDARY_VIOLATION);
      }
    });
  });
});
