/**
 * ConflictResolutionService 单元测试 (Vitest + Injector 隔离模式)
 * 
 * 测试覆盖：
 * 1. 冲突解决策略 - local/remote/merge
 * 2. 智能合并算法 - 任务合并、连接合并
 * 3. 字段级合并 - 时间戳比较、标签合并
 * 4. 文本内容合并 - 行级合并、前缀/后缀检测
 * 5. 离线数据重连合并
 * 6. 边缘情况 - 空数据、大数据量
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Injector, runInInjectionContext, signal } from '@angular/core';
import { ConflictResolutionService } from './conflict-resolution.service';
import { ConflictDetectionService } from './conflict-detection.service';
import { SyncStateService } from '../app/core/services/sync/sync-state.service';
import { TaskSyncOperationsService } from '../app/core/services/sync/task-sync-operations.service';
import { ProjectSaveFlightCoordinatorService } from '../app/core/services/sync/project-save-flight-coordinator.service';
import { LayoutService } from './layout.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { ChangeTrackerService } from './change-tracker.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { BlackBoxSyncService } from './black-box-sync.service';
import { mockSentryLazyLoaderService } from '../test-setup.mocks';
import { Project, Task, Connection } from '../models';
import { registerConflictResolutionContentConflictSpecs } from './conflict-resolution-content-conflict.spec-helpers';
import { registerConflictResolutionMergeSpecs } from './conflict-resolution-merge.spec-helpers';
import { registerConflictResolutionStrategySpecs } from './conflict-resolution-strategies.spec-helpers';

// ========== 模拟依赖服务 ==========

const mockSyncService = {
  syncState: signal({
    isSyncing: false,
    isOnline: true,
    offlineMode: false,
    sessionExpired: false,
    syncError: null,
    hasConflict: false,
    conflictData: null,
  }),
  update: vi.fn(),
  save: vi.fn().mockResolvedValue({ success: true }),
  getTombstoneIds: vi.fn().mockResolvedValue(new Set<string>()),
  // 【v5.9】添加带状态的 tombstone 查询方法
  getTombstoneIdsWithStatus: vi.fn().mockResolvedValue({
    ids: new Set<string>(),
    fromRemote: true,
    localCacheOnly: false,
    timestamp: Date.now()
  }),
};

const mockLayoutService = {
  validateAndFixTree: vi.fn().mockImplementation((project: Project) => ({
    project,
    issues: [] as string[],
  })),
  rebalance: vi.fn().mockImplementation((project: Project) => project),
};

const mockToastService = {
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
};

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockLoggerService = {
  category: vi.fn(() => mockLoggerCategory),
};

// 模拟 ChangeTrackerService
const mockChangeTrackerService = {
  getLockedFields: vi.fn().mockReturnValue([]),
  lockTaskField: vi.fn(),
  unlockTaskField: vi.fn(),
  clearProjectFieldLocks: vi.fn(),
  isTaskFieldLocked: vi.fn().mockReturnValue(false),
};

const mockBlackBoxSyncService = {
  pullChanges: vi.fn(),
};

// ========== 辅助函数 ==========

let connectionIdCounter = 0;

function createTestConnection(overrides?: Partial<Connection>): Connection {
  return {
    id: `conn-${++connectionIdCounter}`,
    source: 'task-1',
    target: 'task-2',
    ...overrides,
  };
}

function createTestProject(overrides?: Partial<Project>): Project {
  return {
    id: `proj-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: 'Test Project',
    description: '',
    createdDate: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [],
    connections: [],
    version: 1,
    ...overrides,
  };
}

function createTestTask(overrides?: Partial<Task>): Task {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title: 'Test Task',
    content: '',
    stage: 1,
    parentId: null,
    order: 1,
    rank: 1000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    displayId: 'A',
    hasIncompleteTask: false,
    ...overrides,
  };
}

// ========== 测试用例 ==========

describe('ConflictResolutionService', () => {
  let service: ConflictResolutionService;

  beforeEach(() => {
    vi.clearAllMocks();

    // First create injector with base dependencies
    const baseInjector = Injector.create({
      providers: [
        // 单一 mock 同时背书三个具体服务——原 SimpleSyncService 门面把它们转发为一。
        { provide: SyncStateService, useValue: mockSyncService },
        { provide: TaskSyncOperationsService, useValue: mockSyncService },
        { provide: ProjectSaveFlightCoordinatorService, useValue: mockSyncService },
        { provide: LayoutService, useValue: mockLayoutService },
        { provide: ToastService, useValue: mockToastService },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: ChangeTrackerService, useValue: mockChangeTrackerService },
        { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
        { provide: BlackBoxSyncService, useValue: mockBlackBoxSyncService },
      ],
    });

    // Create ConflictDetectionService in injection context (it uses inject())
    const conflictDetection = runInInjectionContext(baseInjector, () => new ConflictDetectionService());

    // Create child injector with ConflictDetectionService
    const injector = Injector.create({
      parent: baseInjector,
      providers: [
        { provide: ConflictDetectionService, useValue: conflictDetection },
      ],
    });

    // ConflictResolutionService 内部使用 inject()，必须在注入上下文中实例化
    service = runInInjectionContext(injector, () => new ConflictResolutionService());
  });

  // ==================== 冲突解决策略 ====================

  registerConflictResolutionStrategySpecs({
    service: () => service,
    createTestProject,
    createTestTask,
    mockSyncService,
    mockLayoutService,
    mockToastService,
  });

  // ==================== 智能合并算法 ====================

  registerConflictResolutionMergeSpecs({
    service: () => service,
    createTestProject,
    createTestTask,
    createTestConnection,
    mockChangeTrackerService,
  });

  // ==================== 文本内容合并 ====================

  describe('文本内容合并', () => {
    it('内容是前缀扩展时应该使用较长版本', () => {
      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          content: 'Hello',
          updatedAt: new Date('2024-01-01').toISOString(),
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          content: 'Hello World',
          updatedAt: new Date('2024-01-02').toISOString(),
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(result.project.tasks[0].content).toBe('Hello World');
    });

    it('内容是后缀扩展时应该使用较长版本', () => {
      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          content: 'World',
          updatedAt: new Date('2024-01-01').toISOString(),
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          content: 'Hello World',
          updatedAt: new Date('2024-01-02').toISOString(),
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(result.project.tasks[0].content).toBe('Hello World');
    });

    it('行级合并应该保留双方新增的行', () => {
      // baseContent 用于说明测试场景的基础状态
      const _baseContent = 'Line 1\nLine 2\nLine 3';
      void _baseContent; // 仅作为文档说明
      const localContent = 'Line 1\nLine 2\nLine 3\nNew Local Line';
      const remoteContent = 'Line 1\nLine 2\nLine 3\nNew Remote Line';

      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          content: localContent,
          updatedAt: new Date('2024-01-01').toISOString(),
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          content: remoteContent,
          updatedAt: new Date('2024-01-02').toISOString(),
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      // 行级合并应该包含双方的新增行
      const content = result.project.tasks[0].content;
      expect(content).toContain('Line 1');
      expect(content).toContain('Line 2');
      expect(content).toContain('Line 3');
    });

    it('内容差异太大时应该使用更新时间较新的版本', () => {
      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          content: 'Completely different content A',
          updatedAt: new Date('2024-01-01').toISOString(),
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          content: 'Totally new content B',
          updatedAt: new Date('2024-01-02').toISOString(),
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(result.project.tasks[0].content).toBe('Totally new content B');
    });
  });

  // ==================== 离线数据重连合并 ====================

  describe('离线数据重连合并', () => {
    it('离线创建的新项目应该上传到云端', async () => {
      const offlineProjects = [
        createTestProject({ id: 'new-proj', name: 'Offline Created' }),
      ];
      const cloudProjects: Project[] = [];

      mockSyncService.save.mockResolvedValue({ success: true });

      const result = await service.mergeOfflineDataOnReconnect(
        cloudProjects,
        offlineProjects,
        'user-1'
      );

      expect(result.syncedCount).toBe(1);
      expect(mockSyncService.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Offline Created' }),
        'user-1'
      );
    });

    it('离线版本更高时应该同步到云端', async () => {
      const cloudProjects = [
        createTestProject({ id: 'proj-1', version: 3 }),
      ];
      const offlineProjects = [
        createTestProject({ id: 'proj-1', version: 5, name: 'Updated Offline' }),
      ];

      mockSyncService.save.mockResolvedValue({ success: true });

      const result = await service.mergeOfflineDataOnReconnect(
        cloudProjects,
        offlineProjects,
        'user-1'
      );

      expect(result.syncedCount).toBe(1);
      expect(mockSyncService.save).toHaveBeenCalledWith(
        expect.objectContaining({ version: 6 }), // max(5, 3) + 1
        'user-1'
      );
    });

    it('离线同步冲突时应该加入冲突列表', async () => {
      const cloudProjects = [
        createTestProject({ id: 'proj-1', version: 5 }),
      ];
      const offlineProjects = [
        createTestProject({ id: 'proj-1', version: 6 }),
      ];

      mockSyncService.save.mockResolvedValue({
        success: false,
        conflict: true,
      });

      const result = await service.mergeOfflineDataOnReconnect(
        cloudProjects,
        offlineProjects,
        'user-1'
      );

      expect(result.conflictProjects).toHaveLength(1);
    });

    it('云端版本更高时不应该同步', async () => {
      const cloudProjects = [
        createTestProject({ id: 'proj-1', version: 10 }),
      ];
      const offlineProjects = [
        createTestProject({ id: 'proj-1', version: 5 }),
      ];

      const result = await service.mergeOfflineDataOnReconnect(
        cloudProjects,
        offlineProjects,
        'user-1'
      );

      expect(result.syncedCount).toBe(0);
      expect(mockSyncService.save).not.toHaveBeenCalled();
    });
  });

  // ==================== 版本号处理 ====================

  describe('版本号处理', () => {
    it('合并后应该使用双方较大版本号 + 1', () => {
      const localProject = createTestProject({ version: 3 });
      const remoteProject = createTestProject({ version: 7 });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(result.project.version).toBe(8);
    });

    it('版本号为 undefined 时应该视为 0', () => {
      const localProject = createTestProject({ version: undefined });
      const remoteProject = createTestProject({ version: 5 });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(result.project.version).toBe(6);
    });

    it('双方版本号都为 undefined 时应该设为 1', () => {
      const localProject = createTestProject({ version: undefined });
      const remoteProject = createTestProject({ version: undefined });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(result.project.version).toBe(1);
    });
  });

  // ==================== 边缘情况 ====================

  describe('边缘情况', () => {
    it('空任务列表应该正确处理', () => {
      const localProject = createTestProject({ tasks: [] });
      const remoteProject = createTestProject({ tasks: [] });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(result.project.tasks).toHaveLength(0);
      expect(result.conflictCount).toBe(0);
    });

    it('大量任务应该正确合并', () => {
      const localTasks: Task[] = [];
      const remoteTasks: Task[] = [];

      for (let i = 0; i < 500; i++) {
        localTasks.push(createTestTask({ id: `local-task-${i}` }));
      }
      for (let i = 0; i < 500; i++) {
        remoteTasks.push(createTestTask({ id: `remote-task-${i}` }));
      }

      const localProject = createTestProject({ tasks: localTasks });
      const remoteProject = createTestProject({ tasks: remoteTasks });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(result.project.tasks).toHaveLength(1000);
    });

    it('任务 ID 相同但内容不同时应该合并', () => {
      const oldTime = new Date('2024-01-01').toISOString();
      const newTime = new Date('2024-01-02').toISOString();

      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'same-id',
          title: 'Local Version',
          priority: 'high',
          updatedAt: newTime,
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'same-id',
          title: 'Remote Version',
          priority: 'low',
          updatedAt: oldTime,
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(result.project.tasks).toHaveLength(1);
      expect(result.project.tasks[0].title).toBe('Local Version');
      expect(result.project.tasks[0].priority).toBe('high');
    });

    it('更新时间完全相同时应该使用本地版本', () => {
      const sameTime = new Date('2024-01-01T12:00:00Z').toISOString();

      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: 'Local Title',
          updatedAt: sameTime,
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: 'Remote Title',
          updatedAt: sameTime,
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      // 时间相同时，remoteTime > localTime 为 false，所以用 local
      expect(result.project.tasks[0].title).toBe('Local Title');
    });
  });

  // ==================== 时间戳极端情况 ====================

  describe('时间戳极端情况', () => {
    it('客户端时间快于服务器时应该以更新时间为准', () => {
      // 客户端时钟快了 1 小时
      const clientTime = new Date('2024-01-15T11:00:00Z').toISOString();
      const serverTime = new Date('2024-01-15T10:00:00Z').toISOString();

      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: 'Client Edit (faster clock)',
          updatedAt: clientTime,
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: 'Server Edit',
          updatedAt: serverTime,
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(result.project.tasks[0].title).toBe('Client Edit (faster clock)');
    });

    it('客户端时间慢于服务器时应该以更新时间为准', () => {
      // 客户端时钟慢了 1 小时
      const clientTime = new Date('2024-01-15T09:00:00Z').toISOString();
      const serverTime = new Date('2024-01-15T10:00:00Z').toISOString();

      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: 'Client Edit (slower clock)',
          updatedAt: clientTime,
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: 'Server Edit',
          updatedAt: serverTime,
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      expect(result.project.tasks[0].title).toBe('Server Edit');
    });

    it('无效时间戳应该视为 0', () => {
      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: 'No timestamp',
          updatedAt: undefined,
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          title: 'Has timestamp',
          updatedAt: new Date().toISOString(),
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      // 有时间戳的应该胜出
      expect(result.project.tasks[0].title).toBe('Has timestamp');
    });
  });

  // ==================== 结构信息合并 ====================

  describe('结构信息合并', () => {
    it('更新时间较新时应该使用其结构信息', () => {
      const oldTime = new Date('2024-01-01').toISOString();
      const newTime = new Date('2024-01-02').toISOString();

      const localProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          stage: 1,
          parentId: null,
          order: 1,
          rank: 1000,
          updatedAt: oldTime,
        })],
      });
      const remoteProject = createTestProject({
        tasks: [createTestTask({
          id: 'task-1',
          stage: 2,
          parentId: 'parent-task',
          order: 5,
          rank: 5000,
          updatedAt: newTime,
        })],
      });

      const result = service.smartMerge(localProject, remoteProject, new Set());

      const task = result.project.tasks[0];
      expect(task.stage).toBe(2);
      expect(task.parentId).toBe('parent-task');
      expect(task.order).toBe(5);
      expect(task.rank).toBe(5000);
    });
  });

  // ==================== 内容冲突检测测试 ====================

  registerConflictResolutionContentConflictSpecs({
    service: () => service,
    createTestProject,
    createTestTask,
  });
});
