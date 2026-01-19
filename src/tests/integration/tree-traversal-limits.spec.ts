/**
 * 树遍历深度限制测试
 * 
 * 验证 MAX_SUBTREE_DEPTH = 100 的边界条件
 * 确保迭代算法正确处理深层嵌套和循环引用
 * 
 * @see AGENTS.md - 树遍历规则
 * @see docs/test-architecture-modernization-plan.md - M4.11
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';

import { TaskOperationService } from '../../services/task-operation.service';
import { LayoutService } from '../../services/layout.service';
import { ToastService } from '../../services/toast.service';
import { LoggerService } from '../../services/logger.service';
import { Project, Task } from '../../models';
import { FLOATING_TREE_CONFIG } from '../../config/layout.config';

// ============================================================================
// 辅助函数
// ============================================================================

function createTask(overrides: Partial<Task>): Task {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? crypto.randomUUID(),
    title: overrides.title ?? 'T',
    content: overrides.content ?? '',
    stage: overrides.stage ?? 1,
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

/**
 * 创建深层嵌套的任务链
 * task-0 -> task-1 -> task-2 -> ... -> task-(depth-1)
 */
function createDeepNestedTasks(depth: number): Task[] {
  const tasks: Task[] = [];
  for (let i = 0; i < depth; i++) {
    tasks.push(createTask({
      id: `task-${i}`,
      title: `Task ${i}`,
      parentId: i === 0 ? null : `task-${i - 1}`,
      stage: 1,
    }));
  }
  return tasks;
}

/**
 * 创建宽树结构（多个直接子节点）
 */
function createWideTree(width: number): Task[] {
  const root = createTask({ id: 'root', title: 'Root', parentId: null, stage: 1 });
  const children = Array.from({ length: width }, (_, i) =>
    createTask({ id: `child-${i}`, title: `Child ${i}`, parentId: 'root', stage: 1 })
  );
  return [root, ...children];
}

// ============================================================================
// 测试套件
// ============================================================================

describe('树遍历深度限制 (Tree Traversal Limits)', () => {
  let service: TaskOperationService;
  let project: Project;
  let mockLogger: any;

  beforeEach(() => {
    mockLogger = {
      category: vi.fn().mockReturnThis(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        TaskOperationService,
        LayoutService,
        ToastService,
        { provide: LoggerService, useValue: mockLogger },
      ],
    });

    service = TestBed.inject(TaskOperationService);
    project = createProject({});

    service.setCallbacks({
      getActiveProject: () => project,
      onProjectUpdate: (mutator) => {
        project = mutator(project);
      },
      onProjectUpdateDebounced: (mutator) => {
        project = mutator(project);
      },
    });
  });

  describe('MAX_SUBTREE_DEPTH 配置验证', () => {
    it('应该有 MAX_SUBTREE_DEPTH 配置且值为 100', () => {
      expect(FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH).toBe(100);
    });
  });

  describe('深层嵌套遍历', () => {
    it('应该安全处理恰好 100 层的嵌套（边界值）', () => {
      const tasks = createDeepNestedTasks(100);
      project = createProject({ tasks });

      // 删除根节点会遍历所有后代 - 不应抛出错误
      expect(() => {
        service.deleteTask('task-0');
      }).not.toThrow();

      // 验证所有任务都被软删除
      const deletedCount = project.tasks.filter(t => t.deletedAt !== null).length;
      expect(deletedCount).toBe(100);
    });

    it('应该在超过 100 层时安全处理（不崩溃）', () => {
      // 创建 150 层嵌套
      const tasks = createDeepNestedTasks(150);
      project = createProject({ tasks });

      // 删除操作不应崩溃
      expect(() => {
        service.deleteTask('task-0');
      }).not.toThrow();
    });

    it('删除深层任务时不应导致栈溢出', () => {
      const tasks = createDeepNestedTasks(120);
      project = createProject({ tasks });

      // 删除根节点及其子树 - 不应抛出栈溢出错误
      expect(() => {
        service.deleteTask('task-0');
      }).not.toThrow();
    });
  });

  describe('宽树遍历', () => {
    it('应该安全处理 1000 个直接子节点的宽树', () => {
      const tasks = createWideTree(1000);
      project = createProject({ tasks });

      // 删除根节点会遍历所有子节点 - 不应抛出错误
      expect(() => {
        service.deleteTask('root');
      }).not.toThrow();

      // 验证所有任务被软删除
      const deletedCount = project.tasks.filter(t => t.deletedAt !== null).length;
      expect(deletedCount).toBe(1001); // root + 1000 children
    });

    it('删除宽树根节点时应正确删除所有子节点', () => {
      const tasks = createWideTree(500);
      project = createProject({ tasks });

      const initialCount = project.tasks.length;
      expect(initialCount).toBe(501); // root + 500 children

      service.deleteTask('root');

      // 所有任务应被软删除
      const activeTasksCount = project.tasks.filter(t => !t.deletedAt).length;
      expect(activeTasksCount).toBe(0);
    });
  });

  describe('循环引用保护', () => {
    it('应该检测简单循环引用 (A -> B -> A)', () => {
      const tasks = [
        createTask({ id: 'a', parentId: 'b', stage: 1 }),
        createTask({ id: 'b', parentId: 'a', stage: 1 }),
      ];
      project = createProject({ tasks });

      // 删除操作应检测循环并安全退出，不应无限循环
      const startTime = Date.now();
      expect(() => {
        service.deleteTask('a');
      }).not.toThrow();
      const elapsed = Date.now() - startTime;

      // 应该快速完成（< 100ms），不应卡住
      expect(elapsed).toBeLessThan(100);
    });

    it('应该检测三节点循环 (A -> B -> C -> A)', () => {
      const tasks = [
        createTask({ id: 'a', parentId: 'c', stage: 1 }),
        createTask({ id: 'b', parentId: 'a', stage: 1 }),
        createTask({ id: 'c', parentId: 'b', stage: 1 }),
      ];
      project = createProject({ tasks });

      const startTime = Date.now();
      expect(() => {
        service.deleteTask('a');
      }).not.toThrow();
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(100);
    });

    it('自引用任务不应导致无限循环', () => {
      const tasks = [
        createTask({ id: 'self-ref', parentId: 'self-ref', stage: 1 }),
      ];
      project = createProject({ tasks });

      const startTime = Date.now();
      expect(() => {
        service.deleteTask('self-ref');
      }).not.toThrow();
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(100);
    });
  });

  describe('迭代算法验证', () => {
    it('使用迭代算法遍历应不会抛出 Maximum call stack size exceeded', () => {
      // 创建最大深度嵌套
      const tasks = createDeepNestedTasks(FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH + 50);
      project = createProject({ tasks });

      // 删除操作不应抛出栈溢出错误
      expect(() => {
        service.deleteTask('task-0');
      }).not.toThrow();
    });

    it('解除分配整棵子树时应使用迭代算法', () => {
      const tasks = createDeepNestedTasks(50);
      project = createProject({ tasks });

      // 解除分配根任务及其子树
      expect(() => {
        service.detachTaskWithSubtree('task-0');
      }).not.toThrow();

      // 验证根任务已移至待分配区
      const root = project.tasks.find(t => t.id === 'task-0');
      expect(root?.stage).toBeNull();
    });
  });
});
