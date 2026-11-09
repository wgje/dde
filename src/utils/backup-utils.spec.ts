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

  it('BackupLocalState should carry a typed data-safety snapshot for restore/replay/explain', () => {
    const payload = createBackupData({
      coverage: {
        includesProjectData: true,
        includesCloudUserState: true,
        includesLocalState: true,
      },
      localState: {
        dataSafety: {
          schemaVersion: '1.0.0',
          exportedAt: '2026-06-16T00:00:00.000Z',
          ownerUserId: 'user-1',
          syncSnapshot: {
            syncState: {
              lastSyncTime: '2026-06-16T00:00:00.000Z',
              pendingCount: 1,
            },
            projectCursors: [],
            queueCounts: {
              retryQueue: 1,
              actionQueue: 0,
              deadLetters: 0,
            },
          },
          replayLog: [
            {
              operationId: 'op-1',
              entityType: 'task',
              entityId: 'task-1',
              operation: 'upsert',
              localCommittedAt: 1781539200000,
              queue: { enteredRetryQueue: true, retryCount: 0 },
              rpc: { status: 'remote-newer' },
              lww: { decision: 'remote-kept', reason: 'remote-newer' },
              lastSyncTime: { before: null, after: null, advanced: false },
            },
          ],
          replayPlan: {
            idempotencyKey: 'a'.repeat(64),
            ownerUserId: 'user-1',
            exportedAt: '2026-06-16T00:00:00.000Z',
            steps: [
              {
                source: 'retryQueue',
                operationId: 'op-1',
                entityType: 'task',
                entityId: 'task-1',
                operation: 'upsert',
                replayable: true,
                reason: 'retry-queue-restored',
                localTimestamp: 1781539200000,
                retryCount: 0,
                queue: { enteredRetryQueue: true, retryCount: 0 },
                rpc: { status: 'pending-retry' },
                lww: { decision: 'unknown', reason: 'retryQueue' },
                lastSyncTime: { before: null, after: null, advanced: false },
              },
            ],
            summary: {
              replayable: 1,
              inspectOnly: 0,
              retryQueue: 1,
              actionQueue: 0,
              auditLog: 0,
            },
          },
          lastWriteExplain: {
            operationId: 'op-1',
            actor: { sourceUserId: 'user-1' },
            entity: { type: 'task', id: 'task-1' },
            operation: 'upsert',
            localTimestamp: 1781539200000,
            queueResult: { enteredRetryQueue: true, retryCount: 0 },
            rpcResult: { status: 'remote-newer' },
            lwwDecision: { decision: 'remote-kept', reason: 'remote-newer' },
            lastSyncTime: { before: null, after: null, advanced: false },
          },
        },
      },
    });

    expect(payload.localState?.dataSafety?.replayLog[0]?.operationId).toBe('op-1');
    expect(validateBackup(payload).ok).toBe(true);
  });
});
