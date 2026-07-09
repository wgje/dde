import { describe, expect, it } from 'vitest';

import type { BackupData } from '../../supabase/functions/_shared/backup-utils';
import type { ExportData } from './export.service';
import {
  validateImportDataStructure,
  validateImportVersion,
} from './import-data-validation.helpers';

describe('import data validation helpers', () => {
  it('converts local backup payloads into export data during structure validation', () => {
    const backupData: BackupData = {
      blackBoxEntries: [],
      connections: [],
      coverage: {
        includesCloudUserState: false,
        includesLocalState: false,
        includesProjectData: true,
      },
      createdAt: '2026-06-01T00:00:00.000Z',
      focusSessions: [],
      payloadVersion: '1',
      projects: [{
        id: 'project-1',
        userId: 'user-import-validation',
        name: 'Imported Project',
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
      }],
      routineCompletions: [],
      routineTasks: [],
      tableCounts: {
        blackBoxEntries: 0,
        connections: 0,
        focusSessions: 0,
        projects: 1,
        routineCompletions: 0,
        routineTasks: 0,
        tasks: 0,
        transcriptionUsage: 0,
        userPreferences: 0,
      },
      tasks: [],
      transcriptionUsage: [],
      type: 'full',
      userPreferences: [],
      version: '1',
    };

    const result = validateImportDataStructure(backupData);

    expect(result.valid).toBe(true);
    expect(result.data?.metadata.version).toBe('1');
    expect(result.data?.projects).toHaveLength(1);
    expect(result.data?.projects[0].name).toBe('Imported Project');
  });

  it('rejects malformed export data before import execution', () => {
    expect(validateImportDataStructure(null)).toEqual({
      valid: false,
      error: '无效的数据格式',
    });
    expect(validateImportDataStructure({ projects: [] })).toEqual({
      valid: false,
      error: '缺少元数据',
    });
    expect(validateImportDataStructure({
      metadata: { version: '2.1' },
      projects: [{ id: 'project-1' }],
    })).toEqual({
      valid: false,
      error: '项目缺少必需字段 (id, name)',
    });
  });

  it('validates import version boundaries', () => {
    const exportData = {
      metadata: {
        appVersion: 'test',
        attachmentCount: 0,
        checksum: 'checksum',
        connectionCount: 0,
        exportedAt: '2026-06-01T00:00:00.000Z',
        exportType: 'full',
        projectCount: 0,
        taskCount: 0,
        version: '2.1',
      },
      projects: [],
    } satisfies ExportData;

    expect(validateImportVersion(exportData.metadata.version)).toEqual({ valid: true });
    expect(validateImportVersion('0.9')).toEqual({
      valid: false,
      error: '版本过低，最低支持 v1.0',
    });
    expect(validateImportVersion('2.2')).toEqual({
      valid: false,
      error: '版本过高，最高支持 v2.1',
    });
    expect(validateImportVersion('not-a-version')).toEqual({
      valid: false,
      error: '无效的版本号',
    });
  });
});
