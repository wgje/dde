/**
 * MigrationIntegrityService 单元测试
 *
 * 测试覆盖：
 * 1. saveMigrationSnapshot（sessionStorage / localStorage 降级）
 * 2. recoverFromSnapshot（从 sessionStorage 和 localStorage 恢复）
 * 3. clearMigrationSnapshot（清理快照）
 * 4. updateMigrationStatus（迁移状态更新和持久化）
 * 5. getMigrationStatus（获取迁移状态）
 * 6. clearMigrationStatus（清除迁移状态）
 * 7. hasUnfinishedMigration（检查未完成迁移）
 * 8. validateDataIntegrity（数据完整性检查）
 * 9. verifyMigrationSuccess（迁移后验证）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { MigrationIntegrityService } from './migration-integrity.service';
import { SimpleSyncService } from '../app/core/services/simple-sync.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { mockSentryLazyLoaderService } from '../test-setup.mocks';
import { MIGRATION_SNAPSHOT_CONFIG } from './migration.types';
import type { Project, Task, Connection } from '../models';

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockLoggerService = {
  category: vi.fn(() => mockLoggerCategory),
};

const mockToastService = {
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
};

const mockSyncService = {
  loadProjectsFromCloud: vi.fn(),
};

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Task',
    content: '',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 10000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: new Date().toISOString(),
    displayId: '1',
    ...overrides,
  };
}

function createConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'conn-1',
    source: 'task-1',
    target: 'task-2',
    ...overrides,
  };
}

function createProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Test Project',
    description: '',
    createdDate: new Date().toISOString(),
    tasks: [createTask()],
    connections: [],
    ...overrides,
  };
}

// Custom sessionStorage mock since vitest environment may not have it
const sessionStorageStore: Record<string, string> = {};
const sessionStorageMock = {
  getItem: (key: string) => sessionStorageStore[key] ?? null,
  setItem: (key: string, value: string) => { sessionStorageStore[key] = value; },
  removeItem: (key: string) => { delete sessionStorageStore[key]; },
  clear: () => { Object.keys(sessionStorageStore).forEach(k => delete sessionStorageStore[k]); },
};

describe('MigrationIntegrityService', () => {
  let service: MigrationIntegrityService;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn> | undefined;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorageMock.clear();
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Ensure sessionStorage is available
    if (typeof sessionStorage === 'undefined') {
      Object.defineProperty(globalThis, 'sessionStorage', {
        value: sessionStorageMock,
        writable: true,
        configurable: true,
      });
    } else {
      // Use real sessionStorage but clear it
      try { sessionStorage.clear(); } catch { /* noop */ }
    }

    const injector = Injector.create({
      providers: [
        MigrationIntegrityService,
        { provide: SimpleSyncService, useValue: mockSyncService },
        { provide: ToastService, useValue: mockToastService },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
      ],
    });

    service = runInInjectionContext(injector, () => injector.get(MigrationIntegrityService));
  });

  afterEach(() => {
    consoleWarnSpy?.mockRestore();
    consoleErrorSpy?.mockRestore();
  });

  // ==================== saveMigrationSnapshot ====================

  describe('saveMigrationSnapshot', () => {
    it('should save snapshot to sessionStorage for small data', () => {
      const projects = [createProject()];

      const result = service.saveMigrationSnapshot(projects);

      expect(result).toBe(true);
      const saved = sessionStorage.getItem(MIGRATION_SNAPSHOT_CONFIG.PRIMARY_KEY);
      expect(saved).toBeTruthy();
      const parsed = JSON.parse(saved!);
      expect(parsed.projects).toHaveLength(1);
    });

    it('should save version number in snapshot', () => {
      const projects = [createProject()];

      service.saveMigrationSnapshot(projects);

      const saved = sessionStorage.getItem(MIGRATION_SNAPSHOT_CONFIG.PRIMARY_KEY);
      const parsed = JSON.parse(saved!);
      expect(parsed.version).toBeDefined();
    });
  });

  // ==================== recoverFromSnapshot ====================

  describe('recoverFromSnapshot', () => {
    it('should recover from sessionStorage', () => {
      const projects = [createProject()];
      sessionStorage.setItem(
        MIGRATION_SNAPSHOT_CONFIG.PRIMARY_KEY,
        JSON.stringify({ projects, savedAt: new Date().toISOString(), version: 2 })
      );

      const result = service.recoverFromSnapshot();

      expect(result).toHaveLength(1);
      expect(result![0].id).toBe('proj-1');
    });

    it('should fall back to localStorage when sessionStorage is empty', () => {
      const projects = [createProject({ id: 'proj-fallback' })];
      localStorage.setItem(
        MIGRATION_SNAPSHOT_CONFIG.FALLBACK_KEY,
        JSON.stringify({ projects, savedAt: new Date().toISOString(), version: 2 })
      );

      const result = service.recoverFromSnapshot();

      expect(result).toHaveLength(1);
      expect(result![0].id).toBe('proj-fallback');
    });

    it('should return null when no snapshot exists', () => {
      const result = service.recoverFromSnapshot();
      expect(result).toBeNull();
    });

    it('should return null and log error on corrupted data', () => {
      sessionStorage.setItem(MIGRATION_SNAPSHOT_CONFIG.PRIMARY_KEY, '{invalid json}');

      const result = service.recoverFromSnapshot();

      expect(result).toBeNull();
      expect(mockLoggerCategory.error).toHaveBeenCalled();
    });
  });

  // ==================== clearMigrationSnapshot ====================

  describe('clearMigrationSnapshot', () => {
    it('should remove snapshot from both sessionStorage and localStorage', () => {
      sessionStorage.setItem(MIGRATION_SNAPSHOT_CONFIG.PRIMARY_KEY, 'data');
      localStorage.setItem(MIGRATION_SNAPSHOT_CONFIG.FALLBACK_KEY, 'data');

      service.clearMigrationSnapshot();

      expect(sessionStorage.getItem(MIGRATION_SNAPSHOT_CONFIG.PRIMARY_KEY)).toBeNull();
      expect(localStorage.getItem(MIGRATION_SNAPSHOT_CONFIG.FALLBACK_KEY)).toBeNull();
    });
  });

  // ==================== 迁移状态管理 ====================

  describe('migration status', () => {
    it('updateMigrationStatus should persist status to sessionStorage', () => {
      service.updateMigrationStatus('preparing');

      const record = service.getMigrationStatus();
      expect(record).not.toBeNull();
      expect(record!.status).toBe('preparing');
      expect(record!.phase).toBe(1);
    });

    it('getMigrationStatus should return null when no status exists', () => {
      const result = service.getMigrationStatus();
      expect(result).toBeNull();
    });

    it('clearMigrationStatus should remove status from sessionStorage', () => {
      service.updateMigrationStatus('uploading');
      expect(service.getMigrationStatus()).not.toBeNull();

      service.clearMigrationStatus();

      expect(service.getMigrationStatus()).toBeNull();
    });

    it('hasUnfinishedMigration should return true for in-progress migrations', () => {
      service.updateMigrationStatus('uploading');
      expect(service.hasUnfinishedMigration()).toBe(true);
    });

    it('hasUnfinishedMigration should return false for completed migrations', () => {
      service.updateMigrationStatus('completed');
      expect(service.hasUnfinishedMigration()).toBe(false);
    });

    it('hasUnfinishedMigration should return false for idle status', () => {
      service.updateMigrationStatus('idle');
      expect(service.hasUnfinishedMigration()).toBe(false);
    });

    it('hasUnfinishedMigration should return false when no status exists', () => {
      expect(service.hasUnfinishedMigration()).toBe(false);
    });

    it('should preserve partial fields across updates', () => {
      service.updateMigrationStatus('preparing', { projectsTotal: 5 });
      service.updateMigrationStatus('uploading', { projectsCompleted: 2 });

      const record = service.getMigrationStatus();
      expect(record!.projectsTotal).toBe(5);
      expect(record!.projectsCompleted).toBe(2);
    });
  });

  // ==================== validateDataIntegrity ====================

  describe('validateDataIntegrity', () => {
    it('should return valid for well-formed data', () => {
      const projects = [createProject({
        tasks: [createTask({ id: 'task-1' }), createTask({ id: 'task-2' })],
        connections: [createConnection({ source: 'task-1', target: 'task-2' })],
      })];

      const result = service.validateDataIntegrity(projects);

      expect(result.valid).toBe(true);
      expect(result.projectCount).toBe(1);
      expect(result.taskCount).toBe(2);
      expect(result.connectionCount).toBe(1);
    });

    it('should detect missing project ID', () => {
      const projects = [createProject({ id: '' })];

      const result = service.validateDataIntegrity(projects);

      expect(result.valid).toBe(false);
      expect(result.issues.some(i => i.type === 'missing-id' && i.entityType === 'project')).toBe(true);
    });

    it('should detect duplicate project IDs', () => {
      const projects = [
        createProject({ id: 'dup' }),
        createProject({ id: 'dup', name: 'Duplicate' }),
      ];

      const result = service.validateDataIntegrity(projects);

      expect(result.issues.some(i => i.type === 'duplicate-id' && i.entityType === 'project')).toBe(true);
    });

    it('should detect orphan tasks (parent not found)', () => {
      const projects = [createProject({
        tasks: [createTask({ id: 'task-1', parentId: 'nonexistent' })],
      })];

      const result = service.validateDataIntegrity(projects);

      expect(result.issues.some(i => i.type === 'orphan-task')).toBe(true);
    });

    it('should detect broken connections (source or target not found)', () => {
      const projects = [createProject({
        tasks: [createTask({ id: 'task-1' })],
        connections: [createConnection({ source: 'task-1', target: 'missing-task' })],
      })];

      const result = service.validateDataIntegrity(projects);

      expect(result.issues.some(i => i.type === 'broken-connection')).toBe(true);
    });

    it('should detect duplicate task IDs within a project', () => {
      const projects = [createProject({
        tasks: [createTask({ id: 'dup-task' }), createTask({ id: 'dup-task', title: 'Dup' })],
      })];

      const result = service.validateDataIntegrity(projects);

      expect(result.issues.some(i => i.type === 'duplicate-id' && i.entityType === 'task')).toBe(true);
    });

    it('should report missing connection ID as warning', () => {
      const projects = [createProject({
        tasks: [createTask({ id: 't1' }), createTask({ id: 't2' })],
        connections: [{ id: '', source: 't1', target: 't2' }],
      })];

      const result = service.validateDataIntegrity(projects);

      expect(result.issues.some(i => i.type === 'missing-id' && i.entityType === 'connection')).toBe(true);
    });

    it('should send Sentry event when errors are found', () => {
      const projects = [createProject({ id: '' })];

      service.validateDataIntegrity(projects);

      expect(mockSentryLazyLoaderService.captureMessage).toHaveBeenCalled();
    });
  });

  // ==================== verifyMigrationSuccess ====================

  describe('verifyMigrationSuccess', () => {
    it('should succeed when all local data is found remotely', async () => {
      const localProjects = [createProject({
        id: 'proj-1',
        tasks: [createTask({ id: 'task-1' })],
      })];

      mockSyncService.loadProjectsFromCloud.mockResolvedValue([
        { id: 'proj-1', tasks: [{ id: 'task-1' }] },
      ]);

      const result = await service.verifyMigrationSuccess(localProjects, 'user-1');

      expect(result.success).toBe(true);
      expect(result.missingItems).toHaveLength(0);
    });

    it('should report missing projects', async () => {
      const localProjects = [createProject({ id: 'missing-proj' })];

      mockSyncService.loadProjectsFromCloud.mockResolvedValue([]);

      const result = await service.verifyMigrationSuccess(localProjects, 'user-1');

      expect(result.success).toBe(false);
      expect(result.missingItems.length).toBeGreaterThan(0);
    });

    it('should report missing tasks', async () => {
      const localProjects = [createProject({
        id: 'proj-1',
        tasks: [createTask({ id: 'task-1' }), createTask({ id: 'task-missing', title: '' })],
      })];

      mockSyncService.loadProjectsFromCloud.mockResolvedValue([
        { id: 'proj-1', tasks: [{ id: 'task-1' }] },
      ]);

      const result = await service.verifyMigrationSuccess(localProjects, 'user-1');

      expect(result.success).toBe(false);
      expect(result.missingItems.some((m: string) => m.includes('task-missing'))).toBe(true);
    });

    it('should handle remote load failure', async () => {
      mockSyncService.loadProjectsFromCloud.mockResolvedValue(null);

      const result = await service.verifyMigrationSuccess([createProject()], 'user-1');

      expect(result.success).toBe(false);
      expect(result.missingItems.some((m: string) => m.includes('远程数据获取失败'))).toBe(true);
    });

    it('should handle exceptions gracefully', async () => {
      mockSyncService.loadProjectsFromCloud.mockRejectedValue(new Error('Network error'));

      const result = await service.verifyMigrationSuccess([createProject()], 'user-1');

      expect(result.success).toBe(false);
    });
  });
});
