import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  calculateChecksum,
  type BackupData,
} from '../../supabase/functions/_shared/backup-utils';
import { ExternalSourceLinkService } from '../app/core/external-sources/external-source-link.service';
import { ImportService } from './import.service';
import { LayoutService } from './layout.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';

describe('ImportService BackupData checksum validation', () => {
  let service: ImportService;

  beforeEach(() => {
    const injector = Injector.create({
      providers: [
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
              debug: vi.fn(),
            }),
          },
        },
        { provide: ToastService, useValue: {} },
        {
          provide: LayoutService,
          useValue: {
            validateAndFixTree: vi.fn(project => ({ project, issues: [] })),
          },
        },
        {
          provide: ExternalSourceLinkService,
          useValue: { importPointers: vi.fn() },
        },
      ],
    });

    service = runInInjectionContext(injector, () => new ImportService());
  });

  it('accepts an intact BackupData payload with its exported SHA-256 checksum', async () => {
    const backup = await createBackupData();

    const result = await service.validateFile(createBackupFile(backup));

    expect(result.valid).toBe(true);
    expect(result.data?.projects[0]?.tasks[0]?.content).toBe('original content');
  });

  it('rejects a BackupData payload changed after its checksum was generated', async () => {
    const backup = await createBackupData();
    backup.tasks[0].content = 'tampered content';

    const result = await service.validateFile(createBackupFile(backup));

    expect(result).toEqual({
      valid: false,
      error: '本地备份校验和不匹配，数据可能已损坏或被修改',
    });
  });

  it('continues to accept a legacy BackupData payload with no checksum field', async () => {
    const backup = await createBackupData();
    delete backup.checksum;

    const result = await service.validateFile(createBackupFile(backup));

    expect(result.valid).toBe(true);
  });
});

async function createBackupData(): Promise<BackupData> {
  const backup: BackupData = {
    version: '1.0',
    payloadVersion: '1.0',
    type: 'full',
    createdAt: '2026-07-25T00:00:00.000Z',
    checksum: '',
    tableCounts: {
      projects: 1,
      tasks: 1,
      connections: 0,
      userPreferences: 0,
      blackBoxEntries: 0,
      focusSessions: 0,
      transcriptionUsage: 0,
      routineTasks: 0,
      routineCompletions: 0,
    },
    coverage: {
      includesProjectData: true,
      includesCloudUserState: false,
      includesLocalState: false,
    },
    projects: [{ id: 'project-1', userId: 'owner-1', name: 'Project' }],
    tasks: [{
      id: 'task-1',
      projectId: 'project-1',
      title: 'Task',
      content: 'original content',
    }],
    connections: [],
    userPreferences: [],
    blackBoxEntries: [],
    focusSessions: [],
    transcriptionUsage: [],
    routineTasks: [],
    routineCompletions: [],
  };

  backup.checksum = await calculateChecksum(JSON.stringify(backup));
  return backup;
}

function createBackupFile(backup: BackupData): File {
  return new File([JSON.stringify(backup)], 'backup.json', { type: 'application/json' });
}
