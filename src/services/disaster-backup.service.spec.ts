import 'fake-indexeddb/auto';

import { Injector, signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoggerService } from './logger.service';
import { DisasterBackupService } from './disaster-backup.service';
import { AuthService } from './auth.service';
import type { DeadLetterItem, QueuedAction } from './action-queue.types';
import { ActionQueueOwnerStorageService } from './action-queue-owner-storage.service';
import { QueueBackupService } from './queue-backup.service';
import { ToastService } from './toast.service';
import { ThemeService } from './theme.service';
import { UiStateService } from './ui-state.service';
import { PreferenceService } from './preference.service';
import { FocusPreferenceService } from './focus-preference.service';
import { BlackBoxService } from './black-box.service';
import { ConflictStorageService } from './conflict-storage.service';
import { SupabaseClientService } from './supabase-client.service';
import { ExternalSourceLinkService } from '../app/core/external-sources/external-source-link.service';
import { ExternalSourceCacheService } from '../app/core/external-sources/external-source-cache.service';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../utils/browser-network-suspension';
import { AUTH_CONFIG } from '../config/auth.config';
import { FOCUS_CONFIG } from '../config/focus.config';
import { registerDisasterBackupLocalStateSpecs } from './disaster-backup-local-state.spec-helpers';
import { registerDisasterBackupOwnerScopeSpecs } from './disaster-backup-owner-scope.spec-helpers';
import { registerDisasterBackupOwnerRestoreSpecs } from './disaster-backup-owner-restore.spec-helpers';
import {
  createBackupTableClient,
  createPersonalBackupTableFixtures,
  createProject,
  seedStore,
} from './disaster-backup.service.spec-helpers';

const DISASTER_BACKUP_TEST_HOOK_TIMEOUT_MS = 5000;
const BLACK_BOX_ID = '11111111-1111-4111-8111-111111111111';

function createBlackBoxRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: BLACK_BOX_ID, projectId: null, userId: 'user-1', content: 'durable capture', date: '2026-07-31',
    createdAt: '2026-07-31T00:00:00.000Z', updatedAt: '2026-07-31T00:00:01.000Z', completedAt: null,
    isRead: false, isCompleted: false, isArchived: false, snoozeUntil: null, snoozeCount: 0,
    deletedAt: null, focusMeta: null, _localVersion: 1, ...overrides,
  };
}

async function seedBlackBoxRows(rows: Record<string, unknown>[]): Promise<void> {
  await seedStore(FOCUS_CONFIG.SYNC.IDB_NAME, FOCUS_CONFIG.SYNC.IDB_VERSION, db => {
    if (!db.objectStoreNames.contains(FOCUS_CONFIG.IDB_STORES.BLACK_BOX_ENTRIES)) {
      db.createObjectStore(FOCUS_CONFIG.IDB_STORES.BLACK_BOX_ENTRIES, { keyPath: 'id' });
    }
  }, db => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(FOCUS_CONFIG.IDB_STORES.BLACK_BOX_ENTRIES, 'readwrite');
    rows.forEach(row => tx.objectStore(FOCUS_CONFIG.IDB_STORES.BLACK_BOX_ENTRIES).put(row));
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  }));
}

function createLocalBackupService(entries: Record<string, unknown>[] = []): DisasterBackupService {
  return Injector.create({ providers: [
    { provide: DisasterBackupService, useClass: DisasterBackupService },
    { provide: LoggerService, useValue: { category: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } },
    { provide: AuthService, useValue: { currentUserId: vi.fn(() => 'user-1') } },
    { provide: ThemeService, useValue: { theme: signal('forest'), colorMode: signal('dark') } },
    { provide: UiStateService, useValue: { layoutDirection: signal('ltr'), floatingWindowPref: signal('auto') } },
    { provide: PreferenceService, useValue: { autoResolveConflicts: signal(false) } },
    { provide: FocusPreferenceService, useValue: { preferences: signal({}), getPreferences: vi.fn(() => ({})) } },
    { provide: BlackBoxService, useValue: { entriesMap: signal(new Map(entries.map(row => [String(row['id']), row]))) } },
    { provide: ConflictStorageService, useValue: { getAllConflicts: vi.fn().mockResolvedValue([]) } },
    { provide: SupabaseClientService, useValue: { isConfigured: false, client: vi.fn(() => null) } },
    { provide: ExternalSourceLinkService, useValue: { ensureLoaded: vi.fn().mockResolvedValue(undefined), activeLinksForTask: vi.fn(() => []) } },
    { provide: ExternalSourceCacheService, useValue: { loadPendingLinks: vi.fn().mockResolvedValue([]) } },
  ] }).get(DisasterBackupService);
}

function createActionQueueOwnerStorageService(): ActionQueueOwnerStorageService {
  return Injector.create({ providers: [
    { provide: ActionQueueOwnerStorageService, useClass: ActionQueueOwnerStorageService },
    { provide: AuthService, useValue: { currentUserId: vi.fn(() => 'user-1') } },
    { provide: QueueBackupService, useValue: { backupQueue: vi.fn() } },
    { provide: LoggerService, useValue: { category: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } },
    { provide: ToastService, useValue: { info: vi.fn(), error: vi.fn(), warning: vi.fn() } },
  ] }).get(ActionQueueOwnerStorageService);
}

describe('DisasterBackupService', () => {
  let trackedConflictStorage: ConflictStorageService | null = null;

  beforeEach(async () => {
    localStorage.clear();
    resetBrowserNetworkSuspensionTrackingForTests();
    trackedConflictStorage = null;

    for (const name of [
      'nanoflow-offline-snapshots',
      'focus_mode',
      'nanoflow-retry-queue',
      'nanoflow-queue-backup',
      'keyval-store',
      'nanoflow-conflicts',
      'nanoflow-store-cache',
    ]) {
      await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        request.onblocked = () => resolve();
      });
    }
  }, DISASTER_BACKUP_TEST_HOOK_TIMEOUT_MS);

  afterEach(async () => {
    if (trackedConflictStorage) {
      await trackedConflictStorage.closeStorageConnections();
      trackedConflictStorage = null;
    }

    resetBrowserNetworkSuspensionTrackingForTests();
  }, DISASTER_BACKUP_TEST_HOOK_TIMEOUT_MS);

  registerDisasterBackupOwnerRestoreSpecs({
    createBackupTableClient,
    createProject,
    seedStore,
  });

  registerDisasterBackupOwnerScopeSpecs({
    createProject,
    seedStore,
  });

  it('buildLocalPayload should read all personal tables through keyset queries without calling the snapshot RPC', async () => {
    const tableData = createPersonalBackupTableFixtures(1);
    const { client, from, keysetCursors, limits, rpc } = createBackupTableClient(tableData, {
      rpcData: tableData,
    });
    const injector = Injector.create({
      providers: [
        { provide: DisasterBackupService, useClass: DisasterBackupService },
        { provide: LoggerService, useValue: { category: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } },
        { provide: AuthService, useValue: { currentUserId: vi.fn(() => 'user-1') } },
        { provide: ThemeService, useValue: { theme: signal('forest'), colorMode: signal('dark') } },
        { provide: UiStateService, useValue: { layoutDirection: signal('rtl'), floatingWindowPref: signal('fixed') } },
        { provide: PreferenceService, useValue: { autoResolveConflicts: signal(false) } },
        { provide: FocusPreferenceService, useValue: { preferences: signal({}), getPreferences: vi.fn(() => ({})) } },
        { provide: BlackBoxService, useValue: { entriesMap: signal(new Map()) } },
        { provide: ConflictStorageService, useValue: { getAllConflicts: vi.fn().mockResolvedValue([]) } },
        { provide: SupabaseClientService, useValue: { isConfigured: true, client: vi.fn(() => client) } },
        { provide: ExternalSourceLinkService, useValue: { ensureLoaded: vi.fn().mockResolvedValue(undefined), activeLinksForTask: vi.fn(() => []) } },
        { provide: ExternalSourceCacheService, useValue: { loadPendingLinks: vi.fn().mockResolvedValue([]) } },
      ],
    });

    const payload = await injector.get(DisasterBackupService).buildLocalPayload([createProject()], {
      autoBackupEnabled: true,
      autoBackupIntervalMs: 900000,
    });

    expect(rpc).not.toHaveBeenCalled();
    for (const table of Object.keys(tableData)) {
      expect(from).toHaveBeenCalledWith(table);
      expect(keysetCursors[table]).toEqual([null]);
      expect(limits[table]).toEqual([1000]);
    }
    expect(payload.userPreferences).toEqual([
      expect.objectContaining({ id: 'pref-0000', userId: 'user-1' }),
    ]);
    expect(payload.focusSessions).toEqual([
      expect.objectContaining({ id: 'focus-0000', userId: 'user-1' }),
    ]);
    expect(payload.transcriptionUsage).toEqual([
      expect.objectContaining({ id: 'usage-0000', audioSeconds: 42 }),
    ]);
    expect(payload.routineTasks).toEqual([
      expect.objectContaining({ id: 'routine-0000', title: 'Routine 0000' }),
    ]);
    expect(payload.routineCompletions).toEqual([
      expect.objectContaining({ id: 'completion-0000', count: 1 }),
    ]);
  });

  it('buildLocalPayload should preserve more than 1000 rows from every personal table across keyset pages', async () => {
    const tableData = createPersonalBackupTableFixtures(1001);
    const truncatedSnapshot = Object.fromEntries(Object.entries(tableData).map(([table, rows]) => [
      table,
      rows.slice(0, 1000),
    ]));
    const { client, keysetCursors, limits, ranges } = createBackupTableClient(tableData, {
      rpcData: truncatedSnapshot,
    });
    const injector = Injector.create({
      providers: [
        { provide: DisasterBackupService, useClass: DisasterBackupService },
        { provide: LoggerService, useValue: { category: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } },
        { provide: AuthService, useValue: { currentUserId: vi.fn(() => 'user-1') } },
        { provide: ThemeService, useValue: { theme: signal('forest'), colorMode: signal('dark') } },
        { provide: UiStateService, useValue: { layoutDirection: signal('rtl'), floatingWindowPref: signal('fixed') } },
        { provide: PreferenceService, useValue: { autoResolveConflicts: signal(false) } },
        { provide: FocusPreferenceService, useValue: { preferences: signal({}), getPreferences: vi.fn(() => ({})) } },
        { provide: BlackBoxService, useValue: { entriesMap: signal(new Map()) } },
        { provide: ConflictStorageService, useValue: { getAllConflicts: vi.fn().mockResolvedValue([]) } },
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

    expect(payload.userPreferences).toHaveLength(1001);
    expect(payload.userPreferences[1000]).toEqual(expect.objectContaining({ id: 'pref-1000' }));
    expect(payload.focusSessions).toHaveLength(1001);
    expect(payload.focusSessions[1000]).toEqual(expect.objectContaining({ id: 'focus-1000' }));
    expect(payload.transcriptionUsage).toHaveLength(1001);
    expect(payload.transcriptionUsage[1000]).toEqual(expect.objectContaining({ id: 'usage-1000' }));
    expect(payload.routineTasks).toHaveLength(1001);
    expect(payload.routineTasks[1000]).toEqual(expect.objectContaining({ id: 'routine-1000' }));
    expect(payload.routineCompletions).toHaveLength(1001);
    expect(payload.routineCompletions[1000]).toEqual(expect.objectContaining({ id: 'completion-1000' }));

    for (const [table, cursor] of [
      ['user_preferences', 'pref-0999'],
      ['focus_sessions', 'focus-0999'],
      ['transcription_usage', 'usage-0999'],
      ['routine_tasks', 'routine-0999'],
      ['routine_completions', 'completion-0999'],
    ] as const) {
      expect(keysetCursors[table]).toEqual([null, cursor]);
      expect(limits[table]).toEqual([1000, 1000]);
      expect(ranges[table]).toBeUndefined();
    }
  });

  it('buildLocalPayload should include data safety before local-mode cache is persisted', async () => {
    const injector = Injector.create({
      providers: [
        { provide: DisasterBackupService, useClass: DisasterBackupService },
        { provide: LoggerService, useValue: { category: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } },
        { provide: AuthService, useValue: { currentUserId: vi.fn(() => null) } },
        { provide: ThemeService, useValue: { theme: signal('forest'), colorMode: signal('dark') } },
        { provide: UiStateService, useValue: { layoutDirection: signal('ltr'), floatingWindowPref: signal('auto') } },
        { provide: PreferenceService, useValue: { autoResolveConflicts: signal(false) } },
        { provide: FocusPreferenceService, useValue: { preferences: signal({}), getPreferences: vi.fn(() => ({})) } },
        { provide: BlackBoxService, useValue: { entriesMap: signal(new Map()) } },
        { provide: ConflictStorageService, useValue: { getAllConflicts: vi.fn().mockResolvedValue([]) } },
        { provide: SupabaseClientService, useValue: { isConfigured: false, client: vi.fn(() => null) } },
        { provide: ExternalSourceLinkService, useValue: { ensureLoaded: vi.fn().mockResolvedValue(undefined), activeLinksForTask: vi.fn(() => []) } },
        { provide: ExternalSourceCacheService, useValue: { loadPendingLinks: vi.fn().mockResolvedValue([]) } },
      ],
    });

    const payload = await injector.get(DisasterBackupService).buildLocalPayload([createProject()], {
      autoBackupEnabled: false,
      autoBackupIntervalMs: 900000,
    });

    expect(localStorage.getItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY)).toBeNull();
    expect(payload.coverage.includesCloudUserState).toBe(false);
    expect(payload.localState?.dataSafety).toEqual(expect.objectContaining({
      schemaVersion: '1.0.0',
      ownerUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
      syncSnapshot: expect.any(Object),
      replayLog: expect.any(Array),
      replayPlan: expect.any(Object),
    }));
  });

  it('buildLocalBlob preserves ActionQueue replay identity and dead letters', async () => {
    const actionQueue: QueuedAction[] = [{
      id: '88888888-8888-4888-8888-888888888888',
      operationId: '99999999-9999-4999-8999-999999999999',
      type: 'update',
      entityType: 'task',
      entityId: '77777777-7777-4777-8777-777777777777',
      payload: {
        task: {
          id: '77777777-7777-4777-8777-777777777777',
          title: 'Restored task',
          content: 'preserve for replay',
          stage: 1,
          parentId: null,
          order: 0,
          rank: 500,
          status: 'active',
          x: 0,
          y: 0,
          createdDate: '2026-06-18T00:00:00.000Z',
          displayId: '1',
        },
        projectId: 'project-1',
      },
      timestamp: 1,
      retryCount: 0,
    }];
    const deadLetters: DeadLetterItem[] = [{
      action: actionQueue[0],
      failedAt: '2026-06-18T00:00:00.000Z',
      reason: 'sync failure',
    }];
    const ownerStorage = createActionQueueOwnerStorageService();
    expect(ownerStorage.refreshQueueMirrorForOwnerAfterRestore('user-1', actionQueue)).toBe(true);
    localStorage.setItem('nanoflow.dead-letter-queue.user-1', JSON.stringify(deadLetters));

    const { payload, blob } = await createLocalBackupService().buildLocalBlob([createProject()], {
      autoBackupEnabled: false,
      autoBackupIntervalMs: 900000,
    });
    const serialized = JSON.parse(await blob.text()) as {
      localState?: { actionQueue?: unknown; deadLetters?: unknown[] };
    };
    const exportedActions = payload.localState?.actionQueue;

    expect(Array.isArray(exportedActions)).toBe(true);
    if (!Array.isArray(exportedActions)) throw new Error('exported ActionQueue was not an array');
    expect(exportedActions).toHaveLength(1);
    expect(exportedActions[0]).toMatchObject({
      id: '88888888-8888-4888-8888-888888888888',
      operationId: '99999999-9999-4999-8999-999999999999',
    });
    expect(payload.localState?.deadLetters).toEqual(deadLetters);
    expect(serialized.localState?.actionQueue).toEqual(payload.localState?.actionQueue);
    expect(serialized.localState?.deadLetters).toEqual(deadLetters);
  });

  it('exports canonical durable Black Box rows without hydration or IndexedDB writes', async () => {
    const current = createBlackBoxRow();
    const foreign = createBlackBoxRow({ id: 'foreign-store-key', userId: 'user-2', content: undefined });
    await seedBlackBoxRows([current, foreign]);
    const open = vi.spyOn(indexedDB, 'open');
    const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction');
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    const remove = vi.spyOn(IDBObjectStore.prototype, 'delete');
    const clear = vi.spyOn(IDBObjectStore.prototype, 'clear');

    const payload = await createLocalBackupService().buildLocalPayload([createProject()], {
      autoBackupEnabled: false, autoBackupIntervalMs: 900000,
    });

    const { _localVersion: _ignored, ...expected } = current;
    expect(payload.blackBoxEntries).toEqual([expected]);
    expect(open).toHaveBeenCalledWith(FOCUS_CONFIG.SYNC.IDB_NAME);
    expect(transaction).toHaveBeenCalledWith(FOCUS_CONFIG.IDB_STORES.BLACK_BOX_ENTRIES, 'readonly');
    expect(put).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled();
  });

  it.each([
    ['memory-only', [], [createBlackBoxRow()]],
    ['canonical divergence', [createBlackBoxRow()], [createBlackBoxRow({ content: 'newer memory' })]],
    ['ownerless durable row', [createBlackBoxRow({ userId: undefined })], []],
    ['malformed current-owner row', [createBlackBoxRow({ content: undefined })], []],
  ])('rejects %s Black Box evidence', async (_caseName, durable, memory) => {
    await seedBlackBoxRows(durable);
    await expect(createLocalBackupService(memory).buildLocalPayload([createProject()], {
      autoBackupEnabled: false, autoBackupIntervalMs: 900000,
    })).rejects.toThrow(/Black Box/i);
  });

  it('rejects a Black Box IndexedDB read failure', async () => {
    await seedBlackBoxRows([createBlackBoxRow()]);
    const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(() => {
      throw new Error('black box read denied');
    });
    try {
      await expect(createLocalBackupService().buildLocalPayload([createProject()], {
        autoBackupEnabled: false, autoBackupIntervalMs: 900000,
      })).rejects.toThrow(/black box read denied/i);
    } finally { getAll.mockRestore(); }
  });

  it('rejects malformed durable Black Box evidence before checksum and Blob creation', async () => {
    await seedBlackBoxRows([createBlackBoxRow({ updatedAt: 'invalid' })]);
    const digest = vi.spyOn(crypto.subtle, 'digest'); const blobConstructor = vi.fn();
    vi.stubGlobal('Blob', blobConstructor);
    try {
      await expect(createLocalBackupService().buildLocalBlob([createProject()], {
        autoBackupEnabled: false, autoBackupIntervalMs: 900000,
      })).rejects.toThrow(/Black Box/i);
      expect(digest).not.toHaveBeenCalled(); expect(blobConstructor).not.toHaveBeenCalled();
    } finally { digest.mockRestore(); vi.unstubAllGlobals(); }
  });

  it('preserves content and boolean fields through Black Box projection', () => {
    const current = createBlackBoxRow();
    expect(current['content']).toBe('durable capture');
    expect(typeof current['isRead']).toBe('boolean');
    expect(typeof current['isCompleted']).toBe('boolean');
    expect(typeof current['isArchived']).toBe('boolean');
  });

  it('rejects malformed current-owner content fail-closed', async () => {
    await seedBlackBoxRows([createBlackBoxRow({ content: undefined })]);
    await expect(createLocalBackupService().buildLocalBlob([createProject()], {
      autoBackupEnabled: false, autoBackupIntervalMs: 900000,
    })).rejects.toThrow(/Black Box/i);
  });

  it('buildLocalBlob rejects a malformed visible cursor before checksum and Blob creation', async () => {
    await seedStore('nanoflow-store-cache', 3, db => {
      db.createObjectStore('sync_cursors', { keyPath: 'key' });
    }, async (db) => {
      const tx = db.transaction('sync_cursors', 'readwrite');
      tx.objectStore('sync_cursors').put({
        key: 'project:user-1:project-1',
        scope: 'task',
        userId: 'user-1',
        projectId: 'project-1',
        cursor: { updatedAt: '2026-03-11T00:00:00.000Z', entityType: 'task', id: 'task-9' },
        committedAt: '2026-03-11T00:00:01.000Z',
      });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    });
    const injector = Injector.create({
      providers: [
        { provide: DisasterBackupService, useClass: DisasterBackupService },
        { provide: LoggerService, useValue: { category: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } },
        { provide: AuthService, useValue: { currentUserId: vi.fn(() => 'user-1') } },
        { provide: ThemeService, useValue: { theme: signal('forest'), colorMode: signal('dark') } },
        { provide: UiStateService, useValue: { layoutDirection: signal('ltr'), floatingWindowPref: signal('auto') } },
        { provide: PreferenceService, useValue: { autoResolveConflicts: signal(false) } },
        { provide: FocusPreferenceService, useValue: { preferences: signal({}), getPreferences: vi.fn(() => ({})) } },
        { provide: BlackBoxService, useValue: { entriesMap: signal(new Map()) } },
        { provide: ConflictStorageService, useValue: { getAllConflicts: vi.fn().mockResolvedValue([]) } },
        { provide: SupabaseClientService, useValue: { isConfigured: false, client: vi.fn(() => null) } },
        { provide: ExternalSourceLinkService, useValue: { ensureLoaded: vi.fn(), activeLinksForTask: vi.fn(() => []) } },
        { provide: ExternalSourceCacheService, useValue: { loadPendingLinks: vi.fn().mockResolvedValue([]) } },
      ],
    });
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest');
    const blobConstructor = vi.fn();
    vi.stubGlobal('Blob', blobConstructor);

    try {
      await expect(injector.get(DisasterBackupService).buildLocalBlob([createProject()], {
        autoBackupEnabled: false,
        autoBackupIntervalMs: 900000,
      })).rejects.toThrow(/sync cursor/i);
      expect(digest).not.toHaveBeenCalled();
      expect(blobConstructor).not.toHaveBeenCalled();
    } finally {
      digest.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('buildLocalPayload should continue with local data when remote user state is deferred by browser suspension', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const queryError = { message: 'BrowserNetworkSuspendedError: Browser network IO suspended' };
    const { client } = createBackupTableClient({}, { error: queryError });

    const injector = Injector.create({
      providers: [
        { provide: DisasterBackupService, useClass: DisasterBackupService },
        { provide: LoggerService, useValue: { category: () => logger } },
        { provide: AuthService, useValue: { currentUserId: vi.fn(() => 'user-1') } },
        { provide: ThemeService, useValue: { theme: signal('forest'), colorMode: signal('dark') } },
        { provide: UiStateService, useValue: { layoutDirection: signal('rtl'), floatingWindowPref: signal('fixed') } },
        { provide: PreferenceService, useValue: { autoResolveConflicts: signal(false) } },
        { provide: FocusPreferenceService, useValue: { preferences: signal({}), getPreferences: vi.fn(() => ({})) } },
        { provide: BlackBoxService, useValue: { entriesMap: signal(new Map()) } },
        { provide: ConflictStorageService, useValue: { getAllConflicts: vi.fn().mockResolvedValue([]) } },
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

    expect(payload.projects).toHaveLength(1);
    expect(payload.userPreferences).toEqual([
      expect.objectContaining({
        id: 'local-pref-user-1',
        userId: 'user-1',
        theme: 'forest',
      }),
    ]);
    expect(payload.focusSessions).toEqual([]);
    expect(payload.transcriptionUsage).toEqual([]);
    expect(payload.routineTasks).toEqual([]);
    expect(payload.routineCompletions).toEqual([]);
    expect(payload.coverage).toEqual(expect.objectContaining({
      includesProjectData: true,
      includesLocalState: true,
      includesCloudUserState: false,
    }));
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      '备份远端用户状态读取已延后，继续生成本地备份',
      expect.objectContaining({ table: 'user_preferences' }),
    );
  });

  it('buildLocalPayload should include only current owner conflict records from real conflict storage', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    let currentUserId = 'user-1';

    const injector = Injector.create({
      providers: [
        { provide: DisasterBackupService, useClass: DisasterBackupService },
        { provide: ConflictStorageService, useClass: ConflictStorageService },
        { provide: LoggerService, useValue: { category: () => logger } },
        { provide: AuthService, useValue: { currentUserId: vi.fn(() => currentUserId) } },
        { provide: ThemeService, useValue: { theme: signal('forest'), colorMode: signal('dark') } },
        { provide: UiStateService, useValue: { layoutDirection: signal('rtl'), floatingWindowPref: signal('fixed') } },
        { provide: PreferenceService, useValue: { autoResolveConflicts: signal(false) } },
        { provide: FocusPreferenceService, useValue: { preferences: signal({}), getPreferences: vi.fn(() => ({})) } },
        { provide: BlackBoxService, useValue: { entriesMap: signal(new Map()) } },
        { provide: SupabaseClientService, useValue: { isConfigured: false, client: vi.fn() } },
        { provide: ExternalSourceLinkService, useValue: { ensureLoaded: vi.fn().mockResolvedValue(undefined), activeLinksForTask: vi.fn(() => []) } },
        { provide: ExternalSourceCacheService, useValue: { loadPendingLinks: vi.fn().mockResolvedValue([]) } },
      ],
    });

    const conflictStorage = injector.get(ConflictStorageService);
  trackedConflictStorage = conflictStorage;
    const service = injector.get(DisasterBackupService);

    currentUserId = 'user-1';
    await conflictStorage.saveConflict({
      projectId: 'project-1',
      localProject: createProject(),
      conflictedAt: '2026-03-12T00:00:00.000Z',
      localVersion: 3,
      reason: 'field_conflict',
      conflictedFields: ['title'],
      acknowledged: false,
    });

    currentUserId = 'user-2';
    await conflictStorage.saveConflict({
      projectId: 'project-1',
      localProject: {
        ...createProject(),
        name: 'Foreign Inbox',
      },
      conflictedAt: '2026-03-12T00:05:00.000Z',
      localVersion: 4,
      reason: 'concurrent_edit',
      acknowledged: false,
    });

    currentUserId = 'user-1';
    const payload = await service.buildLocalPayload([createProject()], {
      autoBackupEnabled: true,
      autoBackupIntervalMs: 900000,
    });

    expect(payload.localState?.conflicts).toEqual([
      expect.objectContaining({
        ownerUserId: 'user-1',
        projectId: 'project-1',
        reason: 'field_conflict',
        localProject: expect.objectContaining({ name: 'Inbox' }),
      }),
    ]);
  });

  registerDisasterBackupLocalStateSpecs({
    createProject,
    createBackupTableClient,
    seedStore,
  });

  it('preserves content and boolean fields through Black Box projection', () => {
    const current = createBlackBoxRow();
    expect(current['content']).toBe('durable capture');
    expect(typeof current['isRead']).toBe('boolean');
    expect(typeof current['isCompleted']).toBe('boolean');
    expect(typeof current['isArchived']).toBe('boolean');
  });

  it('rejects malformed current-owner content fail-closed', async () => {
    await seedBlackBoxRows([createBlackBoxRow({ content: undefined })]);
    await expect(createLocalBackupService().buildLocalBlob([createProject()], {
      autoBackupEnabled: false, autoBackupIntervalMs: 900000,
    })).rejects.toThrow(/Black Box/i);
  });
});
