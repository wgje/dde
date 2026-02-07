import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RecoveryService, RecoveryPoint } from './recovery.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { SupabaseClientService } from './supabase-client.service';
import { ExportService, ExportData } from './export.service';
import { ImportService } from './import.service';
import { UserSessionService } from './user-session.service';
import { ProjectStateService } from './project-state.service';
import { CACHE_CONFIG } from '../config';
import { Project } from '../models';

function createProject(id: string, name: string): Project {
  const now = new Date().toISOString();
  return {
    id,
    name,
    description: '',
    createdDate: now,
    updatedAt: now,
    tasks: [],
    connections: [],
  };
}

function createExportData(projects: Project[]): ExportData {
  return {
    metadata: {
      exportedAt: new Date().toISOString(),
      version: '2.0',
      appVersion: 'test',
      projectCount: projects.length,
      taskCount: 0,
      connectionCount: 0,
      attachmentCount: 0,
      checksum: 'checksum',
      exportType: 'full',
    },
    projects: projects.map(project => ({
      id: project.id,
      name: project.name,
      description: project.description,
      tasks: [],
      connections: [],
      createdAt: project.createdDate,
      updatedAt: project.updatedAt,
    })),
  };
}

describe('RecoveryService', () => {
  let service: RecoveryService;
  let importMock: {
    validateFile: ReturnType<typeof vi.fn>;
    executeImport: ReturnType<typeof vi.fn>;
  };
  let projectStateMock: {
    projects: ReturnType<typeof vi.fn>;
    setProjects: ReturnType<typeof vi.fn>;
  };
  let downloadMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();

    const loggerCategory = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    downloadMock = vi.fn().mockResolvedValue({
      data: new Blob(['{}'], { type: 'application/json' }),
      error: null,
    });

    const supabaseMock = {
      client: vi.fn().mockReturnValue({
        storage: {
          from: vi.fn().mockReturnValue({
            download: downloadMock,
          }),
        },
      }),
    };

    importMock = {
      validateFile: vi.fn(),
      executeImport: vi.fn(),
    };

    projectStateMock = {
      projects: vi.fn().mockReturnValue([]),
      setProjects: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        RecoveryService,
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn().mockReturnValue(loggerCategory),
          },
        },
        {
          provide: ToastService,
          useValue: {
            success: vi.fn(),
            warning: vi.fn(),
            error: vi.fn(),
          },
        },
        { provide: SentryLazyLoaderService, useValue: { captureException: vi.fn() } },
        { provide: SupabaseClientService, useValue: supabaseMock },
        { provide: ExportService, useValue: { exportAllProjects: vi.fn() } },
        { provide: ImportService, useValue: importMock },
        { provide: UserSessionService, useValue: { currentUserId: vi.fn().mockReturnValue('user-1') } },
        { provide: ProjectStateService, useValue: projectStateMock },
      ],
    });

    service = TestBed.inject(RecoveryService);

    const point: RecoveryPoint = {
      id: 'point-1',
      type: 'full',
      timestamp: new Date().toISOString(),
      projectCount: 2,
      taskCount: 0,
      size: 100,
      path: 'user-1/backup.json',
    };
    (service as unknown as { _recoveryPoints: { set: (points: RecoveryPoint[]) => void } })
      ._recoveryPoints
      .set([point]);
  });

  it('scope=project 时应只导入指定项目并更新本地状态', async () => {
    const existingProjects = [createProject('p-1', 'Local A'), createProject('p-2', 'Local B')];
    const backupProjects = [createProject('p-1', 'Backup A'), createProject('p-2', 'Backup B')];
    projectStateMock.projects.mockReturnValue(existingProjects);

    const backupData = createExportData(backupProjects);
    importMock.validateFile.mockResolvedValue({ valid: true, data: backupData });
    importMock.executeImport.mockImplementation(
      async (
        data: ExportData,
        _existing: Project[],
        _options: { conflictStrategy: string },
        onProjectImported?: (project: Project) => Promise<void>
      ) => {
        if (onProjectImported) {
          await onProjectImported(createProject(data.projects[0].id, data.projects[0].name));
        }
        return {
          success: true,
          importedCount: 1,
          skippedCount: 0,
          failedCount: 0,
          details: [],
          durationMs: 1,
        };
      }
    );

    const result = await service.executeRecovery('point-1', {
      mode: 'merge',
      scope: 'project',
      projectId: 'p-2',
      createSnapshot: false,
    });

    expect(result.success).toBe(true);
    expect(importMock.executeImport).toHaveBeenCalledWith(
      expect.objectContaining({
        projects: [expect.objectContaining({ id: 'p-2' })],
      }),
      existingProjects,
      expect.objectContaining({ conflictStrategy: 'merge' }),
      expect.any(Function)
    );
    expect(projectStateMock.setProjects).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'p-1', name: 'Local A' }),
      expect.objectContaining({ id: 'p-2', name: 'Backup B' }),
    ]);
  });

  it('当前内存项目为空时应回退读取 OFFLINE_CACHE_KEY 作为 existingProjects', async () => {
    const fallbackProjects = [createProject('offline-1', 'Offline Project')];
    localStorage.setItem(
      CACHE_CONFIG.OFFLINE_CACHE_KEY,
      JSON.stringify({ projects: fallbackProjects, version: 2 })
    );
    projectStateMock.projects.mockReturnValue([]);

    const backupData = createExportData([createProject('backup-1', 'Backup Project')]);
    importMock.validateFile.mockResolvedValue({ valid: true, data: backupData });
    importMock.executeImport.mockResolvedValue({
      success: true,
      importedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      details: [],
      durationMs: 1,
    });

    await service.executeRecovery('point-1', {
      mode: 'merge',
      scope: 'all',
      createSnapshot: false,
    });

    expect(importMock.executeImport).toHaveBeenCalledWith(
      expect.any(Object),
      fallbackProjects,
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('scope=project 且缺少 projectId 时应直接失败', async () => {
    const result = await service.executeRecovery('point-1', {
      mode: 'replace',
      scope: 'project',
      createSnapshot: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('projectId');
    expect(downloadMock).not.toHaveBeenCalled();
  });
});
