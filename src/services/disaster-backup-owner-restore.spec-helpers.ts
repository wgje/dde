import { Injector, signal } from '@angular/core';
import { expect, it, vi } from 'vitest';

import type { Project } from '../models';
import { ExternalSourceCacheService } from '../app/core/external-sources/external-source-cache.service';
import { ExternalSourceLinkService } from '../app/core/external-sources/external-source-link.service';
import { AuthService } from './auth.service';
import { BlackBoxService } from './black-box.service';
import { ConflictStorageService } from './conflict-storage.service';
import { DisasterBackupService } from './disaster-backup.service';
import { FocusPreferenceService } from './focus-preference.service';
import { LoggerService } from './logger.service';
import { PreferenceService } from './preference.service';
import { SupabaseClientService } from './supabase-client.service';
import { ThemeService } from './theme.service';
import { UiStateService } from './ui-state.service';
import type { QueuedAction } from './action-queue.types';

interface DisasterBackupOwnerRestoreSpecContext {
  createBackupTableClient: (
    tableData: Record<string, unknown[]>,
    options?: { error?: unknown },
  ) => { client: unknown };
  createProject: () => Project;
  seedStore: (
    dbName: string,
    version: number,
    ensureStores: (db: IDBDatabase) => void,
    writer: (db: IDBDatabase) => Promise<void>,
  ) => Promise<void>;
}

export function registerDisasterBackupOwnerRestoreSpecs(
  context: DisasterBackupOwnerRestoreSpecContext,
): void {
  const { createBackupTableClient, createProject, seedStore } = context;

  it('buildLocalPayload should include full v2 business data and localState coverage', async () => {
    const blackBoxRow = {
      id: '11111111-1111-4111-8111-111111111111', projectId: null, userId: 'user-1',
      content: 'black-box', date: '2026-03-06',
      createdAt: '2026-03-06T00:00:00.000Z', updatedAt: '2026-03-06T00:00:00.000Z',
      completedAt: null, isRead: false, isCompleted: false, isArchived: false,
      snoozeUntil: null, snoozeCount: 0, deletedAt: null, focusMeta: null,
    };
    localStorage.setItem('nanoflow.offline-cache-v2.user-1', JSON.stringify({
      projects: [{ id: 'offline-project' }],
    }));
    localStorage.setItem('nanoflow.offline-cache-v2', JSON.stringify({
      projects: [{ id: 'foreign-legacy-offline-project' }],
    }));
    localStorage.setItem('nanoflow.action-queue.user-1', JSON.stringify([
      {
        id: 'action-1',
        operationId: 'action-operation-1',
        type: 'delete',
        entityType: 'task',
        entityId: 'task-1',
        payload: {
          taskId: 'task-1',
          projectId: 'project-1',
          sourceUserId: 'user-1',
          baseUpdatedAt: null,
        },
        timestamp: 124,
        retryCount: 0,
      } satisfies QueuedAction,
    ]));
    localStorage.setItem('nanoflow.dead-letter-queue.user-1', JSON.stringify([
      { action: { id: 'dead-1' }, reason: 'failed' },
    ]));
    localStorage.setItem('nanoflow.action-queue.user-2', JSON.stringify([
      {
        id: 'action-foreign',
        operationId: 'action-operation-foreign',
        type: 'delete',
        entityType: 'task',
        entityId: 'task-foreign',
        payload: {
          taskId: 'task-foreign',
          projectId: 'project-2',
          sourceUserId: 'user-2',
          baseUpdatedAt: null,
        },
        timestamp: 457,
        retryCount: 0,
      } satisfies QueuedAction,
    ]));
    localStorage.setItem('nanoflow.dead-letter-queue.user-2', JSON.stringify([
      { action: { id: 'dead-foreign' }, reason: 'foreign' },
    ]));
    localStorage.setItem('nanoflow.data-safety-audit.user-1', JSON.stringify({
      replayLog: [
        {
          operationId: 'audit-op-1',
          entityType: 'task',
          entityId: 'task-1',
          operation: 'upsert',
          sourceUserId: 'user-1',
          localCommittedAt: 1781539200000,
          queue: { enteredRetryQueue: false, retryCount: 0 },
          rpc: { status: 'applied', serverUpdatedAt: '2026-06-16T00:00:01.000Z' },
          lww: { decision: 'local-applied', reason: 'applied' },
          lastSyncTime: { before: null, after: '2026-06-16T00:00:01.000Z', advanced: true },
        },
      ],
      lastWriteExplain: {
        operationId: 'audit-op-1',
        actor: { sourceUserId: 'user-1' },
        entity: { type: 'task', id: 'task-1' },
        operation: 'upsert',
        localTimestamp: 1781539200000,
        queueResult: { enteredRetryQueue: false, retryCount: 0 },
        rpcResult: { status: 'applied', serverUpdatedAt: '2026-06-16T00:00:01.000Z' },
        lwwDecision: { decision: 'local-applied', reason: 'applied' },
        lastSyncTime: { before: null, after: '2026-06-16T00:00:01.000Z', advanced: true },
      },
    }));
    localStorage.setItem('nanoflow.dock-snapshot.v3.user-1', JSON.stringify({
      savedAt: '2026-03-10T00:00:00.000Z',
      session: { mainTaskId: 'task-1' },
    }));
    localStorage.setItem('nanoflow.dock-snapshot.v3.user-2', JSON.stringify({
      savedAt: '2026-03-11T00:00:00.000Z',
      session: { mainTaskId: 'foreign-task' },
    }));
    localStorage.setItem('nanoflow.launch-snapshot.v1', JSON.stringify({
      version: 1,
      userId: 'user-2',
      activeProjectId: 'project-2',
    }));
    localStorage.setItem('nanoflow.launch-snapshot.v2', JSON.stringify({
      version: 2,
      userId: 'user-1',
      activeProjectId: 'project-1',
      savedAt: '2026-03-10T00:00:00.000Z',
    }));
    localStorage.setItem('nanoflow.local-tombstones', JSON.stringify({
      'project-1': { 'task-deleted': 123 },
      'project-2': { 'task-deleted-foreign': 456 },
    }));
    localStorage.setItem('nanoflow.local-connection-tombstones', JSON.stringify([
      { projectId: 'project-1', connectionId: 'conn-deleted', timestamp: Date.parse('2026-03-07T00:00:00.000Z') },
      { projectId: 'project-2', connectionId: 'conn-deleted-foreign', timestamp: Date.parse('2026-03-07T00:00:00.000Z') },
    ]));

    await seedStore(
      'nanoflow-offline-snapshots',
      1,
      (db) => {
        if (!db.objectStoreNames.contains('snapshots')) {
          db.createObjectStore('snapshots', { keyPath: 'id' });
        }
      },
      async (db) => {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('snapshots', 'readwrite');
          tx.objectStore('snapshots').put({
            id: 'offline-snapshot:user-1',
            ownerUserId: 'user-1',
            data: JSON.stringify({ projects: [{ id: 'snapshot-project' }] }),
          });
          tx.objectStore('snapshots').put({
            id: 'offline-snapshot',
            data: JSON.stringify({ projects: [{ id: 'foreign-legacy-snapshot-project' }] }),
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      },
    );

    await seedStore(
      'focus_mode',
      3,
      (db) => {
        if (!db.objectStoreNames.contains('black_box_entries')) {
          db.createObjectStore('black_box_entries', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('sync_metadata')) {
          db.createObjectStore('sync_metadata', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('parked_tasks')) {
          db.createObjectStore('parked_tasks', { keyPath: 'taskId' });
        }
      },
      async (db) => {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(
            ['black_box_entries', 'sync_metadata', 'parked_tasks'],
            'readwrite',
          );
          tx.objectStore('black_box_entries').put({ ...blackBoxRow, _localVersion: 1 });
          tx.objectStore('sync_metadata').put({ key: 'parking_last_sync_time:user-1', value: 'cursor-1' });
          tx.objectStore('sync_metadata').put({ key: 'parking_last_sync_time:user-2', value: 'cursor-2' });
          tx.objectStore('parked_tasks').put({
            ownerUserId: 'user-1',
            taskId: 'user-1:task-parked',
            projectId: 'project-1',
            updatedAt: '2026-03-08T00:00:00.000Z',
            task: { id: 'task-parked', title: 'Parked', content: 'Parked content' },
          });
          tx.objectStore('parked_tasks').put({
            ownerUserId: 'user-2',
            taskId: 'user-2:task-parked-foreign',
            projectId: 'project-1',
            parkedAt: '2026-03-09T00:00:00.000Z',
            task: { id: 'task-parked-foreign', title: 'Foreign Parked' },
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      },
    );

    await seedStore(
      'nanoflow-retry-queue',
      1,
      (db) => {
        if (!db.objectStoreNames.contains('offline_mutation_queue')) {
          db.createObjectStore('offline_mutation_queue', { keyPath: 'id' });
        }
      },
      async (db) => {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('offline_mutation_queue', 'readwrite');
          tx.objectStore('offline_mutation_queue').put({
            id: 'retry-1',
            operationId: 'retry-operation-1',
            type: 'blackbox',
            operation: 'upsert',
            data: {
              id: 'bb-inline-retry',
              content: 'Inline Temp',
              focusMeta: {
                source: 'focus-console-inline',
                sessionId: 'focus-session-1',
                title: 'Inline Temp',
                detail: null,
                lane: 'backup',
                expectedMinutes: null,
                waitMinutes: null,
                cognitiveLoad: 'low',
                dockEntryId: 'dock-inline-1',
              },
            },
            projectId: null,
            retryCount: 1,
            createdAt: 123,
            sourceUserId: 'user-1',
          });
          tx.objectStore('offline_mutation_queue').put({
            id: 'retry-foreign',
            operationId: 'retry-operation-foreign',
            type: 'task',
            operation: 'upsert',
            data: { id: 'task-foreign' },
            projectId: 'project-2',
            retryCount: 1,
            createdAt: 456,
            sourceUserId: 'user-2',
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      },
    );

    await seedStore(
      'keyval-store',
      1,
      (db) => {
        if (!db.objectStoreNames.contains('keyval')) {
          db.createObjectStore('keyval');
        }
      },
      async (db) => {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('keyval', 'readwrite');
          tx.objectStore('keyval').put({
            savedAt: '2026-03-10T00:00:00.000Z',
            entries: [{ taskId: 'task-1', lane: 'command' }],
          }, 'nanoflow.focus-session.v5.user-1');
          tx.objectStore('keyval').put({
            savedAt: '2026-03-11T00:00:00.000Z',
            entries: [{ taskId: 'foreign-task', lane: 'backup' }],
          }, 'nanoflow.focus-session.v5.user-2');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      },
    );

    const tableData: Record<string, unknown[]> = {
      user_preferences: [
        {
          id: 'pref-1',
          user_id: 'user-1',
          created_at: '2026-03-01T00:00:00.000Z',
          updated_at: '2026-03-02T00:00:00.000Z',
        },
      ],
      focus_sessions: [
        {
          id: 'focus-1',
          user_id: 'user-1',
          started_at: '2026-03-03T00:00:00.000Z',
          ended_at: null,
          session_state: { version: 7 },
          updated_at: '2026-03-03T00:05:00.000Z',
        },
      ],
      transcription_usage: [
        {
          id: 'usage-1',
          user_id: 'user-1',
          date: '2026-03-04',
          audio_seconds: 120,
          created_at: '2026-03-04T00:00:00.000Z',
        },
      ],
      routine_tasks: [
        {
          id: 'routine-1',
          user_id: 'user-1',
          title: 'Stretch',
          max_times_per_day: 2,
          is_enabled: true,
          created_at: '2026-03-05T00:00:00.000Z',
          updated_at: '2026-03-05T00:10:00.000Z',
        },
      ],
      routine_completions: [
        {
          id: 'completion-1',
          routine_id: 'routine-1',
          user_id: 'user-1',
          date_key: '2026-03-05',
          count: 2,
          updated_at: '2026-03-05T00:15:00.000Z',
        },
      ],
    };

    const { client } = createBackupTableClient(tableData);

    const focusPreferences = {
      gateEnabled: true,
      strataEnabled: true,
      blackBoxEnabled: true,
      maxSnoozePerDay: 3,
      routineResetHourLocal: 6,
      restReminderHighLoadMinutes: 120,
      restReminderLowLoadMinutes: 20,
    };
    const conflictStorage = {
      getAllConflicts: vi.fn().mockResolvedValue([
        {
          projectId: 'project-1',
          ownerUserId: 'user-1',
          localProject: createProject(),
          remoteProject: undefined,
          conflictedAt: '2026-03-10T00:00:00.000Z',
          localVersion: 2,
          reason: 'field_conflict',
          conflictedFields: ['title'],
          acknowledged: false,
        },
      ]),
    };

    const injector = Injector.create({
      providers: [
        { provide: DisasterBackupService, useClass: DisasterBackupService },
        { provide: LoggerService, useValue: { category: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } },
        { provide: AuthService, useValue: { currentUserId: vi.fn(() => 'user-1') } },
        { provide: ThemeService, useValue: { theme: signal('forest'), colorMode: signal('dark') } },
        { provide: UiStateService, useValue: { layoutDirection: signal('rtl'), floatingWindowPref: signal('fixed') } },
        { provide: PreferenceService, useValue: { autoResolveConflicts: signal(false) } },
        { provide: FocusPreferenceService, useValue: { preferences: signal(focusPreferences), getPreferences: vi.fn(() => focusPreferences) } },
        {
          provide: BlackBoxService,
          useValue: {
            entriesMap: signal(new Map<string, unknown>([
              [blackBoxRow.id, blackBoxRow],
              ['bb-foreign', {
                id: 'bb-foreign',
                projectId: null,
                userId: 'user-2',
                content: 'foreign-black-box',
                date: '2026-03-06',
                createdAt: '2026-03-06T00:00:00.000Z',
                updatedAt: '2026-03-06T00:00:00.000Z',
                isRead: false,
                isCompleted: false,
                isArchived: false,
                deletedAt: null,
              }],
            ])),
          },
        },
        { provide: ConflictStorageService, useValue: conflictStorage },
        { provide: SupabaseClientService, useValue: { isConfigured: true, client: vi.fn(() => client) } },
        { provide: ExternalSourceLinkService, useValue: { ensureLoaded: vi.fn().mockResolvedValue(undefined), activeLinksForTask: vi.fn(() => []) } },
        { provide: ExternalSourceCacheService, useValue: { loadPendingLinks: vi.fn().mockResolvedValue([]) } },
      ],
    });

    const service = injector.get(DisasterBackupService);
    const payload = await service.buildLocalPayload([createProject()], {
      autoBackupEnabled: true,
      autoBackupIntervalMs: 900000,
    });

    expect(payload.payloadVersion).toBe('2.0.0');
    expect(payload.projects).toHaveLength(1);
    expect(payload.tasks).toHaveLength(1);
    expect(payload.connections).toHaveLength(1);
    expect(payload.tasks[0]).toEqual(expect.objectContaining({
      expected_minutes: 30,
      cognitive_load: 'high',
      wait_minutes: null,
      parkingMeta: expect.objectContaining({ state: 'parked' }),
      attentionMeta: expect.objectContaining({
        items: [expect.objectContaining({ id: 'attention-1', text: '检查灾备字段' })],
      }),
    }));
    expect(payload.userPreferences).toEqual([
      expect.objectContaining({
        id: 'pref-1',
        userId: 'user-1',
        theme: 'forest',
        layoutDirection: 'rtl',
        floatingWindowPref: 'fixed',
        colorMode: 'dark',
        autoResolveConflicts: false,
        localBackupEnabled: true,
        localBackupIntervalMs: 900000,
        focusPreferences,
      }),
    ]);
    expect(payload.blackBoxEntries).toEqual([
      expect.objectContaining({ id: blackBoxRow.id, content: 'black-box' }),
    ]);
    expect(payload.tableCounts.blackBoxEntries).toBe(1);
    expect(payload.blackBoxEntries).not.toEqual([
      expect.objectContaining({ id: 'bb-foreign', content: 'foreign-black-box' }),
    ]);
    expect(payload.focusSessions).toHaveLength(1);
    expect(payload.transcriptionUsage).toHaveLength(1);
    expect(payload.routineTasks).toHaveLength(1);
    expect(payload.routineCompletions).toHaveLength(1);
    expect(payload.localState).toEqual(
      expect.objectContaining({
        offlineSnapshot: expect.objectContaining({
          localStorage: JSON.stringify({ projects: [{ id: 'offline-project' }] }),
          indexedDb: JSON.stringify({ projects: [{ id: 'snapshot-project' }] }),
        }),
        dockSnapshot: expect.objectContaining({
          localStorage: JSON.stringify({
            savedAt: '2026-03-10T00:00:00.000Z',
            session: { mainTaskId: 'task-1' },
          }),
          indexedDb: expect.objectContaining({
            savedAt: '2026-03-10T00:00:00.000Z',
            entries: [expect.objectContaining({ taskId: 'task-1', lane: 'command' })],
          }),
        }),
        launchSnapshot: expect.objectContaining({
          v1: null,
          v2: JSON.stringify({
            version: 2,
            userId: 'user-1',
            activeProjectId: 'project-1',
            savedAt: '2026-03-10T00:00:00.000Z',
          }),
        }),
        parkedTaskCache: expect.objectContaining({
          entries: [expect.objectContaining({
            ownerUserId: 'user-1',
            taskId: 'user-1:task-parked',
            projectId: 'project-1',
          })],
          syncMetadata: { 'parking_last_sync_time:user-1': 'cursor-1' },
        }),
        retryQueue: [expect.objectContaining({ id: 'retry-1' })],
        actionQueue: [expect.objectContaining({ id: 'action-1' })],
        deadLetters: [expect.objectContaining({ reason: 'failed' })],
        conflicts: [expect.objectContaining({ projectId: 'project-1', reason: 'field_conflict' })],
        taskTombstones: { 'project-1': { 'task-deleted': 123 } },
        connectionTombstones: [expect.objectContaining({ connectionId: 'conn-deleted' })],
        dataSafety: expect.objectContaining({
          schemaVersion: '1.0.0',
          ownerUserId: 'user-1',
          syncSnapshot: expect.objectContaining({
            syncState: expect.objectContaining({
              lastSyncTime: null,
              pendingCount: 2,
            }),
            queueCounts: {
              retryQueue: 1,
              actionQueue: 1,
              deadLetters: 1,
            },
          }),
          replayLog: expect.arrayContaining([
            expect.objectContaining({
              operationId: 'audit-op-1',
              entityType: 'task',
            }),
            expect.objectContaining({
              operationId: expect.any(String),
              entityType: 'blackbox',
            }),
            expect.objectContaining({
              operationId: expect.any(String),
              entityType: 'task',
            }),
          ]),
          replayPlan: expect.objectContaining({
            idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
            summary: {
              replayable: 2,
              inspectOnly: 1,
              retryQueue: 1,
              actionQueue: 1,
              auditLog: 1,
            },
            steps: expect.arrayContaining([
              expect.objectContaining({
                source: 'auditLog',
                replayable: false,
                reason: 'recent-audit-inspection-only',
              }),
              expect.objectContaining({
                source: 'retryQueue',
                replayable: true,
                reason: 'retry-queue-restored',
              }),
              expect.objectContaining({
                source: 'actionQueue',
                replayable: true,
                reason: 'action-queue-restored',
              }),
            ]),
          }),
          lastWriteExplain: expect.objectContaining({
            operationId: 'audit-op-1',
          }),
        }),
      }),
    );
    expect(payload.localState).toBeDefined();
    expect(payload.localState!.offlineSnapshot?.localStorage).not.toContain('foreign-legacy-offline-project');
    expect(payload.localState!.offlineSnapshot?.indexedDb).not.toContain('foreign-legacy-snapshot-project');
    expect(payload.localState!.dockSnapshot?.localStorage).not.toContain('foreign-task');
    expect(payload.localState!.retryQueue).toEqual([
      expect.objectContaining({
        id: 'retry-1',
        type: 'blackbox',
        data: expect.objectContaining({
          id: 'bb-inline-retry',
          content: 'Inline Temp',
          focusMeta: expect.objectContaining({
            source: 'focus-console-inline',
            dockEntryId: 'dock-inline-1',
          }),
        }),
        sourceUserId: 'user-1',
      }),
    ]);
    expect(JSON.stringify(payload.localState!.dockSnapshot?.indexedDb)).not.toContain('foreign-task');
    expect(payload.localState!.retryQueue).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'retry-foreign' })]));
    expect(payload.localState!.actionQueue).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'action-foreign' })]));
    expect(payload.localState!.deadLetters).not.toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'foreign' })]));
    expect(payload.localState!.parkedTaskCache!.entries).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ taskId: 'task-parked-foreign' })]),
    );
    expect(payload.localState!.taskTombstones).toEqual({ 'project-1': { 'task-deleted': 123 } });
    expect(payload.localState!.connectionTombstones).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ connectionId: 'conn-deleted-foreign' })]),
    );
    expect(payload.tableCounts).toEqual(expect.objectContaining({
      projects: 1,
      tasks: 1,
      connections: 1,
      userPreferences: 1,
      blackBoxEntries: 1,
      focusSessions: 1,
      transcriptionUsage: 1,
      routineTasks: 1,
      routineCompletions: 1,
    }));
    expect(payload.coverage).toEqual(expect.objectContaining({
      includesLocalState: true,
      includesCloudUserState: true,
    }));
  });
}
