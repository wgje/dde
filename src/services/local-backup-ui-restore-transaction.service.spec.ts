import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SYNC_CONFIG } from '../config';
import type { Project } from '../models';
import { deleteDataSafetyRestoreMarkerJournalDatabaseForTests } from './data-safety-restore-marker-journal';
import {
  createLocalBackupUiRestoreJournal,
  getLocalBackupUiRestoreSentinelStorageKey,
  startLocalBackupUiRestoreMarkerHeartbeat,
} from './local-backup-ui-restore-journal';
import type { LocalBackupUiRestoreJournal } from './local-backup-ui-restore-journal';
import {
  captureLocalBackupUiRestorePreImage,
  type LocalBackupUiRestorePreImageReaders,
} from './local-backup-ui-restore-pre-image.service';
import {
  getLocalBackupUiRestoreQuiescenceSentinelStorageKey,
  LocalBackupUiRestoreWriterQuiescenceService,
  type LocalBackupUiRestoreQuiescenceMarker,
} from './local-backup-ui-restore-writer-quiescence.service';
import type {
  LocalBackupUiRestoreMarker,
  LocalBackupUiRestorePreImage,
  LocalBackupUiRestoreStage,
} from './local-backup-ui-restore-types';
import type { LocalBackupUiRestoreStageOperations } from './local-backup-ui-restore-stage-protocol';
import type { PreparedLocalBackupUiRestoreWriterQuiescence } from './local-backup-ui-restore-writer-quiescence.service';
import {
  prepareLocalBackupUiRestoreTransaction,
  takeoverExpiredLocalBackupUiRestoreTransaction,
  type LocalBackupUiRestoreTransactionDependencies,
} from './local-backup-ui-restore-transaction.service';
import { makeBackup } from './local-backup-ui-black-box-restore.spec-helpers';
import type { QueueBackupRestoreProviderResult } from './queue-backup-restore-provider.helpers';

const OWNER_USER_ID = 'restore-owner';
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const RESTORE_RUN_ID = '22222222-2222-4222-8222-222222222222';
const RESTORE_TOKEN = '33333333-3333-4333-8333-333333333333';
const SOURCE_DIGEST = `sha256:${'a'.repeat(64)}`;
const IDENTITY_DIGEST = `sha256:${'b'.repeat(64)}`;
const ACTION_QUEUE_IDENTITY = {
  ownerUserId: OWNER_USER_ID,
  restoreRunId: RESTORE_RUN_ID,
  participant: 'action-queue' as const,
  sourceDigest: SOURCE_DIGEST,
  token: RESTORE_TOKEN,
  recordId: `queue-backup:${OWNER_USER_ID}`,
  identityDigest: IDENTITY_DIGEST,
  receiptId: `queue-backup-personal-restore-receipt:v2:${IDENTITY_DIGEST.slice(7)}`,
};
const STARTED_AT = new Date('2026-01-01T00:00:00.000Z');
const RETRY_QUEUE_RESTORE_ITEM = {
  id: '33333333-3333-4333-8333-333333333333',
  operationId: '44444444-4444-4444-8444-444444444444',
  type: 'task',
  operation: 'upsert',
  data: { id: '55555555-5555-4555-8555-555555555555' },
  retryCount: 0,
  createdAt: Date.parse('2026-07-27T00:00:00.000Z'),
  sourceUserId: OWNER_USER_ID,
};

describe('prepareLocalBackupUiRestoreTransaction', () => {
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

  it('drains writers, captures the pre-image, and verifies the durable marker in order', async () => {
    const order: string[] = [];
    const markerStore = { current: null as unknown };
    const dependencies = makeDependencies(order, markerStore);

    const handle = await prepareLocalBackupUiRestoreTransaction({
      ownerUserId: OWNER_USER_ID,
      source: { kind: 'local-file', reference: 'backup.json', checksum: SOURCE_DIGEST },
      touchedProjectIds: ['project-new', 'project-1'],
      currentProjects: [] as Project[],
      retryQueueRestoreItems: [RETRY_QUEUE_RESTORE_ITEM],
      restoredActionQueueItems: [],
      blackBoxBackup: makeBackup([]),
    }, dependencies);

    expect(order).toEqual([
      'quiescence.prepare',
      'pre-image.capture',
      'black-box.prepare',
      'queue-backup.identity',
      'journal.create',
      'journal.read',
      'journal.verify',
      'queue-backup.prepare',
      'queue-backup.read-state',
      'marker-heartbeat.start',
      'marker-heartbeat.verify',
    ]);
    expect(markerStore.current).toEqual(expect.objectContaining({
      schemaVersion: 2,
      ownerUserId: OWNER_USER_ID,
      runId: RUN_ID,
      restoreRunId: RESTORE_RUN_ID,
      actionQueueRestoreIdentity: ACTION_QUEUE_IDENTITY,
      state: 'prepared',
      phase: 'pre-image-captured',
      completedStages: [],
      rollbackCompletedStages: [],
      touchedProjectIds: ['project-1', 'project-new'],
      preImage: makePreImage(),
      rollbackErrors: [],
    }));
    expect(dependencies.capturePreImage).toHaveBeenCalledWith({
      ownerUserId: OWNER_USER_ID,
      touchedProjectIds: ['project-1', 'project-new'],
      currentProjects: [],
      retryQueueRestoreItems: [RETRY_QUEUE_RESTORE_ITEM],
    });
    expect('run' in handle).toBe(true);
    expect('commit' in handle).toBe(false);
    await expect(handle.verifyOwnership()).resolves.toBe(true);
  });

  it('clears the restore marker before reopening writers on an owned no-mutation abort', async () => {
    const order: string[] = [];
    const markerStore = { current: null as unknown };
    const dependencies = makeDependencies(order, markerStore);
    const handle = await prepareLocalBackupUiRestoreTransaction({
      ownerUserId: OWNER_USER_ID,
      source: { kind: 'local-file', reference: null, checksum: SOURCE_DIGEST },
      touchedProjectIds: ['project-1'],
      currentProjects: [],
      retryQueueRestoreItems: [],
      restoredActionQueueItems: [],
      blackBoxBackup: makeBackup([]),
    }, dependencies);
    order.length = 0;

    await handle.abortBeforeMutation();

    expect(order).toEqual([
      'quiescence.verify',
      'marker-heartbeat.verify',
      'queue-backup.read-state',
      'queue-backup.rollback',
      'queue-backup.read-provider',
      'marker-heartbeat.stop',
      'journal.clear',
      'journal.read',
      'queue-backup.read-provider',
      'quiescence.abort',
    ]);
  });

  it('does not resolve a completed run until the marker is cleared and writers reopen last', async () => {
    const order: string[] = [];
    const markerStore = { current: null as unknown };
    const dependencies = makeDependencies(order, markerStore);
    const handle = await prepareLocalBackupUiRestoreTransaction({
      ownerUserId: OWNER_USER_ID,
      source: { kind: 'local-file', reference: 'backup.json', checksum: SOURCE_DIGEST },
      touchedProjectIds: ['project-1'],
      currentProjects: [],
      retryQueueRestoreItems: [],
      restoredActionQueueItems: [],
      blackBoxBackup: makeBackup([]),
    }, dependencies);
    order.length = 0;

    await expect(handle.run(makeOperations())).resolves.toMatchObject({ status: 'completed' });

    expect(order.slice(-10)).toEqual([
      'quiescence.finalize:completed',
      'marker-heartbeat.verify',
      'queue-backup.read-state',
      'queue-backup.finalize',
      'queue-backup.read-provider',
      'marker-heartbeat.stop',
      'journal.clear',
      'journal.read',
      'queue-backup.read-provider',
      'quiescence.release',
    ]);
  });

  it('retains the marker and writer freeze when terminal storage lacks readback confirmation', async () => {
    const order: string[] = [];
    const markerStore = { current: null as unknown };
    const dependencies = makeDependencies(order, markerStore);
    dependencies.queueBackup.readPersonalRestoreProviderEvidence = vi.fn(async () => {
      order.push('queue-backup.read-provider');
      return {
        ...makeProviderEvidence(makeTerminalReceipt('finalize')),
        storage: 'CONFIRMED_EMPTY',
      } as QueueBackupRestoreProviderResult;
    });
    const handle = await prepareLocalBackupUiRestoreTransaction({
      ownerUserId: OWNER_USER_ID,
      source: { kind: 'local-file', reference: 'backup.json', checksum: SOURCE_DIGEST },
      touchedProjectIds: ['project-1'], currentProjects: [], retryQueueRestoreItems: [],
      restoredActionQueueItems: [], blackBoxBackup: makeBackup([]),
    }, dependencies);
    order.length = 0;

    await expect(handle.run(makeOperations())).resolves.toMatchObject({
      status: 'blocked',
      error: expect.objectContaining({
        message: expect.stringMatching(/authoritative/i),
      }),
    });

    expect(markerStore.current).not.toBeNull();
    expect(order).not.toContain('journal.clear');
    expect(order).not.toContain('quiescence.release');
  });

  it('keeps the marker and writer freeze when durable read-back loses identity', async () => {
    const order: string[] = [];
    const markerStore = { current: null as unknown };
    const dependencies = makeDependencies(order, markerStore);
    dependencies.createJournal = ownerUserId => ({
      ...makeJournal(order, markerStore, ownerUserId),
      read: vi.fn(async () => ({
        ...(markerStore.current as Record<string, unknown>),
        runId: '22222222-2222-4222-8222-222222222222',
      })) as unknown as LocalBackupUiRestoreJournal['read'],
    });

    await expect(prepareLocalBackupUiRestoreTransaction({
      ownerUserId: OWNER_USER_ID,
      source: { kind: 'local-file', reference: null, checksum: SOURCE_DIGEST },
      touchedProjectIds: ['project-1'],
      currentProjects: [],
      retryQueueRestoreItems: [],
      restoredActionQueueItems: [],
      blackBoxBackup: makeBackup([]),
    }, dependencies)).rejects.toThrow(/read-back/i);

    expect(order).not.toContain('journal.clear');
    expect(order).not.toContain('quiescence.abort');
  });

  it('rejects an expired retryQueue footprint before creating the durable marker', async () => {
    const order: string[] = [];
    const markerStore = { current: null as unknown };
    const dependencies = makeDependencies(order, markerStore);
    const readers = makePreImageReaders();
    const now = RETRY_QUEUE_RESTORE_ITEM.createdAt + SYNC_CONFIG.MAX_RETRY_ITEM_AGE;
    dependencies.capturePreImage = vi.fn(async input => {
      order.push('pre-image.capture');
      return await captureLocalBackupUiRestorePreImage(input, readers, {
        now,
        maxItemAgeMs: SYNC_CONFIG.MAX_RETRY_ITEM_AGE,
        maxRetries: Number.MAX_SAFE_INTEGER,
      });
    });
    const createJournal = vi.fn(dependencies.createJournal);
    dependencies.createJournal = createJournal;

    const outcome = await prepareLocalBackupUiRestoreTransaction({
      ownerUserId: OWNER_USER_ID,
      source: { kind: 'local-file', reference: 'backup.json', checksum: SOURCE_DIGEST },
      touchedProjectIds: [],
      currentProjects: [],
      retryQueueRestoreItems: [RETRY_QUEUE_RESTORE_ITEM],
      restoredActionQueueItems: [],
      blackBoxBackup: makeBackup([]),
    }, dependencies).then(
      value => ({ value }),
      error => ({ error }),
    );

    expect.soft(order).toEqual([
      'quiescence.prepare',
      'pre-image.capture',
      'quiescence.abort',
    ]);
    expect.soft(createJournal).not.toHaveBeenCalled();
    expect.soft(markerStore.current).toBeNull();
    expect(outcome).toHaveProperty('error');
    expect(String('error' in outcome ? outcome.error : '')).toMatch(/retryQueue/i);
  });

  it('runs expired restoring evidence through rollback-only takeover and clears both evidence records before writers reopen', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(STARTED_AT);
    const quiescence = new LocalBackupUiRestoreWriterQuiescenceService({
      leaseMs: 1_000,
      pollIntervalMs: 1,
    });
    const preparedQuiescence = await quiescence.prepare(OWNER_USER_ID);
    const quiescenceMarker = preparedQuiescence.marker();
    vi.clearAllTimers();
    const journal = createLocalBackupUiRestoreJournal(OWNER_USER_ID);
    const marker = makeStartupRecoveryMarker(quiescenceMarker, {
      state: 'restoring',
      phase: 'projects',
    });
    await journal.create(marker);
    vi.setSystemTime(new Date(STARTED_AT.getTime() + 2_000));

    const handle = await takeoverExpiredLocalBackupUiRestoreTransaction(
      marker,
      quiescenceMarker,
      {
        createJournal: createLocalBackupUiRestoreJournal,
        takeoverQuiescence: (expected, claimed) => quiescence.takeoverExpired(expected, claimed),
        startMarkerHeartbeat: startLocalBackupUiRestoreMarkerHeartbeat,
        queueBackup: makeRecoveryQueueBackupPort(),
      },
    );

    await expect(handle.runStartupRollback(makeRollbackOnlyOperations()))
      .resolves.toMatchObject({ status: 'rolled-back' });
    await expect(journal.read()).resolves.toBeNull();
    await expect(quiescence.readStartupRecoveryEvidence(OWNER_USER_ID)).resolves.toBeNull();
    expect(localStorage.getItem(getLocalBackupUiRestoreSentinelStorageKey(OWNER_USER_ID)))
      .toBeNull();
    expect(localStorage.getItem(
      getLocalBackupUiRestoreQuiescenceSentinelStorageKey(OWNER_USER_ID),
    )).toBeNull();
    expect(() => quiescence.runSync(OWNER_USER_ID, 'action-queue', () => undefined))
      .not.toThrow();
  });

  it('keeps a split journal claim frozen and later repairs it once both sides expire with the same owner and createdAt', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(STARTED_AT);
    const quiescence = new LocalBackupUiRestoreWriterQuiescenceService({
      leaseMs: 1_000,
      pollIntervalMs: 1,
    });
    const preparedQuiescence = await quiescence.prepare(OWNER_USER_ID);
    const quiescenceMarker = preparedQuiescence.marker();
    vi.clearAllTimers();
    const journal = createLocalBackupUiRestoreJournal(OWNER_USER_ID);
    const marker = makeStartupRecoveryMarker(quiescenceMarker, {
      state: 'restoring',
      phase: 'projects',
    });
    await journal.create(marker);
    vi.setSystemTime(new Date(STARTED_AT.getTime() + 2_000));

    await expect(takeoverExpiredLocalBackupUiRestoreTransaction(
      marker,
      quiescenceMarker,
      {
        createJournal: createLocalBackupUiRestoreJournal,
        takeoverQuiescence: vi.fn(async () => {
          throw new Error('quiescence adopt failed');
        }),
        startMarkerHeartbeat: startLocalBackupUiRestoreMarkerHeartbeat,
        queueBackup: makeRecoveryQueueBackupPort(),
      },
    )).rejects.toThrow('quiescence adopt failed');

    const splitMarker = await journal.read();
    const splitQuiescence = await quiescence.readStartupRecoveryEvidence(OWNER_USER_ID);
    expect(splitMarker).toEqual(expect.objectContaining({
      ownerUserId: OWNER_USER_ID,
      createdAt: quiescenceMarker.createdAt,
    }));
    expect(splitMarker?.runId).not.toBe(marker.runId);
    expect(splitQuiescence).toEqual(quiescenceMarker);

    vi.setSystemTime(new Date(STARTED_AT.getTime() + (6 * 60 * 1000)));
    const repairedHandle = await takeoverExpiredLocalBackupUiRestoreTransaction(
      splitMarker!,
      splitQuiescence!,
      {
        createJournal: createLocalBackupUiRestoreJournal,
        takeoverQuiescence: (expected, claimed) => quiescence.takeoverExpired(expected, claimed),
        startMarkerHeartbeat: startLocalBackupUiRestoreMarkerHeartbeat,
        queueBackup: makeRecoveryQueueBackupPort(),
      },
    );

    await expect(repairedHandle.runStartupRollback(makeRollbackOnlyOperations()))
      .resolves.toMatchObject({ status: 'rolled-back' });
    await expect(journal.read()).resolves.toBeNull();
    await expect(quiescence.readStartupRecoveryEvidence(OWNER_USER_ID)).resolves.toBeNull();
  });

  it('finishes expired finalizing evidence with cleanup only and never reruns rollback', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(STARTED_AT);
    const quiescence = new LocalBackupUiRestoreWriterQuiescenceService({
      leaseMs: 1_000,
      pollIntervalMs: 1,
    });
    const preparedQuiescence = await quiescence.prepare(OWNER_USER_ID);
    await preparedQuiescence.prepareFinalization('completed');
    const quiescenceMarker = preparedQuiescence.marker();
    vi.clearAllTimers();
    const journal = createLocalBackupUiRestoreJournal(OWNER_USER_ID);
    const marker = makeStartupRecoveryMarker(quiescenceMarker, {
      state: 'completed',
      phase: 'finalizing',
      completedStages: ['projects'],
    });
    await journal.create(marker);
    vi.setSystemTime(new Date(Date.parse(quiescenceMarker.leaseExpiresAt) + 1));

    const handle = await takeoverExpiredLocalBackupUiRestoreTransaction(
      marker,
      quiescenceMarker,
      {
        createJournal: createLocalBackupUiRestoreJournal,
        takeoverQuiescence: (expected, claimed) => quiescence.takeoverExpired(expected, claimed),
        startMarkerHeartbeat: startLocalBackupUiRestoreMarkerHeartbeat,
        queueBackup: makeRecoveryQueueBackupPort(),
      },
    );

    await expect(handle.finishFinalization('completed')).resolves.toBeUndefined();
    await expect(journal.read()).resolves.toBeNull();
    await expect(quiescence.readStartupRecoveryEvidence(OWNER_USER_ID)).resolves.toBeNull();
  });
});

function makePreImageReaders(): LocalBackupUiRestorePreImageReaders {
  return {
    readLocalStateSnapshot: vi.fn(async () => ({
      retryQueueIndexedDbItems: [],
      retryQueueLocalStorageValue: null,
      actionQueueBackupRecord: null,
      actionQueueLocalStorageValue: null,
      deadLetterBackupRecord: null,
      deadLetterLocalStorageValue: null,
      auditLocalStorageValue: null,
      conflictRestoreSnapshot: undefined,
      offlineSnapshotRestoreSnapshot: undefined,
    })),
    readMetadata: vi.fn(async () => ({
      projectCursors: [],
      lastSyncTime: null,
      replayLog: [],
      lastWriteExplain: null,
      taskTombstones: {},
      connectionTombstones: [],
    })),
    readExternalLinks: vi.fn(async () => []),
    readExternalPendingLinks: vi.fn(async () => []),
    readAttachmentUploads: vi.fn(async () => []),
    encodeBlob: vi.fn(async () => ''),
  };
}

function makeDependencies(
  order: string[],
  markerStore: { current: unknown },
): LocalBackupUiRestoreTransactionDependencies {
  const quiescence = makeQuiescence(order);
  let terminalReceipt: Record<string, unknown> | null = null;
  return {
    prepareQuiescence: vi.fn(async () => {
      order.push('quiescence.prepare');
      return quiescence;
    }),
    capturePreImage: vi.fn(async () => {
      order.push('pre-image.capture');
      return makePreImage();
    }),
    prepareBlackBox: vi.fn(async () => {
      order.push('black-box.prepare');
      return makePreImage().blackBox;
    }),
    createJournal: (ownerUserId: string) => makeJournal(order, markerStore, ownerUserId),
    createRestoreRunId: vi.fn(() => RESTORE_RUN_ID),
    createRestoreToken: vi.fn(() => RESTORE_TOKEN),
    createQueueBackupIdentity: vi.fn(async () => {
      order.push('queue-backup.identity');
      return ACTION_QUEUE_IDENTITY;
    }),
    queueBackup: {
      applyPersonalBackupRestoreTransitionV2: vi.fn(async command => {
        if (command.kind === 'prepare') {
          order.push('queue-backup.prepare');
          return { status: 'prepared' as const };
        }
        order.push(`queue-backup.${command.kind}`);
        terminalReceipt = makeTerminalReceipt(command.kind);
        return {
          status: command.kind === 'finalize' ? 'finalized' as const : 'rolled-back' as const,
          receipt: terminalReceipt as never,
        };
      }),
      readPersonalRestoreIdentityState: vi.fn(async () => {
        order.push('queue-backup.read-state');
        if (terminalReceipt) {
          return { status: 'terminal', receipt: terminalReceipt as never } as const;
        }
        return {
          status: 'active',
          transition: { preparedReceipt: ACTION_QUEUE_IDENTITY } as never,
        } as const;
      }),
      abandonPersonalRestoreBeforePrepare: vi.fn(async () => {
        order.push('queue-backup.abandon');
        terminalReceipt = makeTerminalReceipt('abandoned-before-prepare');
        return {
          status: 'abandoned-before-prepare',
          receipt: terminalReceipt as never,
        } as const;
      }),
      readPersonalRestoreProviderEvidence: vi.fn(async () => {
        order.push('queue-backup.read-provider');
        return terminalReceipt
          ? makeProviderEvidence(terminalReceipt)
          : { status: 'REJECTED', reason: 'AUTH_UNAVAILABLE' } as const;
      }),
    },
    startMarkerHeartbeat: () => {
      order.push('marker-heartbeat.start');
      return {
        marker: () => markerStore.current as never,
        hasOwnership: () => true,
        verifyOwnership: vi.fn(async () => {
          order.push('marker-heartbeat.verify');
          return true;
        }),
        stop: vi.fn(async () => {
          order.push('marker-heartbeat.stop');
        }),
      };
    },
  } as unknown as LocalBackupUiRestoreTransactionDependencies;
}

function makeTerminalReceipt(
  command: 'finalize' | 'rollback' | 'abandoned-before-prepare',
): Record<string, unknown> {
  const outcome = command === 'finalize'
    ? 'finalized'
    : command === 'rollback' ? 'rolled-back' : command;
  return {
    kind: 'queue-backup-personal-restore-receipt',
    schemaVersion: 2,
    ...ACTION_QUEUE_IDENTITY,
    id: ACTION_QUEUE_IDENTITY.receiptId,
    outcome,
    recordPresent: false,
    resultDigest: `sha256:${'c'.repeat(64)}`,
    completedAt: '2026-07-27T00:00:00.000Z',
  };
}

function makeProviderEvidence(receipt: Record<string, unknown>): QueueBackupRestoreProviderResult {
  const catalog = {
    id: `queue-backup-personal-restore-receipts:${OWNER_USER_ID}`,
    kind: 'queue-backup-personal-restore-receipt-catalog',
    schemaVersion: 2,
    ownerUserId: OWNER_USER_ID,
    receiptIds: [ACTION_QUEUE_IDENTITY.receiptId],
    receipts: { [ACTION_QUEUE_IDENTITY.receiptId]: receipt },
  };
  return {
    status: 'READABLE' as const,
    storage: 'READBACK_CONFIRMED' as const,
    identity: ACTION_QUEUE_IDENTITY,
    queue: { status: 'ABSENT' as const },
    deadLetters: { status: 'ABSENT' as const },
    catalog: { status: 'PRESENT_VALID' as const, value: catalog, rawSignature: 'catalog' },
    receipt: { status: 'PRESENT_VALID' as const, value: receipt, rawSignature: 'receipt' },
    terminal: {
      status: 'TERMINAL_CONFIRMED' as const,
      receipt,
      resultDigest: receipt['resultDigest'] as string,
      recordPresent: false,
    },
    snapshotSignature: 'snapshot',
  } as unknown as QueueBackupRestoreProviderResult;
}

function makeRecoveryQueueBackupPort(): LocalBackupUiRestoreTransactionDependencies['queueBackup'] {
  let terminalReceipt: Record<string, unknown> | null = null;
  return {
    readPersonalRestoreIdentityState: vi.fn(async () => terminalReceipt
      ? { status: 'terminal', receipt: terminalReceipt as never } as const
      : {
        status: 'active',
        transition: { preparedReceipt: ACTION_QUEUE_IDENTITY } as never,
      } as const),
    applyPersonalBackupRestoreTransitionV2: vi.fn(async command => {
      if (command.kind === 'prepare') return { status: 'prepared' as const };
      terminalReceipt = makeTerminalReceipt(command.kind);
      return {
        status: command.kind === 'finalize' ? 'finalized' as const : 'rolled-back' as const,
        receipt: terminalReceipt as never,
      };
    }),
    abandonPersonalRestoreBeforePrepare: vi.fn(async () => {
      terminalReceipt = makeTerminalReceipt('abandoned-before-prepare');
      return {
        status: 'abandoned-before-prepare' as const,
        receipt: terminalReceipt as never,
      };
    }),
    readPersonalRestoreProviderEvidence: vi.fn(async () => terminalReceipt
      ? makeProviderEvidence(terminalReceipt)
      : { status: 'REJECTED', reason: 'AUTH_UNAVAILABLE' } as const),
  };
}

function makeQuiescence(order: string[]): PreparedLocalBackupUiRestoreWriterQuiescence {
  return {
    marker: () => ({
      schemaVersion: 1,
      ownerUserId: OWNER_USER_ID,
      runId: RUN_ID,
      createdAt: '2026-07-27T00:00:00.000Z',
      leaseExpiresAt: '2099-07-27T00:00:00.000Z',
      state: 'quiesced',
    }),
    verifyOwnership: vi.fn(async () => {
      order.push('quiescence.verify');
      return true;
    }),
    runMutation: vi.fn(async (_source, write) => await write()),
    drainWriters: vi.fn(async () => undefined),
    prepareFinalization: vi.fn(async outcome => {
      order.push(`quiescence.finalize:${outcome}`);
    }),
    releaseFinalized: vi.fn(async () => {
      order.push('quiescence.release');
    }),
    abortBeforeMutation: vi.fn(async () => {
      order.push('quiescence.abort');
    }),
  };
}

function makeJournal(
  order: string[],
  markerStore: { current: unknown },
  _ownerUserId: string,
): LocalBackupUiRestoreJournal {
  return {
    create: vi.fn(async marker => {
      order.push('journal.create');
      markerStore.current = marker;
    }),
    read: vi.fn(async () => {
      order.push('journal.read');
      return markerStore.current as Awaited<ReturnType<LocalBackupUiRestoreJournal['read']>>;
    }),
    replace: vi.fn(async (expected, next) => {
      if (markerStore.current !== expected) return null;
      markerStore.current = next;
      return next;
    }),
    claimExpired: vi.fn(async () => null),
    renew: vi.fn(async marker => marker),
    verifyOwnership: vi.fn(async () => {
      order.push('journal.verify');
      return true;
    }),
    clear: vi.fn(async () => {
      order.push('journal.clear');
      markerStore.current = null;
      return true;
    }),
  };
}

function makePreImage(): LocalBackupUiRestorePreImage {
  return {
    projectState: { schemaVersion: 1, projects: [] },
    blackBox: {
      schemaVersion: 1,
      ownerUserId: OWNER_USER_ID,
      sourceDigest: SOURCE_DIGEST,
      before: [],
      target: [],
    },
    attachmentOutbox: [],
    actionQueue: { indexedDb: null, localStorage: null },
    retryQueue: {
      schemaVersion: 2,
      indexedDb: [],
      localStorage: null,
      restoredItems: [RETRY_QUEUE_RESTORE_ITEM],
    },
    deadLetters: { indexedDb: null, localStorage: null },
    conflicts: null,
    metadata: { lastSyncTime: null },
  };
}

function makeOperations(): LocalBackupUiRestoreStageOperations {
  return {
    decodePreImage: vi.fn(),
    apply: vi.fn(async () => 1),
    verifyApplied: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    verifyRolledBack: vi.fn(async () => undefined),
  };
}

function makeRollbackOnlyOperations(): LocalBackupUiRestoreStageOperations {
  return {
    decodePreImage: vi.fn(),
    apply: vi.fn(async () => {
      throw new Error('startup recovery must not resume forward import');
    }),
    verifyApplied: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    verifyRolledBack: vi.fn(async () => undefined),
  };
}

function makeStartupRecoveryMarker(
  identity: LocalBackupUiRestoreQuiescenceMarker,
  overrides: Partial<{
    state: 'restoring' | 'rolling-back' | 'rollback-failed' | 'completed' | 'rolled-back';
    phase: LocalBackupUiRestoreStage | 'finalizing';
    completedStages: LocalBackupUiRestoreStage[];
    rollbackCompletedStages: LocalBackupUiRestoreStage[];
  }> = {},
): LocalBackupUiRestoreMarker {
  return {
    schemaVersion: 2,
    ownerUserId: identity.ownerUserId,
    runId: identity.runId,
    restoreRunId: RESTORE_RUN_ID,
    actionQueueRestoreIdentity: ACTION_QUEUE_IDENTITY,
    createdAt: identity.createdAt,
    leaseExpiresAt: identity.leaseExpiresAt,
    state: 'restoring',
    phase: 'projects',
    completedStages: [],
    rollbackCompletedStages: [],
    source: { kind: 'local-file', reference: 'backup.json', checksum: SOURCE_DIGEST },
    touchedProjectIds: ['project-1'],
    preImage: {
      projectState: [],
      blackBox: makePreImage().blackBox,
      attachmentOutbox: [],
      actionQueue: [],
      retryQueue: [],
      deadLetters: [],
      conflicts: [],
      metadata: null,
    },
    rollbackErrors: [],
    ...overrides,
  };
}
