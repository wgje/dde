import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deleteDataSafetyRestoreMarkerJournalDatabaseForTests } from './data-safety-restore-marker-journal';
import {
  buildLocalBackupUiRestoreMarker,
  LOCAL_BACKUP_UI_RESTORE_STAGES,
  validateLocalBackupUiRestoreMarker,
  type BuildLocalBackupUiRestoreMarkerInput,
  type LocalBackupUiRestoreMarker,
} from './local-backup-ui-restore-types';
import {
  LOCAL_BACKUP_UI_RESTORE_MARKER_KIND,
  createLocalBackupUiRestoreJournal,
  getLocalBackupUiRestoreSentinelStorageKey,
  isLocalBackupUiRestoreMarkerActive,
  startLocalBackupUiRestoreMarkerHeartbeat,
} from './local-backup-ui-restore-journal';

const OWNER_USER_ID = 'user-1';
const RESTORE_RUN_ID = '22222222-2222-4222-8222-222222222222';
const SOURCE_DIGEST = `sha256:${'a'.repeat(64)}`;
const QUEUE_BACKUP_IDENTITY = {
  ownerUserId: OWNER_USER_ID,
  restoreRunId: RESTORE_RUN_ID,
  participant: 'action-queue' as const,
  sourceDigest: SOURCE_DIGEST,
  token: '33333333-3333-4333-8333-333333333333',
  recordId: `queue-backup:${OWNER_USER_ID}`,
  identityDigest: `sha256:${'b'.repeat(64)}`,
  receiptId: `queue-backup-personal-restore-receipt:v2:${'b'.repeat(64)}`,
};
const JOURNAL_DB_NAME = 'nanoflow-data-safety-restore-journal';
const JOURNAL_STORE_NAME = 'restore_markers';

describe('local backup UI restore journal foundation', () => {
  beforeEach(async () => {
    localStorage.clear();
    await deleteDataSafetyRestoreMarkerJournalDatabaseForTests();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    localStorage.clear();
    await deleteDataSafetyRestoreMarkerJournalDatabaseForTests();
  });

  it('durably creates and reads a validated marker with a payload-free sentinel', async () => {
    const marker = makeMarker();
    const journal = createLocalBackupUiRestoreJournal(OWNER_USER_ID);

    await journal.create(marker);

    await expect(journal.read()).resolves.toEqual(marker);
    await expect(readJournalRecord(OWNER_USER_ID)).resolves.toEqual({
      key: `${LOCAL_BACKUP_UI_RESTORE_MARKER_KIND}:${OWNER_USER_ID}`,
      markerKind: LOCAL_BACKUP_UI_RESTORE_MARKER_KIND,
      ownerUserId: OWNER_USER_ID,
      marker,
    });
    const sentinel = readSentinel(OWNER_USER_ID);
    expect(sentinel).toEqual(sentinelFor(marker));
    expect(Object.keys(sentinel).sort()).toEqual([
      'createdAt',
      'leaseExpiresAt',
      'markerKind',
      'ownerUserId',
      'runId',
      'schemaVersion',
      'storage',
    ]);
    expect(JSON.stringify(sentinel)).not.toContain('local project before restore');
    expect(JSON.stringify(sentinel)).not.toContain('preImage');
    expect(JSON.stringify(sentinel)).not.toContain('touchedProjectIds');
  });

  it('rebuilds an absent rich sentinel only from matching durable marker identity', async () => {
    const marker = makeMarker();
    const journal = createLocalBackupUiRestoreJournal(OWNER_USER_ID);
    await journal.create(marker);
    localStorage.removeItem(getLocalBackupUiRestoreSentinelStorageKey(OWNER_USER_ID));

    await expect(journal.read()).resolves.toEqual(marker);
    expect(readSentinel(OWNER_USER_ID)).toEqual(sentinelFor(marker));
  });

  it.each([
    ['createdAt', { createdAt: '2026-10-01T00:00:00.000Z' }],
    ['leaseExpiresAt', { leaseExpiresAt: '2026-10-01T00:00:00.000Z' }],
  ] as const)(
    'preserves a rich sentinel when its %s differs from the durable marker',
    async (_field, drift) => {
      const marker = makeMarker();
      const journal = createLocalBackupUiRestoreJournal(OWNER_USER_ID);
      await journal.create(marker);

      const key = getLocalBackupUiRestoreSentinelStorageKey(OWNER_USER_ID);
      const mismatchedSentinel = { ...sentinelFor(marker), ...drift };
      const rawSentinel = JSON.stringify(mismatchedSentinel);
      localStorage.setItem(key, rawSentinel);
      const setItem = vi.spyOn(localStorage, 'setItem');

      await expect(journal.read()).rejects.toThrow('sentinel identity');
      await expect(journal.verifyOwnership(marker)).resolves.toBe(false);
      expect(localStorage.getItem(key)).toBe(rawSentinel);
      expect(setItem).not.toHaveBeenCalled();
    },
  );

  it('validates the complete marker boundary and rejects owner or payload drift', () => {
    const marker = makeMarker();

    expect(validateLocalBackupUiRestoreMarker(marker, OWNER_USER_ID)).toBe(true);
    expect(validateLocalBackupUiRestoreMarker({
      ...marker,
      ownerUserId: 'other-user',
    }, OWNER_USER_ID)).toBe(false);
    expect(validateLocalBackupUiRestoreMarker({
      ...marker,
      completedStages: ['projects', 'attachments'],
    }, OWNER_USER_ID)).toBe(false);
    expect(validateLocalBackupUiRestoreMarker({
      ...marker,
      preImage: { ...marker.preImage, actionQueue: undefined },
    }, OWNER_USER_ID)).toBe(false);
    expect(validateLocalBackupUiRestoreMarker({
      ...marker,
      rollbackErrors: [{ stage: 'metadata', message: '', recordedAt: 'not-a-date' }],
    }, OWNER_USER_ID)).toBe(false);
  });

  it('rejects phase progress that cannot come from the restore protocol', () => {
    const marker = makeMarker();
    const completedPrefix = [...LOCAL_BACKUP_UI_RESTORE_STAGES].slice(0, 6);

    expect(validateLocalBackupUiRestoreMarker({
      ...marker,
      state: 'restoring',
      phase: 'metadata',
      completedStages: completedPrefix,
    }, OWNER_USER_ID)).toBe(true);
    expect(validateLocalBackupUiRestoreMarker({
      ...marker,
      state: 'restoring',
      phase: 'metadata',
      completedStages: [],
    }, OWNER_USER_ID)).toBe(false);
    expect(validateLocalBackupUiRestoreMarker({
      ...marker,
      state: 'restoring',
      phase: 'retry-queue',
      completedStages: ['projects', 'action-queue'],
    }, OWNER_USER_ID)).toBe(false);
    expect(validateLocalBackupUiRestoreMarker({
      ...marker,
      state: 'rollback-failed',
      phase: 'retry-queue',
      completedStages: ['projects', 'attachment-outbox', 'action-queue'],
      rollbackCompletedStages: ['metadata'],
      rollbackErrors: [{
        stage: 'retry-queue',
        message: 'rollback failed',
        recordedAt: '2026-07-27T00:00:00.000Z',
      }],
    }, OWNER_USER_ID)).toBe(false);
  });

  it('fails closed when the durable marker payload is malformed', async () => {
    const marker = makeMarker();
    await putJournalRecord(OWNER_USER_ID, {
      key: `${LOCAL_BACKUP_UI_RESTORE_MARKER_KIND}:${OWNER_USER_ID}`,
      markerKind: LOCAL_BACKUP_UI_RESTORE_MARKER_KIND,
      ownerUserId: OWNER_USER_ID,
      marker: { ...marker, preImage: null },
    });
    writeSentinel(marker);

    await expect(createLocalBackupUiRestoreJournal(OWNER_USER_ID).read()).rejects.toThrow(
      'schema validation',
    );
  });

  it('fails closed when only a compatibility sentinel survives', async () => {
    const marker = makeMarker();
    writeSentinel(marker);

    await expect(createLocalBackupUiRestoreJournal(OWNER_USER_ID).read()).rejects.toThrow(
      'sentinel exists without a durable marker',
    );
  });

  it('allows only one tab to create the owner-scoped durable marker', async () => {
    const firstMarker = makeMarker();
    const secondMarker = makeMarker();
    const firstJournal = createLocalBackupUiRestoreJournal(OWNER_USER_ID);
    const secondJournal = createLocalBackupUiRestoreJournal(OWNER_USER_ID);

    const results = await Promise.allSettled([
      firstJournal.create(firstMarker),
      secondJournal.create(secondMarker),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const persisted = await firstJournal.read();
    expect([firstMarker.runId, secondMarker.runId]).toContain(persisted?.runId);
  });

  it('does not claim an active lease', async () => {
    const now = Date.now();
    const marker = makeMarker(now);
    const journal = createLocalBackupUiRestoreJournal(OWNER_USER_ID);
    await journal.create(marker);

    expect(isLocalBackupUiRestoreMarkerActive(marker, now)).toBe(true);
    await expect(journal.claimExpired(marker)).resolves.toBeNull();
    await expect(journal.verifyOwnership(marker)).resolves.toBe(true);
  });

  it('CAS-replaces a complete marker and rejects a stale expected stage', async () => {
    const marker = makeMarker();
    const journal = createLocalBackupUiRestoreJournal(OWNER_USER_ID);
    await journal.create(marker);
    const next = {
      ...marker,
      state: 'restoring' as const,
      phase: 'projects' as const,
    };

    await expect(journal.replace(marker, next)).resolves.toEqual(next);
    await expect(journal.replace(marker, { ...next, completedStages: ['projects'] }))
      .resolves.toBeNull();
    await expect(journal.read()).resolves.toEqual(next);
  });

  it('restores the previous durable marker when rich sentinel write fails after replace', async () => {
    const marker = makeMarker();
    const journal = createLocalBackupUiRestoreJournal(OWNER_USER_ID);
    await journal.create(marker);
    const next = {
      ...marker,
      state: 'restoring' as const,
      phase: 'projects' as const,
    };
    const sentinelKey = getLocalBackupUiRestoreSentinelStorageKey(OWNER_USER_ID);
    const originalSetItem = localStorage.setItem.bind(localStorage);
    let failedRichWrite = false;
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (!failedRichWrite && key === sentinelKey && isRichSentinelValue(String(value))) {
        failedRichWrite = true;
        throw new Error('rich sentinel write failed');
      }
      return originalSetItem(key, value);
    });

    await expect(journal.replace(marker, next)).rejects.toThrow('rich sentinel write failed');
    await expect(journal.read()).resolves.toEqual(marker);
    await expect(readJournalRecord(OWNER_USER_ID)).resolves.toEqual({
      key: `${LOCAL_BACKUP_UI_RESTORE_MARKER_KIND}:${OWNER_USER_ID}`,
      markerKind: LOCAL_BACKUP_UI_RESTORE_MARKER_KIND,
      ownerUserId: OWNER_USER_ID,
      marker,
    });
    expect(readSentinel(OWNER_USER_ID)).toEqual(sentinelFor(marker));
  });

  it('restores the previous durable marker when rich sentinel read-back sees compatibility evidence', async () => {
    const marker = makeMarker();
    const journal = createLocalBackupUiRestoreJournal(OWNER_USER_ID);
    await journal.create(marker);
    const next = {
      ...marker,
      state: 'restoring' as const,
      phase: 'projects' as const,
    };
    const sentinelKey = getLocalBackupUiRestoreSentinelStorageKey(OWNER_USER_ID);
    const originalSetItem = localStorage.setItem.bind(localStorage);
    let downgradedRichSentinel = false;
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (!downgradedRichSentinel && key === sentinelKey && isRichSentinelValue(String(value))) {
        downgradedRichSentinel = true;
        return originalSetItem(key, JSON.stringify(compatibilitySentinelFor(next)));
      }
      return originalSetItem(key, value);
    });

    await expect(journal.replace(marker, next)).rejects.toThrow('schema validation');
    await expect(journal.read()).resolves.toEqual(marker);
    await expect(readJournalRecord(OWNER_USER_ID)).resolves.toEqual({
      key: `${LOCAL_BACKUP_UI_RESTORE_MARKER_KIND}:${OWNER_USER_ID}`,
      markerKind: LOCAL_BACKUP_UI_RESTORE_MARKER_KIND,
      ownerUserId: OWNER_USER_ID,
      marker,
    });
    expect(readSentinel(OWNER_USER_ID)).toEqual(sentinelFor(marker));
  });

  it('CAS-claims an expired marker with a new run identity', async () => {
    const marker = {
      ...makeMarker(),
      leaseExpiresAt: '2000-01-01T00:00:00.000Z',
    };
    const firstJournal = createLocalBackupUiRestoreJournal(OWNER_USER_ID);
    const secondJournal = createLocalBackupUiRestoreJournal(OWNER_USER_ID);
    await firstJournal.create(marker);

    const [firstClaim, secondClaim] = await Promise.all([
      firstJournal.claimExpired(marker),
      secondJournal.claimExpired(marker),
    ]);
    const claims = [firstClaim, secondClaim].filter(
      (claim): claim is LocalBackupUiRestoreMarker => claim !== null,
    );

    expect(claims).toHaveLength(1);
    expect(claims[0].runId).not.toBe(marker.runId);
    await expect(firstJournal.verifyOwnership(marker)).resolves.toBe(false);
    await expect(firstJournal.verifyOwnership(claims[0])).resolves.toBe(true);
    expect(readSentinel(OWNER_USER_ID)).toEqual(sentinelFor(claims[0]));
  });

  it('preserves the stable restore identity when takeover rotates only the lease run', async () => {
    const marker = buildLocalBackupUiRestoreMarker({
      ...makeMarkerInput(),
      restoreRunId: RESTORE_RUN_ID,
      actionQueueRestoreIdentity: QUEUE_BACKUP_IDENTITY,
    } as never, Date.parse('2000-01-01T00:00:00.000Z'));
    const journal = createLocalBackupUiRestoreJournal(OWNER_USER_ID);
    await journal.create(marker);

    const claimed = await journal.claimExpired(marker);

    expect(marker.schemaVersion).toBe(2);
    expect(claimed?.runId).not.toBe(marker.runId);
    expect((claimed as unknown as Record<string, unknown>)['restoreRunId'])
      .toBe(RESTORE_RUN_ID);
    expect((claimed as unknown as Record<string, unknown>)['actionQueueRestoreIdentity'])
      .toEqual(QUEUE_BACKUP_IDENTITY);
  });

  it('heartbeat verification fails closed after marker ownership is lost', async () => {
    const marker = makeMarker();
    const journal = createLocalBackupUiRestoreJournal(OWNER_USER_ID);
    await journal.create(marker);
    const heartbeat = startLocalBackupUiRestoreMarkerHeartbeat(journal, marker, 60_000);

    await expect(heartbeat.verifyOwnership()).resolves.toBe(true);
    await expect(createLocalBackupUiRestoreJournal(OWNER_USER_ID).clear(marker)).resolves.toBe(true);
    await expect(heartbeat.verifyOwnership()).resolves.toBe(false);
    expect(heartbeat.hasOwnership()).toBe(false);
    await heartbeat.stop();
  });

  it('clears only the matching owner and run identity', async () => {
    const marker = makeMarker();
    const journal = createLocalBackupUiRestoreJournal(OWNER_USER_ID);
    await journal.create(marker);
    const wrongRunMarker = { ...marker, runId: 'different-restore-run' };

    await expect(journal.clear(wrongRunMarker)).resolves.toBe(false);
    await expect(journal.read()).resolves.toEqual(marker);
    await expect(journal.clear(marker)).resolves.toBe(true);
    await expect(journal.read()).resolves.toBeNull();
    expect(localStorage.getItem(getLocalBackupUiRestoreSentinelStorageKey(OWNER_USER_ID))).toBeNull();
  });
});

function makeMarker(now = Date.now()): LocalBackupUiRestoreMarker {
  return buildLocalBackupUiRestoreMarker(makeMarkerInput(), now);
}

function makeMarkerInput(): BuildLocalBackupUiRestoreMarkerInput {
  return {
    ownerUserId: OWNER_USER_ID,
    state: 'prepared',
    phase: 'pre-image-captured',
    completedStages: [],
    rollbackCompletedStages: [],
    source: {
      kind: 'local-file',
      reference: 'backup-fixture.json',
      checksum: SOURCE_DIGEST,
    },
    restoreRunId: RESTORE_RUN_ID,
    actionQueueRestoreIdentity: QUEUE_BACKUP_IDENTITY,
    touchedProjectIds: ['project-1'],
    preImage: {
      projectState: { projects: [{ id: 'project-1', name: 'local project before restore' }] },
      blackBox: [],
      attachmentOutbox: [],
      actionQueue: [],
      retryQueue: [],
      deadLetters: [],
      conflicts: [],
      metadata: { lastSyncTime: '2026-07-26T00:00:00.000Z' },
    },
    rollbackErrors: [],
  };
}

function sentinelFor(marker: LocalBackupUiRestoreMarker): Record<string, unknown> {
  return {
    schemaVersion: 2,
    storage: 'indexeddb-journal',
    markerKind: LOCAL_BACKUP_UI_RESTORE_MARKER_KIND,
    ownerUserId: marker.ownerUserId,
    runId: marker.runId,
    createdAt: marker.createdAt,
    leaseExpiresAt: marker.leaseExpiresAt,
  };
}

function compatibilitySentinelFor(marker: LocalBackupUiRestoreMarker): Record<string, unknown> {
  return {
    schemaVersion: 2,
    storage: 'indexeddb-journal',
    markerKind: LOCAL_BACKUP_UI_RESTORE_MARKER_KIND,
    ownerUserId: marker.ownerUserId,
    runId: marker.runId,
  };
}

function isRichSentinelValue(raw: string): boolean {
  const parsed = JSON.parse(raw) as unknown;
  return typeof parsed === 'object'
    && parsed !== null
    && Object.hasOwn(parsed, 'createdAt')
    && Object.hasOwn(parsed, 'leaseExpiresAt');
}

function writeSentinel(marker: LocalBackupUiRestoreMarker): void {
  localStorage.setItem(
    getLocalBackupUiRestoreSentinelStorageKey(marker.ownerUserId),
    JSON.stringify(sentinelFor(marker)),
  );
}

function readSentinel(ownerUserId: string): Record<string, unknown> {
  return JSON.parse(
    localStorage.getItem(getLocalBackupUiRestoreSentinelStorageKey(ownerUserId)) ?? 'null',
  ) as Record<string, unknown>;
}

async function readJournalRecord(ownerUserId: string): Promise<unknown> {
  const db = await openJournalDatabase();
  try {
    return await requestResult(
      db.transaction(JOURNAL_STORE_NAME, 'readonly')
        .objectStore(JOURNAL_STORE_NAME)
        .get(`${LOCAL_BACKUP_UI_RESTORE_MARKER_KIND}:${ownerUserId}`),
    );
  } finally {
    db.close();
  }
}

async function putJournalRecord(ownerUserId: string, value: unknown): Promise<void> {
  const db = await openJournalDatabase();
  try {
    const tx = db.transaction(JOURNAL_STORE_NAME, 'readwrite');
    tx.objectStore(JOURNAL_STORE_NAME).put(value, undefined);
    await transactionComplete(tx);
  } finally {
    db.close();
  }
  expect(ownerUserId).toBe(OWNER_USER_ID);
}

function openJournalDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(JOURNAL_DB_NAME, 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(JOURNAL_STORE_NAME)) {
        request.result.createObjectStore(JOURNAL_STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionComplete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}
