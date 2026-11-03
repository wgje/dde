import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deleteDataSafetyRestoreMarkerJournalDatabaseForTests } from './data-safety-restore-marker-journal';
import {
  createLocalBackupUiRestoreJournal,
} from './local-backup-ui-restore-journal';
import {
  LocalBackupUiRestoreWriterPausedError,
  LocalBackupUiRestoreWriterQuiescenceService,
  getLocalBackupUiRestoreQuiescenceSentinelStorageKey,
} from './local-backup-ui-restore-writer-quiescence.service';
import {
  beginLocalBackupUiRestoreWriter,
  runLocalBackupUiRestoreWriterGuardedSync,
  runWithLocalBackupUiRestoreFinalizationWriterAuthorizationAsync,
} from './local-backup-ui-restore-writer-quiescence-tracker';
import {
  LOCAL_BACKUP_UI_RESTORE_MARKER_SCHEMA_VERSION,
  type LocalBackupUiRestoreMarker,
} from './local-backup-ui-restore-types';
import { createQueueBackupPersonalRestoreIdentity } from './queue-backup-personal-restore-transition.helpers';

const OWNER_USER_ID = 'restore-owner';

describe('LocalBackupUiRestoreWriterQuiescenceService', () => {
  beforeEach(async () => {
    localStorage.clear();
    await deleteDataSafetyRestoreMarkerJournalDatabaseForTests();
  });

  afterEach(async () => {
    vi.clearAllTimers();
    vi.useRealTimers();
    localStorage.clear();
    await deleteDataSafetyRestoreMarkerJournalDatabaseForTests();
  });

  it('registers before recheck and waits for an in-flight writer before becoming quiesced', async () => {
    const writerTab = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });
    const restoreTab = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });
    let releaseWriter!: () => void;
    const writer = writerTab.runAsync(OWNER_USER_ID, 'action-queue', async () => {
      await new Promise<void>(resolve => {
        releaseWriter = resolve;
      });
      return 'written';
    });
    await vi.waitFor(() => expect(releaseWriter).toBeTypeOf('function'));

    let prepared = false;
    const preparing = restoreTab.prepare(OWNER_USER_ID).then(handle => {
      prepared = true;
      return handle;
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(prepared).toBe(false);

    releaseWriter();
    await expect(writer).resolves.toBe('written');
    const handle = await preparing;
    expect(handle.marker().state).toBe('quiesced');
    await expect(handle.verifyOwnership()).resolves.toBe(true);
    await handle.abortBeforeMutation();
  });

  it('blocks new sync and async writers without running their callbacks', async () => {
    const service = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });
    const handle = await service.prepare(OWNER_USER_ID);
    const syncWrite = vi.fn(() => 'written');
    const asyncWrite = vi.fn(async () => 'written');

    expect(() => service.runSync(OWNER_USER_ID, 'retry-queue', syncWrite))
      .toThrow(LocalBackupUiRestoreWriterPausedError);
    await expect(service.runAsync(OWNER_USER_ID, 'external-source', asyncWrite))
      .rejects.toBeInstanceOf(LocalBackupUiRestoreWriterPausedError);
    expect(syncWrite).not.toHaveBeenCalled();
    expect(asyncWrite).not.toHaveBeenCalled();
    await handle.abortBeforeMutation();
  });

  it('allows only the owned prepared handle to run and drain a stage writer', async () => {
    const service = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });
    const handle = await service.prepare(OWNER_USER_ID);
    const write = vi.fn(async () => 'restored');

    await expect(handle.runMutationAsync('retry-queue', write)).resolves.toBe('restored');
    await expect(handle.drainWriters()).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledOnce();
    await expect(service.runAsync(OWNER_USER_ID, 'retry-queue', async () => 'foreign'))
      .rejects.toBeInstanceOf(LocalBackupUiRestoreWriterPausedError);
    await handle.abortBeforeMutation();
  });

  it('keeps async stage authorization active across await and removes it after settlement', async () => {
    const service = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });
    const handle = await service.prepare(OWNER_USER_ID);
    let markStarted!: () => void;
    let releaseWrite!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const held = new Promise<void>(resolve => { releaseWrite = resolve; });
    let writes = 0;

    const mutation = handle.runMutationAsync('project-state', async () => {
      markStarted();
      await held;
      runLocalBackupUiRestoreWriterGuardedSync(OWNER_USER_ID, 'project-state', () => {
        writes += 1;
      });
    });

    try {
      await started;
      releaseWrite();
      await expect(mutation).resolves.toBeUndefined();
      expect(writes).toBe(1);
      expect(() => runLocalBackupUiRestoreWriterGuardedSync(
        OWNER_USER_ID,
        'project-state',
        () => { writes += 1; },
      )).toThrow(LocalBackupUiRestoreWriterPausedError);
      expect(writes).toBe(1);
    } finally {
      releaseWrite();
      await mutation.catch(() => undefined);
      await handle.abortBeforeMutation();
    }
  });

  it('keeps writers frozen until finalization evidence and journal cleanup are complete', async () => {
    const service = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });
    const handle = await service.prepare(OWNER_USER_ID);

    await handle.prepareFinalization('completed');

    expect(handle.marker().state).toBe('finalizing-completed');
    expect(() => service.runSync(OWNER_USER_ID, 'action-queue', () => undefined))
      .toThrow(LocalBackupUiRestoreWriterPausedError);
    await handle.releaseFinalized();
    expect(() => service.runSync(OWNER_USER_ID, 'action-queue', () => undefined)).not.toThrow();
  });

  it('freezes new stage writers and drains an active writer before terminal work proceeds', async () => {
    const service = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });
    const handle = await service.prepare(OWNER_USER_ID);
    let markStarted!: () => void;
    let releaseWrite!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const held = new Promise<void>(resolve => { releaseWrite = resolve; });
    let writes = 0;

    const writer = handle.runMutationAsync('project-state', async () => {
      markStarted();
      await held;
      service.guardSync(OWNER_USER_ID, 'project-state', () => { writes += 1; });
    });
    try {
      await started;
      await handle.prepareFinalization('completed');
      await expect(service.runAsync(OWNER_USER_ID, 'retry-queue', async () => undefined))
        .rejects.toBeInstanceOf(LocalBackupUiRestoreWriterPausedError);

      let drained = false;
      const draining = handle.drainWriters().then(() => { drained = true; });
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(drained).toBe(false);

      releaseWrite();
      await expect(writer).resolves.toBeUndefined();
      await expect(draining).resolves.toBeUndefined();
      expect(writes).toBe(1);
      await handle.releaseFinalized();
    } finally {
      releaseWrite();
      await writer.catch(() => undefined);
    }
  });

  it('allows finalization writes only for ActionQueue in finalizing-completed state', async () => {
    const service = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });
    const handle = await service.prepare(OWNER_USER_ID);
    const write = vi.fn(async () => undefined);

    expect(() => handle.runFinalizationMutation('action-queue', write)).toThrow();
    await handle.prepareFinalization('rolled-back');
    expect(() => handle.runFinalizationMutation('action-queue', write)).toThrow();
    await handle.releaseFinalized();

    const completed = await service.prepare(OWNER_USER_ID);
    try {
      await completed.prepareFinalization('completed');
      expect(() => completed.runFinalizationMutation('retry-queue', write)).toThrow();
      await expect(runWithLocalBackupUiRestoreFinalizationWriterAuthorizationAsync(
        OWNER_USER_ID,
        completed.marker().runId,
        'retry-queue',
        write,
      )).rejects.toBeInstanceOf(LocalBackupUiRestoreWriterPausedError);
      await expect(completed.runFinalizationMutation('action-queue', write)).resolves.toBeUndefined();
      expect(write).toHaveBeenCalledOnce();
    } finally {
      await completed.releaseFinalized();
    }
  });

  it.each(['abortBeforeMutation', 'releaseFinalized'] as const)(
    'fails closed when %s loses the exact sentinel after durable marker deletion',
    async method => {
      const service = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });
      const handle = await service.prepare(OWNER_USER_ID);
      if (method === 'releaseFinalized') await handle.prepareFinalization('completed');
      const sentinelKey = getLocalBackupUiRestoreQuiescenceSentinelStorageKey(OWNER_USER_ID);
      const replacement = JSON.stringify({
        ...JSON.parse(localStorage.getItem(sentinelKey)!),
        createdAt: '2025-12-31T23:59:59.000Z',
      });
      const originalDelete = IDBObjectStore.prototype.delete;
      const deleteSpy = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (
        this: IDBObjectStore, key: IDBValidKey | IDBKeyRange,
      ) {
        if (key === `local-backup-ui-restore-quiescence:${OWNER_USER_ID}`) {
          localStorage.setItem(sentinelKey, replacement);
        }
        return originalDelete.call(this, key);
      });

      await expect(handle[method]()).rejects.toThrow(/clear failed/);
      expect(localStorage.getItem(sentinelKey)).toBe(replacement);
      expect(() => service.runSync(OWNER_USER_ID, 'action-queue', () => undefined))
        .toThrow(LocalBackupUiRestoreWriterPausedError);
      deleteSpy.mockRestore();
    },
  );

  it('waits for a detached durable writer and rejects new detached writers after freeze', async () => {
    const service = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });
    const writer = beginLocalBackupUiRestoreWriter(OWNER_USER_ID, 'retry-queue', { leaseMs: 100 });
    let prepared = false;
    const preparing = service.prepare(OWNER_USER_ID).then(handle => {
      prepared = true;
      return handle;
    });

    await new Promise(resolve => setTimeout(resolve, 5));
    expect(prepared).toBe(false);
    writer.release();

    const handle = await preparing;
    expect(() => beginLocalBackupUiRestoreWriter(OWNER_USER_ID, 'action-queue'))
      .toThrow(LocalBackupUiRestoreWriterPausedError);
    await handle.abortBeforeMutation();
  });

  it.each([
    'dock-snapshot',
    'launch-snapshot',
    'parked-task-cache',
    'black-box',
  ])('waits for a detached %s writer and rejects new writes for that source after freeze', async (
    source,
  ) => {
    const service = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });
    const writer = beginLocalBackupUiRestoreWriter(
      OWNER_USER_ID,
      source as Parameters<typeof beginLocalBackupUiRestoreWriter>[1],
      { leaseMs: 100 },
    );
    let prepared = false;
    const preparing = service.prepare(OWNER_USER_ID).then(handle => {
      prepared = true;
      return handle;
    });

    await new Promise(resolve => setTimeout(resolve, 5));
    expect(prepared).toBe(false);
    writer.release();

    const handle = await preparing;
    expect(() => beginLocalBackupUiRestoreWriter(
      OWNER_USER_ID,
      source as Parameters<typeof beginLocalBackupUiRestoreWriter>[1],
    )).toThrow(LocalBackupUiRestoreWriterPausedError);
    await handle.abortBeforeMutation();
  });

  it('writes only owner/run/lease metadata to the localStorage sentinel', async () => {
    const service = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });
    const handle = await service.prepare(OWNER_USER_ID);
    const raw = localStorage.getItem(
      getLocalBackupUiRestoreQuiescenceSentinelStorageKey(OWNER_USER_ID),
    );
    const sentinel = JSON.parse(raw ?? 'null') as Record<string, unknown>;

    expect(Object.keys(sentinel).sort()).toEqual([
      'createdAt',
      'leaseExpiresAt',
      'markerKind',
      'ownerUserId',
      'runId',
      'schemaVersion',
      'state',
      'storage',
    ]);
    expect(JSON.stringify(sentinel)).not.toContain('preImage');
    expect(JSON.stringify(sentinel)).not.toContain('project');
    await handle.abortBeforeMutation();
  });

  it('fails closed on malformed pause state and clears only the owned identity', async () => {
    localStorage.setItem(
      getLocalBackupUiRestoreQuiescenceSentinelStorageKey(OWNER_USER_ID),
      '{malformed',
    );
    const service = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });
    const write = vi.fn();

    expect(() => service.runSync(OWNER_USER_ID, 'action-queue', write))
      .toThrow(LocalBackupUiRestoreWriterPausedError);
    expect(write).not.toHaveBeenCalled();
    await expect(service.prepare(OWNER_USER_ID)).rejects.toThrow(/sentinel/i);
  });

  it('clears matching expired quiesced evidence during pre-marker startup recovery', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const service = new LocalBackupUiRestoreWriterQuiescenceService({
        leaseMs: 1_000,
        pollIntervalMs: 1,
      });
      const handle = await service.prepare(OWNER_USER_ID);
      const marker = handle.marker();
      vi.clearAllTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'));

      await expect(service.readStartupRecoveryEvidence(OWNER_USER_ID)).resolves.toEqual(marker);
      await expect(service.recoverExpiredPreMarkerQuiescence(OWNER_USER_ID)).resolves.toEqual({ status: 'recovered' });

      expect(localStorage.getItem(
        getLocalBackupUiRestoreQuiescenceSentinelStorageKey(OWNER_USER_ID),
      )).toBeNull();
      expect(() => service.runSync(OWNER_USER_ID, 'action-queue', () => undefined)).not.toThrow();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('stops heartbeat but retains quiescence evidence until startup recovery takes over', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const service = new LocalBackupUiRestoreWriterQuiescenceService({ leaseMs: 1_000 });
      const handle = await service.prepare(OWNER_USER_ID);
      const marker = handle.marker();

      await handle.deferForStartupRecovery();
      expect(() => handle.runMutationAsync('project-state', async () => undefined))
        .toThrow(/not accepting stage mutations/);
      expect(() => service.runSync(OWNER_USER_ID, 'action-queue', () => undefined))
        .toThrow(LocalBackupUiRestoreWriterPausedError);
      vi.setSystemTime(new Date(Date.parse(marker.leaseExpiresAt) + 1));

      await expect(service.readStartupRecoveryEvidence(OWNER_USER_ID)).resolves.toEqual(marker);
      await expect(service.recoverExpiredPreMarkerQuiescence(OWNER_USER_ID))
        .resolves.toEqual({ status: 'recovered' });
      expect(localStorage.getItem(
        getLocalBackupUiRestoreQuiescenceSentinelStorageKey(OWNER_USER_ID),
      )).toBeNull();
      expect(() => service.runSync(OWNER_USER_ID, 'action-queue', () => undefined)).not.toThrow();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('stops heartbeat and retains finalizing evidence until startup recovery takes over', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const service = new LocalBackupUiRestoreWriterQuiescenceService({ leaseMs: 1_000 });
      const handle = await service.prepare(OWNER_USER_ID);
      await handle.prepareFinalization('rolled-back');
      const marker = handle.marker();

      await handle.deferForStartupRecovery();
      expect(() => service.runSync(OWNER_USER_ID, 'action-queue', () => undefined))
        .toThrow(LocalBackupUiRestoreWriterPausedError);
      vi.setSystemTime(new Date(Date.parse(marker.leaseExpiresAt) + 1));

      await expect(service.readStartupRecoveryEvidence(OWNER_USER_ID)).resolves.toEqual(marker);
      expect(localStorage.getItem(
        getLocalBackupUiRestoreQuiescenceSentinelStorageKey(OWNER_USER_ID),
      )).not.toBeNull();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('retains expired quiescence while an exact owner writer is active', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const service = new LocalBackupUiRestoreWriterQuiescenceService({ leaseMs: 1_000 });
    const prepared = await service.prepare(OWNER_USER_ID);
    const marker = prepared.marker();
    const sentinelKey = getLocalBackupUiRestoreQuiescenceSentinelStorageKey(OWNER_USER_ID);
    const sentinel = localStorage.getItem(sentinelKey);
    localStorage.removeItem(sentinelKey);
    const writer = beginLocalBackupUiRestoreWriter(
      OWNER_USER_ID, 'retry-queue', { leaseMs: 10_000, heartbeat: false },
    );
    localStorage.setItem(sentinelKey, sentinel!);
    vi.clearAllTimers();
    vi.setSystemTime(new Date(Date.parse(marker.leaseExpiresAt) + 1));

    await expect(service.recoverExpiredPreMarkerQuiescence(OWNER_USER_ID)).resolves.toEqual({ status: 'blocked', reason: 'active-or-mutated' });
    await expect(service.readStartupRecoveryEvidence(OWNER_USER_ID)).resolves.toEqual(marker);
    expect(localStorage.getItem(sentinelKey)).toBe(sentinel);
    writer.release();
  });

  it('retains a same-run sentinel replacement instead of clearing by run identity', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const service = new LocalBackupUiRestoreWriterQuiescenceService({ leaseMs: 1_000 });
    const prepared = await service.prepare(OWNER_USER_ID);
    const marker = prepared.marker();
    const sentinelKey = getLocalBackupUiRestoreQuiescenceSentinelStorageKey(OWNER_USER_ID);
    const replacement = JSON.stringify({
      ...JSON.parse(localStorage.getItem(sentinelKey)!),
      createdAt: '2025-12-31T23:59:59.000Z',
    });
    localStorage.setItem(sentinelKey, replacement);
    vi.clearAllTimers();
    vi.setSystemTime(new Date(Date.parse(marker.leaseExpiresAt) + 1));

    await expect(service.recoverExpiredPreMarkerQuiescence(OWNER_USER_ID)).resolves.toEqual({ status: 'blocked', reason: 'invalid-evidence' });
    expect(localStorage.getItem(sentinelKey)).toBe(replacement);
  });

  it('closes stage writes when the owned quiescence marker is replaced during finalization', async () => {
    const service = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });
    const handle = await service.prepare(OWNER_USER_ID);
    const marker = handle.marker();
    const quiescenceKey = `local-backup-ui-restore-quiescence:${OWNER_USER_ID}`;
    const originalGet = IDBObjectStore.prototype.get;
    let replaced = false;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (
      this: IDBObjectStore,
      key: IDBValidKey | IDBKeyRange,
    ) {
      if (key === quiescenceKey && !replaced) {
        replaced = true;
        this.put({
          key: quiescenceKey,
          markerKind: 'local-backup-ui-restore-quiescence',
          ownerUserId: OWNER_USER_ID,
          marker: { ...marker, runId: `${marker.runId}-replacement` },
        });
      }
      return originalGet.call(this, key);
    });

    try {
      await expect(handle.prepareFinalization('completed')).rejects.toThrow(/ownership lost/);
      expect(replaced).toBe(true);
      expect(() => handle.runMutationAsync('project-state', async () => undefined))
        .toThrow(/not accepting stage mutations/);
      expect(localStorage.getItem(
        getLocalBackupUiRestoreQuiescenceSentinelStorageKey(OWNER_USER_ID),
      )).toContain(marker.runId);
    } finally {
      spy.mockRestore();
      await handle.deferForStartupRecovery();
    }
  });

  it('retains quiescence when a main marker appears at the transactional recheck', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const service = new LocalBackupUiRestoreWriterQuiescenceService({ leaseMs: 1_000 });
    const prepared = await service.prepare(OWNER_USER_ID);
    const marker = prepared.marker();
    const sentinelKey = getLocalBackupUiRestoreQuiescenceSentinelStorageKey(OWNER_USER_ID);
    const sentinel = localStorage.getItem(sentinelKey);
    vi.clearAllTimers();
    vi.setSystemTime(new Date(Date.parse(marker.leaseExpiresAt) + 1));
    const originalGet = IDBObjectStore.prototype.get;
    let mainReads = 0;
    const deleteSpy = vi.spyOn(IDBObjectStore.prototype, 'delete');
    const spy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (
      this: IDBObjectStore, key: IDBValidKey | IDBKeyRange,
    ) {
      if (key === `local-backup-ui-restore:${OWNER_USER_ID}` && ++mainReads === 2) {
        this.put({ key, markerKind: 'local-backup-ui-restore', ownerUserId: OWNER_USER_ID });
      }
      return originalGet.call(this, key);
    });

    await expect(service.recoverExpiredPreMarkerQuiescence(OWNER_USER_ID)).resolves.toEqual({ status: 'blocked', reason: 'active-or-mutated' });
    expect(deleteSpy).not.toHaveBeenCalled();
    deleteSpy.mockRestore();
    spy.mockRestore();
    await expect(service.readStartupRecoveryEvidence(OWNER_USER_ID)).resolves.toEqual(marker);
    expect(localStorage.getItem(sentinelKey)).toBe(sentinel);
  });

  it.each([
    { ownerUserId: 'foreign-owner' },
    { markerKind: 'foreign-kind' },
  ])('retains a replaced full IDB envelope: $ownerUserId$markerKind', async patch => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const service = new LocalBackupUiRestoreWriterQuiescenceService({ leaseMs: 1_000 });
    const prepared = await service.prepare(OWNER_USER_ID);
    const marker = prepared.marker();
    const sentinelKey = getLocalBackupUiRestoreQuiescenceSentinelStorageKey(OWNER_USER_ID);
    const sentinel = localStorage.getItem(sentinelKey);
    vi.clearAllTimers();
    vi.setSystemTime(new Date(Date.parse(marker.leaseExpiresAt) + 1));
    const originalGet = IDBObjectStore.prototype.get;
    const quiescenceKey = `local-backup-ui-restore-quiescence:${OWNER_USER_ID}`;
    let quiescenceReads = 0;
    const deleteSpy = vi.spyOn(IDBObjectStore.prototype, 'delete');
    const spy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (
      this: IDBObjectStore, key: IDBValidKey | IDBKeyRange,
    ) {
      if (key === quiescenceKey && ++quiescenceReads === 2) this.put({
        key, markerKind: 'local-backup-ui-restore-quiescence', ownerUserId: OWNER_USER_ID,
        marker, ...patch,
      });
      return originalGet.call(this, key);
    });

    await expect(service.recoverExpiredPreMarkerQuiescence(OWNER_USER_ID)).resolves.toEqual({ status: 'blocked', reason: 'active-or-mutated' });
    expect(deleteSpy).not.toHaveBeenCalled();
    deleteSpy.mockRestore();
    spy.mockRestore();
    await expect(service.readStartupRecoveryEvidence(OWNER_USER_ID)).rejects.toThrow();
    expect(localStorage.getItem(sentinelKey)).toBe(sentinel);
  });

  it('adopts expired quiesced evidence to the claimed restore identity for startup takeover', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const service = new LocalBackupUiRestoreWriterQuiescenceService({
        leaseMs: 1_000,
        pollIntervalMs: 1,
      });
      const prepared = await service.prepare(OWNER_USER_ID);
      const original = prepared.marker();
      vi.clearAllTimers();
      const journal = createLocalBackupUiRestoreJournal(OWNER_USER_ID);
      const sourceDigest = `sha256:${'a'.repeat(64)}`;
      const restoreRunId = `${original.runId}:restore`;
      const marker: LocalBackupUiRestoreMarker = {
        schemaVersion: LOCAL_BACKUP_UI_RESTORE_MARKER_SCHEMA_VERSION,
        ownerUserId: OWNER_USER_ID,
        runId: original.runId,
        restoreRunId,
        actionQueueRestoreIdentity: await createQueueBackupPersonalRestoreIdentity({
          ownerUserId: OWNER_USER_ID,
          restoreRunId,
          participant: 'action-queue',
          sourceDigest,
          token: `${original.runId}:action-queue`,
        }),
        createdAt: original.createdAt,
        leaseExpiresAt: original.leaseExpiresAt,
        state: 'restoring',
        phase: 'projects',
        completedStages: [],
        rollbackCompletedStages: [],
        source: { kind: 'local-file', reference: 'backup.json', checksum: sourceDigest },
        touchedProjectIds: ['project-1'],
        preImage: {
          projectState: [],
          blackBox: [],
          attachmentOutbox: [],
          actionQueue: [],
          retryQueue: [],
          deadLetters: [],
          conflicts: [],
          metadata: null,
        },
        rollbackErrors: [],
      };
      await journal.create(marker);
      vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'));
      const claimed = await journal.claimExpired(marker);

      const adopted = await service.takeoverExpired(original, claimed!);

      expect(adopted.marker()).toEqual(expect.objectContaining({
        ownerUserId: OWNER_USER_ID,
        runId: claimed?.runId,
        createdAt: claimed?.createdAt,
        leaseExpiresAt: claimed?.leaseExpiresAt,
        state: 'quiesced',
      }));
      await expect(adopted.verifyOwnership()).resolves.toBe(true);
      await adopted.abortBeforeMutation();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('reclaims expired finalizing evidence so startup cleanup can release it', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const service = new LocalBackupUiRestoreWriterQuiescenceService({
        leaseMs: 1_000,
        pollIntervalMs: 1,
      });
      const prepared = await service.prepare(OWNER_USER_ID);
      await prepared.prepareFinalization('completed');
      const original = prepared.marker();
      vi.clearAllTimers();
      vi.setSystemTime(new Date(Date.parse(original.leaseExpiresAt) + 1));

      const reclaimed = await service.takeoverExpiredFinalization(original);

      expect(reclaimed.marker()).toEqual(expect.objectContaining({
        ownerUserId: OWNER_USER_ID,
        runId: original.runId,
        createdAt: original.createdAt,
        state: 'finalizing-completed',
      }));
      expect(Date.parse(reclaimed.marker().leaseExpiresAt))
        .toBeGreaterThan(Date.parse(original.leaseExpiresAt));
      await expect(reclaimed.verifyOwnership()).resolves.toBe(true);
      await reclaimed.releaseFinalized();
      expect(localStorage.getItem(
        getLocalBackupUiRestoreQuiescenceSentinelStorageKey(OWNER_USER_ID),
      )).toBeNull();
      expect(() => service.runSync(OWNER_USER_ID, 'action-queue', () => undefined)).not.toThrow();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
