import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Injector } from '@angular/core';
import { MigrationService } from './migration.service';
import { MigrationIntegrityService } from './migration-integrity.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { SimpleSyncService } from '../app/core/services/simple-sync.service';
import { Project, Task } from '../models';

const mockLoggerCategory = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
};

function createProject(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? crypto.randomUUID(),
    name: overrides.name ?? 'Test',
    description: overrides.description ?? '',
    createdDate: overrides.createdDate ?? now,
    tasks: overrides.tasks ?? [],
    connections: overrides.connections ?? [],
    updatedAt: overrides.updatedAt ?? now,
    version: overrides.version ?? 1,
  };
}

describe('MigrationService', () => {
  let service: MigrationService;
  let mockIntegrity: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    mockIntegrity = {
      saveMigrationSnapshot: vi.fn(),
      clearMigrationSnapshot: vi.fn(),
      recoverFromSnapshot: vi.fn().mockReturnValue(null),
      updateMigrationStatus: vi.fn(),
      getMigrationStatus: vi.fn().mockReturnValue(null),
      clearMigrationStatus: vi.fn(),
      hasUnfinishedMigration: vi.fn().mockReturnValue(false),
      statusToPhase: vi.fn().mockReturnValue('idle'),
      validateDataIntegrity: vi.fn().mockReturnValue({ valid: true, issues: [] }),
      verifyMigrationSuccess: vi.fn().mockResolvedValue({ success: true, missingItems: [] }),
      offerSnapshotDownload: vi.fn(),
    };

    const injector = Injector.create({
      providers: [
        { provide: MigrationService, useClass: MigrationService },
        { provide: MigrationIntegrityService, useValue: mockIntegrity },
        { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
        { provide: ToastService, useValue: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() } },
        { provide: SentryLazyLoaderService, useValue: { captureException: vi.fn() } },
        { provide: SimpleSyncService, useValue: { pushProject: vi.fn().mockResolvedValue({ ok: true }) } },
      ],
    });

    service = injector.get(MigrationService);
  });

  describe('checkMigrationNeeded', () => {
    it('无本地数据时不需要迁移', () => {
      expect(service.checkMigrationNeeded([])).toBe(false);
    });

    it('有本地数据且远程无对应项目时需要迁移', () => {
      const localProj = createProject({ name: 'Local Only' });
      service.saveGuestData([localProj]);
      expect(service.checkMigrationNeeded([])).toBe(true);
    });

    it('本地和远程项目完全一致时不需要迁移', () => {
      const proj = createProject();
      service.saveGuestData([proj]);
      expect(service.checkMigrationNeeded([proj])).toBe(false);
    });
  });

  describe('saveGuestData / getLocalGuestData', () => {
    it('保存后可以读取', () => {
      const projects = [createProject({ name: 'Saved' })];
      service.saveGuestData(projects);
      const loaded = service.getLocalGuestData();
      expect(loaded).toBeTruthy();
      expect(loaded!.length).toBe(1);
      expect(loaded![0].name).toBe('Saved');
    });

    it('无保存数据时返回 null', () => {
      // clear first
      service.clearLocalGuestData();
      const loaded = service.getLocalGuestData();
      expect(loaded).toBeNull();
    });
  });

  describe('clearLocalGuestData', () => {
    it('清除后 getLocalGuestData 返回 null', () => {
      service.saveGuestData([createProject()]);
      service.clearLocalGuestData();
      expect(service.getLocalGuestData()).toBeNull();
    });
  });

  describe('getMigrationStatus / clearMigrationStatus / hasUnfinishedMigration', () => {
    it('状态委托到 integrity service', () => {
      service.getMigrationStatus();
      expect(mockIntegrity['getMigrationStatus']).toHaveBeenCalled();
    });

    it('清除状态委托到 integrity service', () => {
      service.clearMigrationStatus();
      expect(mockIntegrity['clearMigrationStatus']).toHaveBeenCalled();
    });

    it('未完成迁移检查委托到 integrity service', () => {
      service.hasUnfinishedMigration();
      expect(mockIntegrity['hasUnfinishedMigration']).toHaveBeenCalled();
    });
  });

  describe('validateDataIntegrity', () => {
    it('委托到 integrity service', () => {
      const projects = [createProject()];
      service.validateDataIntegrity(projects);
      expect(mockIntegrity['validateDataIntegrity']).toHaveBeenCalledWith(projects);
    });
  });

  describe('recoverFromSnapshot', () => {
    it('委托到 integrity service', () => {
      service.recoverFromSnapshot();
      expect(mockIntegrity['recoverFromSnapshot']).toHaveBeenCalled();
    });
  });

  describe('getMigrationSummary', () => {
    it('返回摘要对象', () => {
      const summary = service.getMigrationSummary();
      expect(summary).toHaveProperty('localCount');
      expect(summary).toHaveProperty('remoteCount');
    });
  });
});
