import 'fake-indexeddb/auto';

import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackupData } from '../../supabase/functions/_shared/backup-utils';
import { IndexedDBService } from '../app/core/state/persistence';
import { SyncStateService } from '../app/core/services/sync/sync-state.service';
import { TombstoneService } from '../app/core/services/sync/tombstone.service';
import { BackupDataSafetyMetadataRestoreService } from './backup-data-safety-metadata-restore.service';

const DB_NAME = 'nanoflow-store-cache';

describe('BackupDataSafetyMetadataRestoreService', () => {
  let db: IDBDatabase;
  let lastSyncTime: string | null;
  const setLastSyncTime = vi.fn((value: string | null) => {
    lastSyncTime = value;
  });
  const reloadLocalTombstonesFromStorage = vi.fn();

  beforeEach(async () => {
    localStorage.clear();
    vi.clearAllMocks();
    lastSyncTime = '2026-06-18T00:00:10.000Z';
    await deleteDatabase(DB_NAME);
    db = await openDatabase();
    await replaceCursorRows(db, [{
      key: 'project:user-1:project-1',
      scope: 'project',
      userId: 'user-1',
      projectId: 'project-1',
      cursor: {
        updatedAt: '2026-06-18T00:00:10.000Z',
        entityType: 'project',
        id: 'project-1',
      },
      committedAt: '2026-06-18T00:00:10.000Z',
    }]);

    localStorage.setItem('nanoflow.local-tombstones', JSON.stringify({
      'project-1': {
        'task-current': 10,
        'task-deleted': 10,
      },
    }));
    localStorage.setItem('nanoflow.local-connection-tombstones', JSON.stringify([{
      projectId: 'project-1',
      id: 'connection-deleted',
      timestamp: 10,
    }]));
    localStorage.setItem('nanoflow.data-safety-audit.user-1', JSON.stringify({
      replayLog: [createReplayEntry('op-current', 10)],
      lastWriteExplain: null,
    }));

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        BackupDataSafetyMetadataRestoreService,
        {
          provide: IndexedDBService,
          useValue: { initDatabase: vi.fn().mockResolvedValue(db) },
        },
        {
          provide: SyncStateService,
          useValue: {
            syncState: () => ({ lastSyncTime }),
            setLastSyncTime,
          },
        },
        {
          provide: TombstoneService,
          useValue: { reloadLocalTombstonesFromStorage },
        },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it('does not recover an unexpired metadata restore marker from another run', async () => {
    const service = TestBed.inject(BackupDataSafetyMetadataRestoreService);
    const markerKey = 'nanoflow.backup-metadata-restore-marker.user-1';
    const marker = {
      schemaVersion: 1,
      ownerUserId: 'user-1',
      runId: 'metadata-restore-run-a',
      createdAt: new Date(Date.now() - 1_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      touchedProjectIds: ['project-1'],
      cursorRecords: [],
      lastSyncTime: null,
      taskTombstonesRaw: JSON.stringify({ 'project-1': { 'task-rollback': 1 } }),
      connectionTombstonesRaw: JSON.stringify([]),
      auditRaw: JSON.stringify({ replayLog: [], lastWriteExplain: null }),
    };
    const taskTombstonesBefore = localStorage.getItem('nanoflow.local-tombstones');
    const connectionTombstonesBefore = localStorage.getItem('nanoflow.local-connection-tombstones');
    const auditBefore = localStorage.getItem('nanoflow.data-safety-audit.user-1');
    localStorage.setItem(markerKey, JSON.stringify(marker));

    await expect(service.preview(createBackup(), 'user-1')).rejects.toThrow(
      'backup metadata restore already in progress',
    );

    expect(localStorage.getItem('nanoflow.local-tombstones')).toBe(taskTombstonesBefore);
    expect(localStorage.getItem('nanoflow.local-connection-tombstones'))
      .toBe(connectionTombstonesBefore);
    expect(localStorage.getItem('nanoflow.data-safety-audit.user-1')).toBe(auditBefore);
    expect(localStorage.getItem(markerKey)).toBe(JSON.stringify(marker));
  });

  it('fails closed and preserves an empty restore marker before writing metadata', async () => {
    const service = TestBed.inject(BackupDataSafetyMetadataRestoreService);
    const markerKey = 'nanoflow.backup-metadata-restore-marker.user-1';
    const taskTombstonesBefore = localStorage.getItem('nanoflow.local-tombstones');
    const connectionTombstonesBefore = localStorage.getItem('nanoflow.local-connection-tombstones');
    const auditBefore = localStorage.getItem('nanoflow.data-safety-audit.user-1');
    const cursorRowsBefore = await readCursorRows(db);
    localStorage.setItem(markerKey, '');

    await expect(service.restore(createBackup(), 'user-1')).rejects.toThrow(
      'backup metadata restore marker is invalid',
    );

    expect(localStorage.getItem(markerKey)).toBe('');
    expect(localStorage.getItem('nanoflow.local-tombstones')).toBe(taskTombstonesBefore);
    expect(localStorage.getItem('nanoflow.local-connection-tombstones'))
      .toBe(connectionTombstonesBefore);
    expect(localStorage.getItem('nanoflow.data-safety-audit.user-1')).toBe(auditBefore);
    expect(await readCursorRows(db)).toEqual(cursorRowsBefore);
    expect(lastSyncTime).toBe('2026-06-18T00:00:10.000Z');
    expect(setLastSyncTime).not.toHaveBeenCalled();
    expect(reloadLocalTombstonesFromStorage).not.toHaveBeenCalled();
  });

  it('does not clear a newer marker when an older metadata restore completes late', async () => {
    const service = TestBed.inject(BackupDataSafetyMetadataRestoreService);
    const markerKey = 'nanoflow.backup-metadata-restore-marker.user-1';
    let newerMarkerRaw: string | null = null;
    setLastSyncTime.mockImplementationOnce((value: string | null) => {
      lastSyncTime = value;
      const activeMarker = JSON.parse(localStorage.getItem(markerKey) ?? '{}') as Record<string, unknown>;
      newerMarkerRaw = JSON.stringify({
        ...activeMarker,
        runId: 'metadata-restore-run-b',
        createdAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      localStorage.setItem(markerKey, newerMarkerRaw);
    });

    await expect(service.restore(createBackup(), 'user-1')).rejects.toThrow(
      'backup metadata restore marker ownership lost',
    );

    expect(localStorage.getItem(markerKey)).toBe(newerMarkerRaw);
  });

  it('does not roll back newer shared metadata after an older restore loses ownership', async () => {
    const service = TestBed.inject(BackupDataSafetyMetadataRestoreService);
    const markerKey = 'nanoflow.backup-metadata-restore-marker.user-1';
    const newerTaskTombstonesRaw = JSON.stringify({ 'project-2': { 'task-newer': 30 } });
    const newerConnectionTombstonesRaw = JSON.stringify([{
      projectId: 'project-2', id: 'connection-newer', timestamp: 30,
    }]);
    const newerAuditRaw = JSON.stringify({
      replayLog: [createReplayEntry('op-newer', 30)],
      lastWriteExplain: null,
    });
    let newerMarkerRaw: string | null = null;
    setLastSyncTime.mockImplementationOnce(() => {
      const activeMarker = JSON.parse(localStorage.getItem(markerKey) ?? '{}') as Record<string, unknown>;
      newerMarkerRaw = JSON.stringify({
        ...activeMarker,
        runId: 'metadata-restore-run-b',
        createdAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      localStorage.setItem(markerKey, newerMarkerRaw);
      localStorage.setItem('nanoflow.local-tombstones', newerTaskTombstonesRaw);
      localStorage.setItem('nanoflow.local-connection-tombstones', newerConnectionTombstonesRaw);
      localStorage.setItem('nanoflow.data-safety-audit.user-1', newerAuditRaw);
      lastSyncTime = '2026-06-18T00:00:30.000Z';
      throw new Error('simulated older metadata restore failure');
    });

    await expect(service.restore(createBackup(), 'user-1')).rejects.toThrow(
      'backup metadata restore marker ownership lost',
    );

    expect(localStorage.getItem('nanoflow.local-tombstones')).toBe(newerTaskTombstonesRaw);
    expect(localStorage.getItem('nanoflow.local-connection-tombstones'))
      .toBe(newerConnectionTombstonesRaw);
    expect(localStorage.getItem('nanoflow.data-safety-audit.user-1')).toBe(newerAuditRaw);
    expect(lastSyncTime).toBe('2026-06-18T00:00:30.000Z');
    expect(localStorage.getItem(markerKey)).toBe(newerMarkerRaw);
  });

  it('claims an expired marker and stops recovery after ownership changes', async () => {
    const service = TestBed.inject(BackupDataSafetyMetadataRestoreService);
    const markerKey = 'nanoflow.backup-metadata-restore-marker.user-1';
    const expiredMarker = {
      schemaVersion: 1,
      ownerUserId: 'user-1',
      runId: 'expired-metadata-restore-run-a',
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      touchedProjectIds: ['project-1'],
      cursorRecords: [],
      lastSyncTime: null,
      taskTombstonesRaw: JSON.stringify({ 'project-1': { 'task-expired': 1 } }),
      connectionTombstonesRaw: JSON.stringify([]),
      auditRaw: JSON.stringify({ replayLog: [], lastWriteExplain: null }),
    };
    const newerTaskTombstonesRaw = JSON.stringify({ 'project-2': { 'task-newer': 30 } });
    const newerConnectionTombstonesRaw = JSON.stringify([{
      projectId: 'project-2', id: 'connection-newer', timestamp: 30,
    }]);
    const newerAuditRaw = JSON.stringify({
      replayLog: [createReplayEntry('op-newer', 30)],
      lastWriteExplain: null,
    });
    let claimedRunId: unknown;
    let newerMarkerRaw: string | null = null;
    localStorage.setItem(markerKey, JSON.stringify(expiredMarker));
    const originalTransaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementation(((storeNames, mode, options) => {
      const transaction = originalTransaction(storeNames, mode, options);
      if (mode === 'readwrite') {
        claimedRunId = JSON.parse(localStorage.getItem(markerKey) ?? '{}')['runId'];
        transaction.addEventListener('complete', () => {
          const claimedMarker = JSON.parse(localStorage.getItem(markerKey) ?? '{}') as Record<string, unknown>;
          newerMarkerRaw = JSON.stringify({
            ...claimedMarker,
            runId: 'metadata-restore-run-b',
            createdAt: new Date().toISOString(),
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
          localStorage.setItem(markerKey, newerMarkerRaw);
          localStorage.setItem('nanoflow.local-tombstones', newerTaskTombstonesRaw);
          localStorage.setItem('nanoflow.local-connection-tombstones', newerConnectionTombstonesRaw);
          localStorage.setItem('nanoflow.data-safety-audit.user-1', newerAuditRaw);
        }, { once: true });
      }
      return transaction;
    }) as IDBDatabase['transaction']);

    await expect(service.preview(createBackup(), 'user-1')).rejects.toThrow(
      'backup metadata restore marker ownership lost',
    );

    expect(claimedRunId).not.toBe(expiredMarker.runId);
    expect(localStorage.getItem('nanoflow.local-tombstones')).toBe(newerTaskTombstonesRaw);
    expect(localStorage.getItem('nanoflow.local-connection-tombstones'))
      .toBe(newerConnectionTombstonesRaw);
    expect(localStorage.getItem('nanoflow.data-safety-audit.user-1')).toBe(newerAuditRaw);
    expect(localStorage.getItem(markerKey)).toBe(newerMarkerRaw);
  });

  it('uses one fail-closed metadata restore lock across owners', async () => {
    const service = TestBed.inject(BackupDataSafetyMetadataRestoreService);
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    const request = vi.fn(async (
      _name: string,
      _options: LockOptions,
      callback: (lock: Lock | null) => unknown,
    ) => callback(null));
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request },
    });
    try {
      await expect(service.preview(createBackup(), 'user-1')).rejects.toThrow(
        'backup metadata restore lock unavailable',
      );
      expect(request).toHaveBeenCalledWith(
        'nanoflow:backup-metadata-restore',
        { mode: 'exclusive', ifAvailable: true },
        expect.any(Function),
      );
    } finally {
      if (originalLocks) {
        Object.defineProperty(navigator, 'locks', originalLocks);
      } else {
        Reflect.deleteProperty(navigator, 'locks');
      }
    }
  });

  it('renews the metadata restore marker lease while restore remains active', async () => {
    const service = TestBed.inject(BackupDataSafetyMetadataRestoreService);
    const markerKey = 'nanoflow.backup-metadata-restore-marker.user-1';
    let now = Date.parse('2026-06-18T00:00:00.000Z');
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let heartbeat: (() => void) | null = null;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: TimerHandler) => {
      if (typeof handler === 'function') heartbeat = () => handler();
      return 1;
    }) as typeof setInterval);
    let leaseBeforeHeartbeat: string | null = null;
    let leaseAfterHeartbeat: string | null = null;
    setLastSyncTime.mockImplementationOnce((value: string | null) => {
      leaseBeforeHeartbeat = JSON.parse(localStorage.getItem(markerKey) ?? '{}')['leaseExpiresAt'];
      now += 4 * 60 * 1000;
      heartbeat?.();
      leaseAfterHeartbeat = JSON.parse(localStorage.getItem(markerKey) ?? '{}')['leaseExpiresAt'];
      lastSyncTime = value;
    });

    await service.restore(createBackup(), 'user-1');

    expect(Date.parse(leaseAfterHeartbeat ?? '')).toBeGreaterThan(
      Date.parse(leaseBeforeHeartbeat ?? ''),
    );
  });

  it('rejects and preserves a malformed exact-key cursor before pre-image capture', async () => {
    const service = TestBed.inject(BackupDataSafetyMetadataRestoreService);
    const malformed = {
      key: 'project:user-1:project-1',
      cursor: { updatedAt: '2026-06-18T00:00:10.000Z', entityType: 'project', id: '' },
    };
    await replaceCursorRows(db, [malformed]);
    const rowsBefore = JSON.stringify(await readCursorRows(db));

    await expect(service.readCurrent('user-1', new Set(['project-1']))).rejects.toThrow(
      'sync cursor record project:user-1:project-1 is invalid',
    );

    expect(JSON.stringify(await readCursorRows(db))).toBe(rowsBefore);
    expect(localStorage.getItem('nanoflow.backup-metadata-restore-marker.user-1')).toBeNull();
  });

  it('revalidates a tampered exact-key cursor before creating the restore marker', async () => {
    const service = TestBed.inject(BackupDataSafetyMetadataRestoreService);
    const current = await service.readCurrent('user-1', new Set(['project-1']));
    const tampered = createCursorRow({ userId: 'user-2' });
    let rowsBefore = '';
    let checkpointCount = 0;
    const checkpoint = vi.fn(async () => {
      checkpointCount += 1;
      if (checkpointCount === 4) {
        await replaceCursorRows(db, [tampered]);
        rowsBefore = JSON.stringify(await readCursorRows(db));
      }
    });
    const taskTombstonesBefore = localStorage.getItem('nanoflow.local-tombstones');
    const connectionTombstonesBefore = localStorage.getItem('nanoflow.local-connection-tombstones');
    const auditBefore = localStorage.getItem('nanoflow.data-safety-audit.user-1');

    await expect(service.replaceAtomically('user-1', current, current, checkpoint)).rejects.toThrow(
      'sync cursor record project:user-1:project-1 is invalid',
    );

    expect(checkpoint).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(await readCursorRows(db))).toBe(rowsBefore);
    expect(localStorage.getItem('nanoflow.local-tombstones')).toBe(taskTombstonesBefore);
    expect(localStorage.getItem('nanoflow.local-connection-tombstones'))
      .toBe(connectionTombstonesBefore);
    expect(localStorage.getItem('nanoflow.data-safety-audit.user-1')).toBe(auditBefore);
    expect(localStorage.getItem('nanoflow.backup-metadata-restore-marker.user-1')).toBeNull();
    expect(lastSyncTime).toBe('2026-06-18T00:00:10.000Z');
    expect(reloadLocalTombstonesFromStorage).not.toHaveBeenCalled();
  });

  it('accepts a canonical legacy cursor without scanning unrelated malformed rows', async () => {
    const legacy = createCursorRow({
      cursor: { updatedAt: '2026-06-18T00:00:10.000Z', entityType: 'project', id: '' },
    });
    const unrelated = {
      key: 'project:user-2:project-2',
      cursor: { updatedAt: 'not-a-timestamp' },
    };
    await replaceCursorRows(db, [legacy, unrelated]);
    const rowsBefore = JSON.stringify(await readCursorRows(db));
    const fullScan = vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(() => {
      throw new Error('unexpected full cursor scan');
    });

    const current = await TestBed.inject(BackupDataSafetyMetadataRestoreService)
      .readCurrent('user-1', new Set(['project-1']));

    fullScan.mockRestore();
    expect(current.projectCursors).toEqual([{
      projectId: 'project-1',
      userId: 'user-1',
      cursor: legacy.cursor,
    }]);
    expect(JSON.stringify(await readCursorRows(db))).toBe(rowsBefore);
  });

  it('restores cursors, lastSyncTime, audit history, and tombstones idempotently', async () => {
    const service = TestBed.inject(BackupDataSafetyMetadataRestoreService);
    const backup = createBackup();

    const first = await service.restore(backup, 'user-1');
    const second = await service.restore(
      JSON.parse(JSON.stringify(backup)) as BackupData,
      'user-1',
    );

    expect(first).toEqual({
      projectCursors: 1,
      lastSyncTime: 1,
      replayLog: 1,
      lastWriteExplain: 1,
      taskTombstones: 1,
      connectionTombstones: 1,
    });
    expect(second).toEqual({
      projectCursors: 0,
      lastSyncTime: 0,
      replayLog: 0,
      lastWriteExplain: 0,
      taskTombstones: 0,
      connectionTombstones: 0,
    });
    expect(await readCursorRows(db)).toEqual([
      expect.objectContaining({
        key: 'project:user-1:project-1',
        userId: 'user-1',
        projectId: 'project-1',
        cursor: {
          updatedAt: '2026-06-18T00:00:20.000Z',
          entityType: 'task',
          id: 'task-1',
        },
      }),
    ]);
    expect(lastSyncTime).toBe('2026-06-18T00:00:20.000Z');
    expect(JSON.parse(localStorage.getItem('nanoflow.data-safety-audit.user-1') ?? '{}'))
      .toEqual(expect.objectContaining({
        replayLog: [
          expect.objectContaining({ operationId: 'op-current' }),
          expect.objectContaining({
            operationId: 'op-incoming',
            lww: expect.objectContaining({ decision: 'unknown' }),
          }),
        ],
        lastWriteExplain: expect.objectContaining({
          operationId: 'op-incoming',
          lwwDecision: expect.objectContaining({ decision: 'unknown' }),
        }),
      }));
    expect(JSON.parse(localStorage.getItem('nanoflow.local-tombstones') ?? '{}')).toEqual({
      'project-1': {
        'task-current': 10,
        'task-deleted': 20,
      },
    });
    expect(JSON.parse(localStorage.getItem('nanoflow.local-connection-tombstones') ?? '[]'))
      .toEqual([{
        projectId: 'project-1',
        id: 'connection-deleted',
        connectionId: 'connection-deleted',
        timestamp: 20,
      }]);
    expect(reloadLocalTombstonesFromStorage).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem('nanoflow.backup-metadata-restore-marker.user-1')).toBeNull();
  });

  it('runs ownership checkpoints around metadata mutations that follow awaited writes', async () => {
    const service = TestBed.inject(BackupDataSafetyMetadataRestoreService);
    const current = await service.readCurrent('user-1', new Set(['project-1']));
    const order: string[] = [];
    const checkpoint = vi.fn(async () => {
      order.push('checkpoint');
    });
    setLastSyncTime.mockImplementationOnce(value => {
      order.push('last-sync-write');
      lastSyncTime = value;
    });
    reloadLocalTombstonesFromStorage.mockImplementationOnce(() => {
      order.push('tombstones-reload');
    });

    await service.replaceAtomically('user-1', current, current, checkpoint);

    const lastSyncWrite = order.indexOf('last-sync-write');
    const tombstoneReload = order.indexOf('tombstones-reload');
    expect(order.slice(lastSyncWrite - 1, lastSyncWrite + 2))
      .toEqual(['checkpoint', 'last-sync-write', 'checkpoint']);
    expect(order.slice(tombstoneReload - 1, tombstoneReload + 2))
      .toEqual(['checkpoint', 'tombstones-reload', 'checkpoint']);
  });

  it('continues localStorage rollback and preserves the marker when cursor rollback also fails', async () => {
    const service = TestBed.inject(BackupDataSafetyMetadataRestoreService);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const taskTombstonesBefore = localStorage.getItem('nanoflow.local-tombstones');
    const connectionTombstonesBefore = localStorage.getItem('nanoflow.local-connection-tombstones');
    const auditBefore = localStorage.getItem('nanoflow.data-safety-audit.user-1');
    const originalTransaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementation(((storeNames, mode, options) => {
      if (mode === 'readwrite') {
        throw new Error('forced cursor transaction failure');
      }
      return originalTransaction(storeNames, mode, options);
    }) as IDBDatabase['transaction']);

    await expect(service.restore(createBackup(), 'user-1')).rejects.toThrow(
      'forced cursor transaction failure',
    );

    expect(localStorage.getItem('nanoflow.local-tombstones')).toBe(taskTombstonesBefore);
    expect(localStorage.getItem('nanoflow.local-connection-tombstones'))
      .toBe(connectionTombstonesBefore);
    expect(localStorage.getItem('nanoflow.data-safety-audit.user-1')).toBe(auditBefore);
    expect(lastSyncTime).toBe('2026-06-18T00:00:10.000Z');
    expect(localStorage.getItem('nanoflow.backup-metadata-restore-marker.user-1')).not.toBeNull();
    expect(reloadLocalTombstonesFromStorage).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(2);
    expect(consoleError.mock.calls.every(([error]) => (
      error instanceof Error && error.message === 'forced cursor transaction failure'
    ))).toBe(true);
  });

  it('preserves other project tombstone updates while rolling back the restored project', async () => {
    const service = TestBed.inject(BackupDataSafetyMetadataRestoreService);
    localStorage.setItem('nanoflow.local-tombstones', JSON.stringify({
      'project-1': { 'task-current': 10, 'task-deleted': 10 },
      'project-2': { 'task-before': 12 },
    }));
    localStorage.setItem('nanoflow.local-connection-tombstones', JSON.stringify([
      { projectId: 'project-1', id: 'connection-before', timestamp: 10 },
      { projectId: 'project-2', id: 'connection-before', timestamp: 12 },
    ]));
    setLastSyncTime.mockImplementationOnce(() => {
      localStorage.setItem('nanoflow.local-tombstones', JSON.stringify({
        'project-1': { 'task-during-restore': 20 },
        'project-2': { 'task-concurrent': 30 },
      }));
      localStorage.setItem('nanoflow.local-connection-tombstones', JSON.stringify([
        { projectId: 'project-1', id: 'connection-during-restore', timestamp: 20 },
        { projectId: 'project-2', id: 'connection-concurrent', timestamp: 30 },
      ]));
      throw new Error('simulated metadata restore failure');
    });

    await expect(service.restore(createBackup(), 'user-1')).rejects.toThrow(
      'simulated metadata restore failure',
    );

    expect(JSON.parse(localStorage.getItem('nanoflow.local-tombstones') ?? '{}')).toEqual({
      'project-1': { 'task-current': 10, 'task-deleted': 10 },
      'project-2': { 'task-concurrent': 30 },
    });
    const connectionTombstones = JSON.parse(
      localStorage.getItem('nanoflow.local-connection-tombstones') ?? '[]',
    ) as Array<Record<string, unknown>>;
    expect(connectionTombstones).toHaveLength(2);
    expect(connectionTombstones).toEqual(expect.arrayContaining([
      { projectId: 'project-1', id: 'connection-before', timestamp: 10 },
      { projectId: 'project-2', id: 'connection-concurrent', timestamp: 30 },
    ]));
    expect(lastSyncTime).toBe('2026-06-18T00:00:10.000Z');
    expect(localStorage.getItem('nanoflow.backup-metadata-restore-marker.user-1')).toBeNull();
  });
});

function createBackup(): BackupData {
  return {
    projects: [{ id: 'project-1', userId: 'user-1' }],
    tasks: [],
    connections: [],
    localState: {
      taskTombstones: {
        'project-1': {
          'task-deleted': 20,
        },
      },
      connectionTombstones: [{
        projectId: 'project-1',
        connectionId: 'connection-deleted',
        timestamp: 20,
      }],
      dataSafety: {
        schemaVersion: '1.0.0',
        exportedAt: '2026-06-18T00:00:20.000Z',
        ownerUserId: 'user-1',
        syncSnapshot: {
          syncState: {
            lastSyncTime: '2026-06-18T00:00:20.000Z',
            pendingCount: 0,
          },
          projectCursors: [{
            projectId: 'project-1',
            userId: 'user-1',
            cursor: {
              updatedAt: '2026-06-18T00:00:20.000Z',
              entityType: 'task',
              id: 'task-1',
            },
          }],
          queueCounts: { retryQueue: 0, actionQueue: 0, deadLetters: 0 },
        },
        replayLog: [createReplayEntry('op-incoming', 20)],
        replayPlan: {
          idempotencyKey: 'restore-plan-1',
          ownerUserId: 'user-1',
          exportedAt: '2026-06-18T00:00:20.000Z',
          steps: [],
          summary: {
            replayable: 0,
            inspectOnly: 0,
            retryQueue: 0,
            actionQueue: 0,
            auditLog: 1,
          },
        },
        lastWriteExplain: {
          operationId: 'op-incoming',
          actor: { sourceUserId: 'user-1' },
          entity: { type: 'task', id: 'task-1' },
          operation: 'upsert',
          localTimestamp: 20,
          queueResult: { enteredRetryQueue: false, retryCount: 0 },
          rpcResult: { status: 'success' },
          lwwDecision: { decision: 'local-won', reason: 'newer-local-write' },
          lastSyncTime: {
            before: '2026-06-18T00:00:10.000Z',
            after: '2026-06-18T00:00:20.000Z',
            advanced: true,
          },
        },
      },
    },
  } as unknown as BackupData;
}

function createReplayEntry(operationId: string, localCommittedAt: number) {
  return {
    operationId,
    entityType: 'task',
    entityId: `task-${operationId}`,
    operation: 'upsert',
    sourceUserId: 'user-1',
    localCommittedAt,
    queue: { enteredRetryQueue: false, retryCount: 0 },
    rpc: { status: 'success' },
    lww: { decision: 'local-won', reason: 'newer-local-write' },
    lastSyncTime: {
      before: null,
      after: '2026-06-18T00:00:20.000Z',
      advanced: true,
    },
  };
}

async function deleteDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('sync_cursors')) {
        request.result.createObjectStore('sync_cursors', { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function replaceCursorRows(db: IDBDatabase, rows: unknown[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('sync_cursors', 'readwrite');
    const store = transaction.objectStore('sync_cursors');
    store.clear();
    for (const row of rows) store.put(row);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function readCursorRows(db: IDBDatabase): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('sync_cursors', 'readonly');
    const request = transaction.objectStore('sync_cursors').getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function createCursorRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'project:user-1:project-1',
    scope: 'project',
    userId: 'user-1',
    projectId: 'project-1',
    cursor: {
      updatedAt: '2026-06-18T00:00:10.000Z',
      entityType: 'project',
      id: 'project-1',
    },
    committedAt: '2026-06-18T00:00:10.000Z',
    ...overrides,
  };
}
