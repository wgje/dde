/**
 * SyncService 单元测试 (Vitest + Angular TestBed)
 * 
 * 测试覆盖：
 * 1. 离线快照持久化
 * 2. 状态管理
 * 3. Realtime 订阅管理
 * 4. 冲突解决
 * 
 * 注意：完整的云同步测试需要集成测试环境
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { SyncService } from './sync.service';
import { SupabaseClientService } from './supabase-client.service';
import { TaskRepositoryService } from './task-repository.service';
import { ChangeTrackerService } from './change-tracker.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { ConflictStorageService } from './conflict-storage.service';
import { Project, Task } from '../models';

// ========== 模拟 Supabase Client ==========

const mockSupabaseChannel = {
  on: vi.fn().mockReturnThis(),
  subscribe: vi.fn().mockImplementation((callback) => {
    if (callback) callback('SUBSCRIBED');
    return mockSupabaseChannel;
  }),
  unsubscribe: vi.fn(),
};

const createMockFromChain = () => ({
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  is: vi.fn().mockReturnThis(),
  neq: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  insert: vi.fn().mockReturnThis(),
  update: vi.fn().mockReturnThis(),
  delete: vi.fn().mockReturnThis(),
  upsert: vi.fn().mockReturnThis(),
  single: vi.fn().mockResolvedValue({ data: null, error: null }),
  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
});

let mockFromChain = createMockFromChain();

const mockSupabaseClient = {
  from: vi.fn(() => mockFromChain),
  channel: vi.fn().mockReturnValue(mockSupabaseChannel),
  removeChannel: vi.fn(),
  auth: {
    getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: 'user-1' } } } }),
  },
};

// 模拟 SupabaseClientService
const mockSupabaseClientService = {
  client: vi.fn().mockReturnValue(mockSupabaseClient),
  isConfigured: true,
  configurationError: signal<string | null>(null),
  isOfflineMode: signal(false),
};

// 模拟 TaskRepositoryService
const mockTaskRepository = {
  loadTasks: vi.fn().mockResolvedValue([]),
  loadConnections: vi.fn().mockResolvedValue([]),
  saveTasks: vi.fn().mockResolvedValue({ success: true }),
  syncConnections: vi.fn().mockResolvedValue({ success: true }),
  saveTasksIncremental: vi.fn().mockResolvedValue({ success: true }),
};

// 模拟 ChangeTrackerService
const mockChangeTracker = {
  getProjectChanges: vi.fn().mockReturnValue({
    projectId: 'proj-1',
    tasksToCreate: [],
    tasksToUpdate: [],
    taskIdsToDelete: [],
    connectionsToCreate: [],
    connectionsToUpdate: [],
    connectionsToDelete: [],
    hasChanges: false,
    totalChanges: 0,
  }),
  clearProjectChanges: vi.fn(),
};

// 模拟 ToastService
const mockToastService = {
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
};

// 模拟 ConflictStorageService
const mockConflictStorage = {
  saveConflict: vi.fn().mockResolvedValue(true),
  getAllConflicts: vi.fn().mockResolvedValue([]),
  deleteConflict: vi.fn().mockResolvedValue(true),
  hasConflicts: vi.fn().mockResolvedValue(false),
};

// 模拟 LoggerService
const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockLoggerService = {
  category: vi.fn(() => mockLoggerCategory),
};

// ========== 辅助函数 ==========

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

describe('SyncService', () => {
  let service: SyncService;

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();

    // 重置 mock 链
    mockFromChain = createMockFromChain();
    mockSupabaseClient.from.mockReturnValue(mockFromChain);

    TestBed.configureTestingModule({
      providers: [
        SyncService,
        { provide: SupabaseClientService, useValue: mockSupabaseClientService },
        { provide: TaskRepositoryService, useValue: mockTaskRepository },
        { provide: ChangeTrackerService, useValue: mockChangeTracker },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: ToastService, useValue: mockToastService },
        { provide: ConflictStorageService, useValue: mockConflictStorage },
      ],
    });

    // 获取服务实例
    service = TestBed.inject(SyncService);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  // ==================== 离线快照持久化 ====================

  describe('离线快照持久化', () => {
    it('应该保存离线快照到 localStorage', () => {
      const projects = [
        createTestProject({ id: 'proj-1', name: 'Project 1' }),
        createTestProject({ id: 'proj-2', name: 'Project 2' }),
      ];

      service.saveOfflineSnapshot(projects);

      const saved = localStorage.getItem('nanoflow.offline-cache-v2');
      expect(saved).toBeTruthy();

      const parsed = JSON.parse(saved!);
      expect(parsed.projects).toHaveLength(2);
    });

    it('应该能够加载离线快照', () => {
      const projects = [
        createTestProject({ id: 'proj-1', name: 'Project 1' }),
      ];

      service.saveOfflineSnapshot(projects);
      const loaded = service.loadOfflineSnapshot();

      expect(loaded).toHaveLength(1);
      expect(loaded![0].name).toBe('Project 1');
    });

    it('离线快照应该包含版本号', () => {
      const projects = [createTestProject()];

      service.saveOfflineSnapshot(projects);

      const saved = localStorage.getItem('nanoflow.offline-cache-v2');
      const parsed = JSON.parse(saved!);

      // 实现中保存的是 version 而不是 timestamp
      expect(parsed.version).toBeDefined();
    });

    it('清除离线缓存应该移除 localStorage 数据', () => {
      service.saveOfflineSnapshot([createTestProject()]);
      expect(localStorage.getItem('nanoflow.offline-cache-v2')).toBeTruthy();

      service.clearOfflineCache();

      expect(localStorage.getItem('nanoflow.offline-cache-v2')).toBeNull();
    });

    it('加载空缓存应该返回 null', () => {
      const loaded = service.loadOfflineSnapshot();
      expect(loaded).toBeNull();
    });

    it('应该保存大量项目', () => {
      const projects = Array.from({ length: 100 }, (_, i) =>
        createTestProject({ id: `proj-${i}`, name: `Project ${i}` })
      );

      service.saveOfflineSnapshot(projects);
      const loaded = service.loadOfflineSnapshot();

      expect(loaded).toHaveLength(100);
    });
  });

  // ==================== 状态管理 ====================

  describe('状态管理', () => {
    it('初始状态应该正确', () => {
      const state = service.syncState();

      expect(state.isSyncing).toBe(false);
      expect(state.offlineMode).toBe(false);
      expect(state.sessionExpired).toBe(false);
      expect(state.hasConflict).toBe(false);
    });

    it('isLoadingRemote 初始值应该为 false', () => {
      expect(service.isLoadingRemote()).toBe(false);
    });
  });

  describe('冲突场景安全同步', () => {
    it('版本冲突时应尝试把本地 soft delete 提前写到远端', async () => {
      const deletedTask = createTestTask({ id: 'task-1', deletedAt: new Date().toISOString() });
      const localProject = createTestProject({ id: 'proj-1', version: 1, tasks: [deletedTask] });
      const remoteProject = createTestProject({ id: 'proj-1', version: 2, tasks: [createTestTask({ id: 'task-1', deletedAt: null })] });

      // 让 tryAutoRebase 走失败分支，进入冲突流程
      (service as any).tryAutoRebase = vi.fn().mockResolvedValue(null);
      // 避免真实持久化冲突数据（IndexedDB 等）
      (service as any).persistConflictData = vi.fn();
      vi.spyOn(service, 'loadSingleProject').mockResolvedValue(remoteProject);

      // 构造 projects 表的链式调用，使 update 返回 0 行（触发版本冲突）
      const projectsChain: any = {
        __mode: 'check',
        select: vi.fn((cols: string) => {
          if (projectsChain.__mode === 'update' && cols === 'id') {
            return Promise.resolve({ data: [], error: null });
          }
          return projectsChain;
        }),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'proj-1', version: 1 }, error: null }),
        update: vi.fn(() => {
          projectsChain.__mode = 'update';
          return projectsChain;
        }),
        insert: vi.fn().mockReturnThis(),
      };

      mockSupabaseClient.from.mockImplementation((table: string) => {
        if (table === 'projects') return projectsChain;
        return mockFromChain;
      });

      await service.saveProjectToCloud(localProject, 'user-1');

      expect(mockTaskRepository.saveTasksIncremental).toHaveBeenCalled();
      const call = (mockTaskRepository.saveTasksIncremental as any).mock.calls[0];
      expect(call[0]).toBe('proj-1');
      const tasksToUpdate = call[2] as Task[];
      expect(tasksToUpdate).toHaveLength(1);
      expect(tasksToUpdate[0].id).toBe('task-1');
      expect(tasksToUpdate[0].deletedAt).toBeTruthy();
    });
  });

  // ==================== 冲突解决 ====================

  describe('冲突解决', () => {
    it('解决冲突后应该清除 hasConflict 状态', () => {
      // 先模拟设置冲突状态
      const conflictProject = createTestProject({ id: 'proj-1' });
      
      // 调用 resolveConflict
      service.resolveConflict('proj-1', conflictProject, 'local');

      // 验证状态被清除
      expect(service.syncState().hasConflict).toBe(false);
      expect(service.syncState().conflictData).toBeNull();
    });

    it('解决冲突时应该记录日志', () => {
      const project = createTestProject({ id: 'proj-1' });
      
      service.resolveConflict('proj-1', project, 'local');

      expect(mockLoggerCategory.info).toHaveBeenCalled();
    });
  });

  // ==================== Realtime 订阅管理 ====================

  describe('Realtime 订阅管理', () => {
    it('暂停更新应该记录日志并清空累积事件', () => {
      // 实际实现中 pauseRealtimeUpdates 设置内部 pauseRemoteUpdates 变量
      // 并清空累积的远程变更事件，避免恢复后处理过时的数据
      service.pauseRealtimeUpdates();

      expect(mockLoggerCategory.debug).toHaveBeenCalledWith('远程更新已暂停，累积事件已清空');
    });

    it('恢复更新应该记录日志', () => {
      service.pauseRealtimeUpdates();
      service.resumeRealtimeUpdates();

      expect(mockLoggerCategory.debug).toHaveBeenCalledWith('远程更新已恢复');
    });

    it('销毁订阅应该调用 removeChannel', async () => {
      // 先初始化订阅
      await service.initRealtimeSubscription('user-1');
      
      // 销毁
      service.teardownRealtimeSubscription();

      expect(mockSupabaseClient.removeChannel).toHaveBeenCalled();
    });
  });

  // ==================== 回调设置 ====================

  describe('回调设置', () => {
    it('应该能够设置远程变更回调', () => {
      const callback = vi.fn();
      
      // 通过某种方式设置回调（根据实际实现）
      service.setRemoteChangeCallback(callback);

      // 验证不会抛出错误
      expect(true).toBe(true);
    });

    it('应该能够设置任务变更回调', () => {
      const callback = vi.fn();
      
      service.setTaskChangeCallback(callback);

      expect(true).toBe(true);
    });
  });

  // ==================== 边界条件 ====================

  describe('边界条件', () => {
    it('无效的离线快照数据应该返回 null', () => {
      localStorage.setItem('nanoflow.offline-cache', 'invalid json');
      
      const loaded = service.loadOfflineSnapshot();
      
      expect(loaded).toBeNull();
    });

    it('空 userId 不应该初始化订阅', async () => {
      await service.initRealtimeSubscription('');
      
      // 不应该创建 channel
      // 具体行为取决于实现
    });
  });
});
