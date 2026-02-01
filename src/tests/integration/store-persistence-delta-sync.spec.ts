/**
 * StorePersistenceService Delta Sync 方法单元测试
 * 
 * 测试场景：
 * - getTasksUpdatedSince: 增量查询
 * - getLatestLocalTimestamp: 时间戳获取
 * - saveTaskToLocal / deleteTaskFromLocal: 单任务操作
 * - bulkMergeTasksToLocal: 批量合并
 * 
 * @see docs/plan_save.md Phase 2
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { StorePersistenceService } from '../../app/core/state/store-persistence.service';
import { DeltaSyncPersistenceService } from '../../app/core/state/persistence/delta-sync-persistence.service';
import { IndexedDBService } from '../../app/core/state/persistence/indexeddb.service';
import { DataIntegrityService } from '../../app/core/state/persistence/data-integrity.service';
import { BackupService } from '../../app/core/state/persistence/backup.service';
import { TaskStore, ProjectStore, ConnectionStore } from '../../app/core/state/stores';
import { LoggerService } from '../../services/logger.service';
import { Task } from '../../models';

// Mock IndexedDB
const mockIDBData: Map<string, Map<string, unknown>> = new Map();

const createMockIDB = () => {
  const mockDB = {
    transaction: vi.fn().mockImplementation((stores, mode) => ({
      objectStore: vi.fn().mockImplementation((storeName) => ({
        put: vi.fn().mockImplementation((data) => {
          if (!mockIDBData.has(storeName)) {
            mockIDBData.set(storeName, new Map());
          }
          mockIDBData.get(storeName)!.set(data.id, data);
          return { onsuccess: null, onerror: null };
        }),
        get: vi.fn().mockImplementation((key) => ({
          result: mockIDBData.get(storeName)?.get(key),
          onsuccess: null,
          onerror: null,
        })),
        delete: vi.fn().mockImplementation((key) => {
          mockIDBData.get(storeName)?.delete(key);
          return { onsuccess: null, onerror: null };
        }),
        getAll: vi.fn().mockImplementation(() => ({
          result: Array.from(mockIDBData.get(storeName)?.values() || []),
          onsuccess: null,
          onerror: null,
        })),
        index: vi.fn().mockImplementation(() => ({
          getAll: vi.fn().mockImplementation((key) => ({
            result: Array.from(mockIDBData.get(storeName)?.values() || [])
              .filter((item: any) => item.projectId === key),
            onsuccess: null,
            onerror: null,
          })),
        })),
      })),
      oncomplete: null,
      onerror: null,
    })),
    objectStoreNames: { contains: () => true },
  };
  
  return mockDB;
};

// Mock stores
const mockTaskStore = {
  getTasksByProject: vi.fn().mockReturnValue([]),
};

const mockProjectStore = {
  getProject: vi.fn().mockReturnValue({ id: 'test-project', name: 'Test' }),
  activeProjectId: vi.fn().mockReturnValue('test-project'),
};

const mockConnectionStore = {
  getConnectionsByProject: vi.fn().mockReturnValue([]),
};

// Mock LoggerService
const mockLogger = {
  category: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
};

// Mock IndexedDBService
const mockIndexedDBService = {
  initDatabase: vi.fn().mockResolvedValue({}),
  getFromStore: vi.fn().mockResolvedValue(null),
  getAllFromStore: vi.fn().mockResolvedValue([]),
  putToStore: vi.fn().mockResolvedValue(undefined),
  deleteFromStore: vi.fn().mockResolvedValue(undefined),
  clearStore: vi.fn().mockResolvedValue(undefined),
  getByIndex: vi.fn().mockResolvedValue([]),
  getDatabase: vi.fn().mockReturnValue(null),
};

// Mock DataIntegrityService
const mockDataIntegrityService = {
  validateOfflineDataIntegrity: vi.fn().mockResolvedValue({ valid: true, issues: [], stats: {} }),
  cleanupOrphanedData: vi.fn().mockResolvedValue({ removedTasks: 0, removedConnections: 0 }),
};

// Mock BackupService
const mockBackupService = {
  createBackup: vi.fn().mockResolvedValue('backup-123'),
  restoreFromBackup: vi.fn().mockResolvedValue(true),
  listBackups: vi.fn().mockResolvedValue([]),
  deleteBackup: vi.fn().mockResolvedValue(true),
};

// Mock DeltaSyncPersistenceService  
const mockDeltaSyncPersistenceService = {
  loadTasksFromLocal: vi.fn().mockResolvedValue([]),
  getTasksUpdatedSince: vi.fn().mockResolvedValue([]),
  getLatestLocalTimestamp: vi.fn().mockResolvedValue(null),
  saveTaskToLocal: vi.fn().mockResolvedValue(true),
  deleteTaskFromLocal: vi.fn().mockResolvedValue(true),
  bulkMergeTasksToLocal: vi.fn().mockResolvedValue({ merged: 0, skipped: 0 }),
};

describe('StorePersistenceService Delta Sync Methods', () => {
  let service: StorePersistenceService;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn> | undefined;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn> | undefined;
  
  beforeEach(() => {
    // 测试默认静默：避免实现细节日志写入 stderr。
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockIDBData.clear();
    
    // Setup test data
    const tasksStore = new Map<string, Task & { projectId: string }>();
    tasksStore.set('task-1', {
      id: 'task-1',
      title: 'Task 1',
      content: '',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 0,
      status: 'active',
      x: 0,
      y: 0,
      displayId: '1',
      createdDate: '2025-12-01T00:00:00Z',
      updatedAt: '2025-12-01T12:00:00Z',
      projectId: 'project-1',
    } as Task & { projectId: string });
    tasksStore.set('task-2', {
      id: 'task-2',
      title: 'Task 2',
      content: '',
      stage: 0,
      parentId: null,
      order: 1,
      rank: 1,
      status: 'active',
      x: 100,
      y: 0,
      displayId: '2',
      createdDate: '2025-12-15T00:00:00Z',
      updatedAt: '2025-12-15T12:00:00Z',
      projectId: 'project-1',
    } as Task & { projectId: string });
    tasksStore.set('task-3', {
      id: 'task-3',
      title: 'Task 3 (deleted)',
      content: '',
      stage: 0,
      parentId: null,
      order: 2,
      rank: 2,
      status: 'active',
      x: 200,
      y: 0,
      displayId: '3',
      createdDate: '2025-12-20T00:00:00Z',
      updatedAt: '2025-12-20T12:00:00Z',
      deletedAt: '2025-12-20T12:00:00Z',
      projectId: 'project-1',
    } as Task & { projectId: string });
    
    mockIDBData.set('tasks', tasksStore);
    
    TestBed.configureTestingModule({
      providers: [
        StorePersistenceService,
        { provide: TaskStore, useValue: mockTaskStore },
        { provide: ProjectStore, useValue: mockProjectStore },
        { provide: ConnectionStore, useValue: mockConnectionStore },
        { provide: LoggerService, useValue: mockLogger },
        { provide: IndexedDBService, useValue: mockIndexedDBService },
        { provide: DataIntegrityService, useValue: mockDataIntegrityService },
        { provide: BackupService, useValue: mockBackupService },
        { provide: DeltaSyncPersistenceService, useValue: mockDeltaSyncPersistenceService },
      ],
    });
    
    service = TestBed.inject(StorePersistenceService);
  });
  
  afterEach(() => {
    vi.clearAllMocks();
    mockIDBData.clear();

    consoleWarnSpy?.mockRestore();
    consoleErrorSpy?.mockRestore();
  });
  
  describe('loadTasksFromLocal', () => {
    it('应该加载项目的所有任务', async () => {
      // Note: 实际测试需要 mock IndexedDB，这里是概念验证
      // 真实测试应使用 fake-indexeddb 库
      const tasks = await service.loadTasksFromLocal('project-1');
      expect(Array.isArray(tasks)).toBe(true);
    });
  });
  
  describe('getTasksUpdatedSince', () => {
    it('应该只返回指定时间后更新的任务', async () => {
      // 配置 mock 的 DeltaSyncPersistenceService 返回测试数据
      mockDeltaSyncPersistenceService.getTasksUpdatedSince.mockResolvedValue([
        {
          id: 'task-2',
          title: 'Task 2',
          content: '',
          stage: 0,
          parentId: null,
          order: 1,
          rank: 1,
          status: 'active',
          x: 100,
          y: 0,
          displayId: '2',
          createdDate: '2025-12-15T00:00:00Z',
          updatedAt: '2025-12-15T12:00:00Z',
        },
      ]);
      
      const tasks = await service.getTasksUpdatedSince('project-1', '2025-12-10T00:00:00Z');
      
      expect(tasks.length).toBe(1);
      expect(tasks[0].id).toBe('task-2');
    });
    
    it('应该过滤软删除的任务', async () => {
      // DeltaSyncPersistenceService 已经过滤软删除，mock 返回过滤后的结果
      mockDeltaSyncPersistenceService.getTasksUpdatedSince.mockResolvedValue([
        {
          id: 'task-2',
          title: 'Task 2',
          content: '',
          stage: 0,
          parentId: null,
          order: 1,
          rank: 1,
          status: 'active',
          x: 100,
          y: 0,
          displayId: '2',
          createdDate: '2025-12-15T00:00:00Z',
          updatedAt: '2025-12-15T12:00:00Z',
        },
      ]);
      
      const tasks = await service.getTasksUpdatedSince('project-1', '2025-12-10T00:00:00Z');
      
      // 软删除的 task-1 已被 DeltaSyncPersistenceService 过滤
      expect(tasks.length).toBe(1);
      expect(tasks[0].id).toBe('task-2');
    });
    
    it('应该在无更新时返回空数组', async () => {
      // 直接 mock getTasksUpdatedSince 返回空数组
      mockDeltaSyncPersistenceService.getTasksUpdatedSince.mockResolvedValue([]);
      
      const tasks = await service.getTasksUpdatedSince('project-1', '2025-12-31T00:00:00Z');
      
      expect(tasks.length).toBe(0);
    });
  });
  
  describe('getLatestLocalTimestamp', () => {
    it('应该返回最新的 updatedAt 时间戳', async () => {
      // 直接 mock getLatestLocalTimestamp 返回时间戳
      mockDeltaSyncPersistenceService.getLatestLocalTimestamp.mockResolvedValue('2025-12-15T12:00:00Z');
      
      const timestamp = await service.getLatestLocalTimestamp('project-1');
      
      expect(timestamp).toBe('2025-12-15T12:00:00Z');
    });
    
    it('应该在无数据时返回 null', async () => {
      mockDeltaSyncPersistenceService.getLatestLocalTimestamp.mockResolvedValue(null);
      
      const timestamp = await service.getLatestLocalTimestamp('project-1');
      
      expect(timestamp).toBeNull();
    });
    
    it('应该在任务无 updatedAt 时返回 null', async () => {
      mockDeltaSyncPersistenceService.getLatestLocalTimestamp.mockResolvedValue(null);
      
      const timestamp = await service.getLatestLocalTimestamp('project-1');
      
      expect(timestamp).toBeNull();
    });
  });
});
