import { describe, expect, it } from 'vitest';
import {
  BACKUP_CONFIG,
  buildTableCounts,
  type BackupData,
  validateBackup,
} from '../../supabase/functions/_shared/backup-utils';

function createBackupData(overrides: Partial<BackupData> = {}): BackupData {
  const base: BackupData = {
    version: BACKUP_CONFIG.VERSION,
    payloadVersion: BACKUP_CONFIG.VERSION,
    type: 'full',
    createdAt: '2026-03-19T00:00:00.000Z',
    checksum: '',
    tableCounts: {
      projects: 1,
      tasks: 1,
      connections: 1,
      userPreferences: 1,
      blackBoxEntries: 2,
      focusSessions: 1,
      transcriptionUsage: 1,
      routineTasks: 1,
      routineCompletions: 1,
    },
    coverage: {
      includesProjectData: true,
      includesCloudUserState: true,
      includesLocalState: false,
    },
    projects: [
      {
        id: 'project-1',
        userId: 'user-1',
        name: 'Inbox',
      },
    ],
    tasks: [
      {
        id: 'task-1',
        projectId: 'project-1',
        title: 'Task A',
      },
    ],
    connections: [
      {
        id: 'conn-1',
        projectId: 'project-1',
        source: 'task-1',
        target: 'task-1',
      },
    ],
    userPreferences: [
      {
        id: 'pref-1',
        userId: 'user-1',
      },
    ],
    blackBoxEntries: [
      {
        id: 'bb-project',
        userId: 'user-1',
        projectId: 'project-1',
        content: 'Project note',
      },
      {
        id: 'bb-shared',
        userId: 'user-1',
        projectId: null,
        content: 'Shared note',
      },
    ],
    focusSessions: [
      {
        id: 'focus-1',
        userId: 'user-1',
        startedAt: '2026-03-19T00:00:00.000Z',
        sessionState: { version: 7 },
      },
    ],
    transcriptionUsage: [
      {
        id: 'usage-1',
        userId: 'user-1',
        date: '2026-03-19',
        audioSeconds: 120,
      },
    ],
    routineTasks: [
      {
        id: 'routine-1',
        userId: 'user-1',
        title: 'Stretch',
        maxTimesPerDay: 2,
        isEnabled: true,
      },
    ],
    routineCompletions: [
      {
        id: 'completion-1',
        routineId: 'routine-1',
        userId: 'user-1',
        dateKey: '2026-03-19',
        count: 1,
      },
    ],
  };

  const payload = { ...base, ...overrides };
  payload.tableCounts = buildTableCounts(payload);
  return payload;
}

describe('backup-utils', () => {
  it('buildTableCounts should cover all v2 data segments', () => {
    const counts = buildTableCounts(createBackupData());
    expect(counts).toEqual({
      projects: 1,
      tasks: 1,
      connections: 1,
      userPreferences: 1,
      blackBoxEntries: 2,
      focusSessions: 1,
      transcriptionUsage: 1,
      routineTasks: 1,
      routineCompletions: 1,
    });
  });

  it('validateBackup should reject payloads missing required v2 tables', () => {
    const broken = createBackupData({
      focusSessions: undefined as unknown as BackupData['focusSessions'],
    });

    const result = validateBackup(broken);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('缺少必需的数据表 (projects, tasks, connections)');
  });

  it('validateBackup should block abnormal drops in extra user-state tables', () => {
    const current = createBackupData({
      blackBoxEntries: [],
    });

    const result = validateBackup(current, {
      taskCount: 1,
      tableCounts: {
        blackBoxEntries: 12,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('blackBoxEntries'))).toBe(true);
  });
});
