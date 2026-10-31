import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deleteDataSafetyRestoreMarkerJournalDatabaseForTests } from './data-safety-restore-marker-journal';
import type { QueueBackupPersonalRestoreIdentityV2 } from './action-queue.types';
import {
  createLocalBackupUiRestoreJournal,
  getLocalBackupUiRestoreSentinelStorageKey,
} from './local-backup-ui-restore-journal';
import { LocalBackupUiRestorePreImageService } from './local-backup-ui-restore-pre-image.service';
import { decodeLocalBackupUiRestoreStageSnapshots } from './local-backup-ui-restore-stage-snapshots';
import type { LocalBackupUiRestoreMarker } from './local-backup-ui-restore-types';
import type { LocalBackupUiRestoreStageOperations } from './local-backup-ui-restore-stage-protocol';
import {
  LocalBackupUiRestoreStageService,
} from './local-backup-ui-restore-stage.service';
import {
  LocalBackupUiRestoreStartupRecoveryService,
} from './local-backup-ui-restore-startup-recovery.service';
import {
  getLocalBackupUiRestoreQuiescenceSentinelStorageKey,
  LocalBackupUiRestoreWriterPausedError,
  LocalBackupUiRestoreWriterQuiescenceService,
  type LocalBackupUiRestoreQuiescenceMarker,
} from './local-backup-ui-restore-writer-quiescence.service';
import { beginLocalBackupUiRestoreWriter } from './local-backup-ui-restore-writer-quiescence-tracker';
import {
  LocalBackupUiRestoreTransactionService,
} from './local-backup-ui-restore-transaction.service';
import { QueueBackupService } from './queue-backup.service';
import { createQueueBackupPersonalRestoreIdentity } from './queue-backup-personal-restore-transition.helpers';

const OWNER_USER_ID = 'startup-recovery-owner';
const RESTORE_RUN_ID = '22222222-2222-4222-8222-222222222222';
const SOURCE_DIGEST = `sha256:${'a'.repeat(64)}`;
const RESTORE_TOKEN = '33333333-3333-4333-8333-333333333333';
const STARTED_AT = new Date('2026-01-01T00:00:00.000Z');
let actionQueueIdentity: QueueBackupPersonalRestoreIdentityV2;
let queueBackup: ReturnType<typeof createQueueBackupFake>;

describe('LocalBackupUiRestoreStartupRecoveryService', () => {
  let service: LocalBackupUiRestoreStartupRecoveryService;
  let transaction: LocalBackupUiRestoreTransactionService;
  let mockStageService: {
    createRecoveryOperations: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    localStorage.clear();
    await deleteDataSafetyRestoreMarkerJournalDatabaseForTests();
    actionQueueIdentity = await createQueueBackupPersonalRestoreIdentity({
      ownerUserId: OWNER_USER_ID,
      restoreRunId: RESTORE_RUN_ID,
      participant: 'action-queue',
      sourceDigest: SOURCE_DIGEST,
      token: RESTORE_TOKEN,
    });
    queueBackup = createQueueBackupFake(() => actionQueueIdentity);
    mockStageService = {
      createRecoveryOperations: vi.fn(() => makeRecoveryOperations()),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        LocalBackupUiRestoreStartupRecoveryService,
        LocalBackupUiRestoreTransactionService,
        { provide: LocalBackupUiRestorePreImageService, useValue: { capture: vi.fn() } },
        { provide: LocalBackupUiRestoreStageService, useValue: mockStageService },
        { provide: QueueBackupService, useValue: queueBackup },
      ],
    });
    service = TestBed.inject(LocalBackupUiRestoreStartupRecoveryService);
    transaction = TestBed.inject(LocalBackupUiRestoreTransactionService);
    vi.spyOn(transaction, 'takeoverExpired');
  });

  afterEach(async () => {
    vi.clearAllTimers();
    vi.useRealTimers();
    localStorage.clear();
    TestBed.resetTestingModule();
    await deleteDataSafetyRestoreMarkerJournalDatabaseForTests();
  });

  it('cleans an expired prepared marker before any restore stage mutated data', async () => {
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
    await journal.create(makeMarker(quiescenceMarker));
    vi.setSystemTime(new Date(STARTED_AT.getTime() + 2_000));
    await expect(service.recover(OWNER_USER_ID)).resolves.toEqual({ status: 'recovered' });

    expect(transaction.takeoverExpired).toHaveBeenCalledWith(
      expect.objectContaining({ runId: quiescenceMarker.runId }),
      quiescenceMarker,
    );
    expect(mockStageService.createRecoveryOperations).toHaveBeenCalledTimes(1);
    const operations = mockStageService.createRecoveryOperations.mock.results[0]
      ?.value as LocalBackupUiRestoreStageOperations;
    expect(operations.decodePreImage).toHaveBeenCalledTimes(2);
    expect(operations.apply).not.toHaveBeenCalled();
    expect(operations.verifyApplied).not.toHaveBeenCalled();
    expect(operations.rollback).not.toHaveBeenCalled();
    expect(operations.verifyRolledBack).not.toHaveBeenCalled();
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

  it('blocks absent QueueBackup identity before taking over a mutated marker', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(STARTED_AT);
    const evidence = await seedEvidence({ state: 'restoring', phase: 'projects' });
    queueBackup.readPersonalRestoreIdentityState.mockResolvedValue({
      status: 'absent-for-identity', identity: actionQueueIdentity, absenceProof: {},
    });
    const markerBefore = await evidence.journal.read();
    const sentinelKey = getLocalBackupUiRestoreQuiescenceSentinelStorageKey(OWNER_USER_ID);
    const sentinelBefore = localStorage.getItem(sentinelKey);
    vi.setSystemTime(new Date(Date.parse(evidence.quiescenceMarker.leaseExpiresAt) + 1));

    await expect(service.recover(OWNER_USER_ID))
      .resolves.toEqual({ status: 'blocked', reason: 'invalid-evidence' });

    expect(transaction.takeoverExpired).not.toHaveBeenCalled();
    expect(queueBackup.applyPersonalBackupRestoreTransitionV2).not.toHaveBeenCalled();
    expect(queueBackup.abandonPersonalRestoreBeforePrepare).not.toHaveBeenCalled();
    await expect(evidence.journal.read()).resolves.toEqual(markerBefore);
    expect(localStorage.getItem(sentinelKey)).toBe(sentinelBefore);
  });

  it.each([
    ['restoring', []],
    ['rolling-back', ['projects']],
    ['rollback-failed', ['projects']],
  ] as const)(
    'blocks an expired %s marker and retains both durable sentinels',
    async (state, completedStages) => {
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
      vi.setSystemTime(STARTED_AT);
      const evidence = await seedEvidence({
        state,
        phase: 'projects',
        completedStages: [...completedStages],
      });
      vi.setSystemTime(new Date(Date.parse(evidence.quiescenceMarker.leaseExpiresAt) + 1));

      await expect(service.recover(OWNER_USER_ID))
        .resolves.toEqual({ status: 'recovered' });

      expect(transaction.takeoverExpired).toHaveBeenCalledWith(
        evidence.marker,
        evidence.quiescenceMarker,
      );
      expect(mockStageService.createRecoveryOperations).toHaveBeenCalledWith(
        OWNER_USER_ID,
        expect.objectContaining({
          confirmPrepared: expect.any(Function),
          rollback: expect.any(Function),
        }),
      );
    },
  );

  it('retains failed compensation evidence and resumes it after process interruption', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(STARTED_AT);
    const evidence = await seedEvidence({
      state: 'rolling-back',
      phase: 'retry-queue',
      completedStages: ['projects', 'attachment-outbox', 'action-queue', 'retry-queue'],
    });
    const failingOperations = makeRecoveryOperations();
    failingOperations.rollback = vi.fn(async stage => {
      if (stage === 'retry-queue') throw new Error('retry queue compensation failed');
    });
    mockStageService.createRecoveryOperations.mockReturnValueOnce(failingOperations);
    vi.setSystemTime(new Date(Date.parse(evidence.quiescenceMarker.leaseExpiresAt) + 1));

    await expect(service.recover(OWNER_USER_ID))
      .resolves.toEqual({ status: 'blocked', reason: 'invalid-evidence' });

    const failedMarker = await evidence.journal.read();
    const failedQuiescence = await evidence.quiescence
      .readStartupRecoveryEvidence(OWNER_USER_ID);
    expect(failedMarker).toMatchObject({
      state: 'rollback-failed',
      phase: 'retry-queue',
      rollbackErrors: [expect.objectContaining({
        stage: 'retry-queue',
        message: 'retry queue compensation failed',
      })],
    });
    expect(failedQuiescence).toMatchObject({
      ownerUserId: OWNER_USER_ID,
      runId: failedMarker?.runId,
      state: 'quiesced',
    });
    expect(() => evidence.quiescence.runSync(
      OWNER_USER_ID,
      'action-queue',
      () => undefined,
    )).toThrow(LocalBackupUiRestoreWriterPausedError);

    vi.clearAllTimers();
    const recoveryLeaseExpiresAt = Math.max(
      Date.parse(failedMarker!.leaseExpiresAt),
      Date.parse(failedQuiescence!.leaseExpiresAt),
    );
    vi.setSystemTime(new Date(recoveryLeaseExpiresAt + 1));
    await expect(service.recover(OWNER_USER_ID)).resolves.toEqual({ status: 'recovered' });

    const resumedOperations = mockStageService.createRecoveryOperations.mock.results[1]
      ?.value as LocalBackupUiRestoreStageOperations;
    expect(resumedOperations.apply).not.toHaveBeenCalled();
    expect(vi.mocked(resumedOperations.rollback).mock.calls.map(([stage]) => stage)).toEqual([
      'retry-queue',
      'action-queue',
      'attachment-outbox',
      'projects',
    ]);
    await expect(evidence.journal.read()).resolves.toBeNull();
    await expect(evidence.quiescence.readStartupRecoveryEvidence(OWNER_USER_ID))
      .resolves.toBeNull();
    expect(() => evidence.quiescence.runSync(
      OWNER_USER_ID,
      'action-queue',
      () => undefined,
    )).not.toThrow();
  });

  it('blocks an expired prepared split-claim whose runId no longer matches quiescence', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(STARTED_AT);
    const evidence = await seedEvidence();
    vi.setSystemTime(new Date(STARTED_AT.getTime() + 2_000));
    const splitMarker = await evidence.journal.claimExpired(evidence.marker);
    vi.setSystemTime(new Date(Date.parse(splitMarker!.leaseExpiresAt) + 1));

    await expect(service.recover(OWNER_USER_ID))
      .resolves.toEqual({ status: 'blocked', reason: 'invalid-evidence' });

    expect(transaction.takeoverExpired).not.toHaveBeenCalled();
    expect(mockStageService.createRecoveryOperations).not.toHaveBeenCalled();
    await expect(evidence.journal.read()).resolves.toEqual(splitMarker);
    await expect(evidence.quiescence.readStartupRecoveryEvidence(OWNER_USER_ID))
      .resolves.toEqual(evidence.quiescenceMarker);
  });

  it('blocks an active prepared marker without claiming or clearing it', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(STARTED_AT);
    const evidence = await seedEvidence();
    vi.setSystemTime(STARTED_AT);
    expect(Date.parse(evidence.marker.leaseExpiresAt)).toBeGreaterThan(Date.now());
    await expect(service.recover(OWNER_USER_ID))
      .resolves.toEqual({ status: 'blocked', reason: 'active-or-mutated' });

    expect(mockStageService.createRecoveryOperations).not.toHaveBeenCalled();
    expect(transaction.takeoverExpired).not.toHaveBeenCalled();
    await expect(evidence.journal.read()).resolves.toEqual(evidence.marker);
    await expect(evidence.quiescence.readStartupRecoveryEvidence(OWNER_USER_ID))
      .resolves.toEqual(evidence.quiescenceMarker);
  });

  it('rejects a schema-valid but semantically malformed pre-image before takeover', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(STARTED_AT);
    const evidence = await seedEvidence();
    const malformedMarker = {
      ...evidence.marker,
      preImage: { ...evidence.marker.preImage, projectState: [] },
    };
    await overwriteDurableMarker(malformedMarker);
    await expect(evidence.journal.read()).resolves.toEqual(malformedMarker);
    const markerSentinel = localStorage.getItem(
      getLocalBackupUiRestoreSentinelStorageKey(OWNER_USER_ID),
    );
    const quiescenceSentinel = localStorage.getItem(
      getLocalBackupUiRestoreQuiescenceSentinelStorageKey(OWNER_USER_ID),
    );
    vi.setSystemTime(new Date(STARTED_AT.getTime() + 2_000));
    await expect(service.recover(OWNER_USER_ID))
      .resolves.toEqual({ status: 'blocked', reason: 'invalid-evidence' });

    expect(transaction.takeoverExpired).not.toHaveBeenCalled();
    await expect(evidence.journal.read()).resolves.toEqual(malformedMarker);
    await expect(evidence.quiescence.readStartupRecoveryEvidence(OWNER_USER_ID))
      .resolves.toEqual(evidence.quiescenceMarker);
    expect(localStorage.getItem(getLocalBackupUiRestoreSentinelStorageKey(OWNER_USER_ID)))
      .toBe(markerSentinel);
    expect(localStorage.getItem(
      getLocalBackupUiRestoreQuiescenceSentinelStorageKey(OWNER_USER_ID),
    )).toBe(quiescenceSentinel);
    expect(() => evidence.quiescence.runSync(
      OWNER_USER_ID,
      'action-queue',
      () => undefined,
    )).toThrow(LocalBackupUiRestoreWriterPausedError);
  });

  it.each([
    ['restoring', 'projects', [], undefined],
    ['rolling-back', 'projects', ['projects'], undefined],
    ['rollback-failed', 'projects', ['projects'], undefined],
    ['completed', 'finalizing', ['projects'], 'completed'],
  ] as const)(
    'rejects malformed expired %s recovery evidence before takeover',
    async (state, phase, completedStages, finalizationOutcome) => {
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
      vi.setSystemTime(STARTED_AT);
      const evidence = await seedEvidence({
        state,
        phase,
        completedStages: [...completedStages],
      }, finalizationOutcome);
      const preImage = evidence.marker.preImage;
      if (!preImage || typeof preImage !== 'object'
        || !preImage.blackBox || typeof preImage.blackBox !== 'object') {
        throw new Error('seeded marker is missing its black-box pre-image');
      }
      const malformedMarker = {
        ...evidence.marker,
        preImage: {
          ...preImage,
          blackBox: { ...preImage.blackBox, ownerUserId: 'foreign-owner' },
        },
      };
      await overwriteDurableMarker(malformedMarker);
      const markerSentinel = localStorage.getItem(
        getLocalBackupUiRestoreSentinelStorageKey(OWNER_USER_ID),
      );
      const quiescenceSentinel = localStorage.getItem(
        getLocalBackupUiRestoreQuiescenceSentinelStorageKey(OWNER_USER_ID),
      );
      vi.setSystemTime(new Date(Date.parse(evidence.quiescenceMarker.leaseExpiresAt) + 1));

      await expect(service.recover(OWNER_USER_ID))
        .resolves.toEqual({ status: 'blocked', reason: 'invalid-evidence' });

      expect(transaction.takeoverExpired).not.toHaveBeenCalled();
      expect(mockStageService.createRecoveryOperations).not.toHaveBeenCalled();
      expect(queueBackup.applyPersonalBackupRestoreTransitionV2).not.toHaveBeenCalled();
      await expect(evidence.journal.read()).resolves.toEqual(malformedMarker);
      await expect(evidence.quiescence.readStartupRecoveryEvidence(OWNER_USER_ID))
        .resolves.toEqual(evidence.quiescenceMarker);
      expect(localStorage.getItem(getLocalBackupUiRestoreSentinelStorageKey(OWNER_USER_ID)))
        .toBe(markerSentinel);
      expect(localStorage.getItem(
        getLocalBackupUiRestoreQuiescenceSentinelStorageKey(OWNER_USER_ID),
      )).toBe(quiescenceSentinel);
    },
  );

  it('blocks a prepared createdAt mismatch and retains both marker identities', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(STARTED_AT);
    const evidence = await seedEvidence({ createdAt: '2026-01-02T00:00:00.000Z' });
    vi.setSystemTime(new Date(STARTED_AT.getTime() + 2_000));
    await expect(service.recover(OWNER_USER_ID))
      .resolves.toMatchObject({ status: 'blocked' });

    expect(mockStageService.createRecoveryOperations).not.toHaveBeenCalled();
    expect(transaction.takeoverExpired).not.toHaveBeenCalled();
    await expect(evidence.journal.read()).resolves.toEqual(evidence.marker);
    await expect(evidence.quiescence.readStartupRecoveryEvidence(OWNER_USER_ID))
      .resolves.toEqual(evidence.quiescenceMarker);
    expect(localStorage.getItem(getLocalBackupUiRestoreSentinelStorageKey(OWNER_USER_ID)))
      .not.toBeNull();
    expect(localStorage.getItem(
      getLocalBackupUiRestoreQuiescenceSentinelStorageKey(OWNER_USER_ID),
    )).not.toBeNull();
  });

  it('blocks same-createdAt quiescence with a different runId', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(STARTED_AT);
    const evidence = await seedEvidence({
      runId: '44444444-4444-4444-8444-444444444444',
    });
    vi.setSystemTime(new Date(STARTED_AT.getTime() + 2_000));

    await expect(service.recover(OWNER_USER_ID))
      .resolves.toEqual({ status: 'blocked', reason: 'invalid-evidence' });
    expect(transaction.takeoverExpired).not.toHaveBeenCalled();
    await expect(evidence.journal.read()).resolves.toEqual(evidence.marker);
    await expect(evidence.quiescence.readStartupRecoveryEvidence(OWNER_USER_ID))
      .resolves.toEqual(evidence.quiescenceMarker);
  });

  it('blocks foreign prepared quiescence before semantic decoding', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(STARTED_AT);
    const evidence = await seedEvidence({}, undefined, 'foreign-owner');
    vi.setSystemTime(new Date(STARTED_AT.getTime() + 2_000));

    await expect(service.recover(OWNER_USER_ID)).resolves.toMatchObject({ status: 'blocked' });
    expect(mockStageService.createRecoveryOperations).not.toHaveBeenCalled();
    expect(transaction.takeoverExpired).not.toHaveBeenCalled();
    await expect(evidence.journal.read()).resolves.toEqual(evidence.marker);
    await expect(evidence.quiescence.readStartupRecoveryEvidence('foreign-owner'))
      .resolves.toEqual(evidence.quiescenceMarker);
  });

  it('blocks prepared evidence that contains rollback error history', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(STARTED_AT);
    const evidence = await seedEvidence({
      rollbackErrors: [{
        stage: 'projects',
        message: 'rollback was attempted',
        recordedAt: STARTED_AT.toISOString(),
      }],
    });
    vi.setSystemTime(new Date(STARTED_AT.getTime() + 2_000));
    await expect(service.recover(OWNER_USER_ID))
      .resolves.toMatchObject({ status: 'blocked' });

    expect(mockStageService.createRecoveryOperations).not.toHaveBeenCalled();
    expect(transaction.takeoverExpired).not.toHaveBeenCalled();
    await expect(evidence.journal.read()).resolves.toEqual(evidence.marker);
    await expect(evidence.quiescence.readStartupRecoveryEvidence(OWNER_USER_ID))
      .resolves.toEqual(evidence.quiescenceMarker);
  });

  it.each([
    ['completed', 'completed'],
    ['rolled-back', 'rolled-back'],
    ['completed', 'quiesced'],
    ['rolled-back', 'quiesced'],
  ] as const)('finishes expired %s finalization with %s quiescence', async (
    outcome,
    quiescenceState,
  ) => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(STARTED_AT);
    const evidence = await seedEvidence({
      state: outcome,
      phase: 'finalizing',
      completedStages: outcome === 'completed' ? ['projects'] : [],
    }, quiescenceState === 'quiesced' ? undefined : quiescenceState);
    vi.setSystemTime(new Date(Date.parse(evidence.quiescenceMarker.leaseExpiresAt) + 1));
    await expect(service.recover(OWNER_USER_ID)).resolves.toEqual({ status: 'recovered' });
    expect(transaction.takeoverExpired)
      .toHaveBeenCalledWith(evidence.marker, evidence.quiescenceMarker);
    expect(mockStageService.createRecoveryOperations).not.toHaveBeenCalled();
    await expect(evidence.journal.read()).resolves.toBeNull();
    await expect(evidence.quiescence.readStartupRecoveryEvidence(OWNER_USER_ID))
      .resolves.toBeNull();
  });

  it.each([
    ['active', {}, undefined, 0],
    ['createdAt-mutated', { createdAt: '2026-01-02T00:00:00.000Z' }, undefined, 2_000],
    ['opposite-outcome', {}, 'rolled-back', 2_000],
  ] as const)('blocks %s finalization evidence without mutation', async (
    _caseName,
    markerOverrides,
    quiescenceOutcome,
    elapsedMs,
  ) => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(STARTED_AT);
    const evidence = await seedEvidence({
      state: 'completed', phase: 'finalizing', completedStages: ['projects'], ...markerOverrides,
    }, quiescenceOutcome);
    vi.setSystemTime(new Date(STARTED_AT.getTime() + elapsedMs));
    await expect(service.recover(OWNER_USER_ID)).resolves.toMatchObject({ status: 'blocked' });
    expect(transaction.takeoverExpired).not.toHaveBeenCalled();
    await expect(evidence.journal.read()).resolves.toEqual(evidence.marker);
    await expect(evidence.quiescence.readStartupRecoveryEvidence(OWNER_USER_ID))
      .resolves.toEqual(evidence.quiescenceMarker);
  });

  it('blocks foreign finalization evidence without mutation', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(STARTED_AT);
    const evidence = await seedEvidence({
      state: 'completed', phase: 'finalizing', completedStages: ['projects'],
    }, undefined, 'foreign-owner');
    vi.setSystemTime(new Date(STARTED_AT.getTime() + 2_000));
    await expect(service.recover(OWNER_USER_ID)).resolves.toMatchObject({ status: 'blocked' });
    expect(transaction.takeoverExpired).not.toHaveBeenCalled();
    await expect(evidence.journal.read()).resolves.toEqual(evidence.marker);
    await expect(evidence.quiescence.readStartupRecoveryEvidence('foreign-owner'))
      .resolves.toEqual(evidence.quiescenceMarker);
  });

  it.each(['completed', 'rolled-back'] as const)(
    'cleans orphaned expired finalizing-%s quiescence when the marker is already gone',
    async outcome => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(STARTED_AT);
    const quiescence = new LocalBackupUiRestoreWriterQuiescenceService({
      leaseMs: 1_000,
      pollIntervalMs: 1,
    });
    const preparedQuiescence = await quiescence.prepare(OWNER_USER_ID);
    await preparedQuiescence.prepareFinalization(outcome);
    const quiescenceMarker = preparedQuiescence.marker();
    const journal = createLocalBackupUiRestoreJournal(OWNER_USER_ID);
    const finalMarker = makeMarker(quiescenceMarker, {
      state: outcome, phase: 'finalizing', completedStages: outcome === 'completed' ? ['projects'] : [],
    });
    await journal.create(finalMarker);
    await expect(journal.clear(finalMarker)).resolves.toBe(true);
    vi.clearAllTimers();
    vi.setSystemTime(new Date(Date.parse(quiescenceMarker.leaseExpiresAt) + 1));

    await expect(service.recover(OWNER_USER_ID))
      .resolves.toEqual({ status: 'recovered' });

    await expect(quiescence.readStartupRecoveryEvidence(OWNER_USER_ID)).resolves.toBeNull();
    expect(localStorage.getItem(
      getLocalBackupUiRestoreQuiescenceSentinelStorageKey(OWNER_USER_ID),
    )).toBeNull();
    expect(transaction.takeoverExpired).not.toHaveBeenCalled();
    expect(mockStageService.createRecoveryOperations).not.toHaveBeenCalled();
    expect(() => quiescence.runSync(OWNER_USER_ID, 'action-queue', () => undefined))
      .not.toThrow();
    },
  );

  it('cleans expired orphaned quiesced evidence only after the main marker stayed absent', async () => {
    const { quiescence, sentinel } = await seedExpiredOrphanedQuiescence();

    await expect(service.recover(OWNER_USER_ID))
      .resolves.toEqual({ status: 'recovered' });
    await expect(quiescence.readStartupRecoveryEvidence(OWNER_USER_ID)).resolves.toBeNull();
    expect(localStorage.getItem(getLocalBackupUiRestoreQuiescenceSentinelStorageKey(OWNER_USER_ID))).toBeNull();
    expect(transaction.takeoverExpired).not.toHaveBeenCalled();
    expect(mockStageService.createRecoveryOperations).not.toHaveBeenCalled();
    expect(() => quiescence.runSync(OWNER_USER_ID, 'action-queue', () => undefined)).not.toThrow();
    expect(sentinel).not.toBeNull();
  });

  it('resumes expired quiesced cleanup after the durable marker was already deleted', async () => {
    const { quiescence, sentinel } = await seedExpiredOrphanedQuiescence();
    await deleteDurableQuiescenceMarker(OWNER_USER_ID);

    await expect(service.recover(OWNER_USER_ID)).resolves.toEqual({ status: 'recovered' });

    expect(sentinel).not.toBeNull();
    expect(localStorage.getItem(getLocalBackupUiRestoreQuiescenceSentinelStorageKey(OWNER_USER_ID))).toBeNull();
    expect(transaction.takeoverExpired).not.toHaveBeenCalled();
    expect(mockStageService.createRecoveryOperations).not.toHaveBeenCalled();
    expect(() => quiescence.runSync(OWNER_USER_ID, 'action-queue', () => undefined)).not.toThrow();
  });

  it.each([
    'finalizing-replacement', 'renewal', 'active-writer', 'malformed', 'foreign', 'appearing-marker',
  ] as const)('blocks protected pre-marker evidence without finalization fallthrough: %s', async scenario => {
    const { marker, sentinel, sentinelKey } = await seedExpiredOrphanedQuiescence();
    const quiescenceKey = `local-backup-ui-restore-quiescence:${OWNER_USER_ID}`;
    let writer: ReturnType<typeof beginLocalBackupUiRestoreWriter> | null = null;
    let readSpy: ReturnType<typeof injectOnRead> | null = null;
    if (scenario === 'active-writer') {
      localStorage.removeItem(sentinelKey);
      writer = beginLocalBackupUiRestoreWriter(OWNER_USER_ID, 'retry-queue', {
        leaseMs: 10_000, heartbeat: false,
      });
      localStorage.setItem(sentinelKey, sentinel!);
    } else if (scenario === 'malformed') localStorage.setItem(sentinelKey, '{malformed');
    else if (scenario === 'foreign') localStorage.setItem(
      sentinelKey, JSON.stringify({ ...JSON.parse(sentinel!), ownerUserId: 'foreign-owner' }),
    );
    else {
      const replacement = scenario === 'renewal'
        ? { ...marker, leaseExpiresAt: new Date(Date.now() + 10_000).toISOString() }
        : { ...marker, state: 'finalizing-completed' as const };
      const targetKey = scenario === 'appearing-marker'
        ? `local-backup-ui-restore:${OWNER_USER_ID}` : quiescenceKey;
      readSpy = injectOnRead(targetKey, scenario === 'appearing-marker' ? 3 : 2, (store, key) => {
        if (scenario === 'appearing-marker') store.put({ key, markerKind: 'local-backup-ui-restore' });
        else {
          store.put({ key, markerKind: 'local-backup-ui-restore-quiescence', ownerUserId: OWNER_USER_ID,
            marker: replacement });
          localStorage.setItem(sentinelKey, JSON.stringify({ ...JSON.parse(sentinel!),
            state: replacement.state, leaseExpiresAt: replacement.leaseExpiresAt }));
        }
      });
    }
    const deleteSpy = vi.spyOn(IDBObjectStore.prototype, 'delete');
    const finalizationSpy = vi.spyOn(LocalBackupUiRestoreWriterQuiescenceService.prototype,
      'takeoverExpiredFinalization');
    try {
      const reason = scenario === 'malformed' || scenario === 'foreign' ? 'invalid-evidence' : 'active-or-mutated';
      await expect(service.recover(OWNER_USER_ID)).resolves.toEqual({ status: 'blocked', reason });
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(finalizationSpy).not.toHaveBeenCalled();
    } finally {
      readSpy?.mockRestore();
      deleteSpy.mockRestore();
      finalizationSpy.mockRestore();
      writer?.release();
    }
  });
});

async function seedExpiredOrphanedQuiescence() {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(STARTED_AT);
  const quiescence = new LocalBackupUiRestoreWriterQuiescenceService({ leaseMs: 1_000 });
  const marker = (await quiescence.prepare(OWNER_USER_ID)).marker();
  const sentinelKey = getLocalBackupUiRestoreQuiescenceSentinelStorageKey(OWNER_USER_ID);
  const sentinel = localStorage.getItem(sentinelKey);
  vi.clearAllTimers();
  vi.setSystemTime(new Date(Date.parse(marker.leaseExpiresAt) + 1));
  return { quiescence, marker, sentinelKey, sentinel };
}

function injectOnRead(expectedKey: string, at: number,
  inject: (store: IDBObjectStore, key: IDBValidKey | IDBKeyRange) => void) {
  const originalGet = IDBObjectStore.prototype.get;
  let reads = 0;
  return vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (
    this: IDBObjectStore, key: IDBValidKey | IDBKeyRange,
  ) {
    if (key === expectedKey && ++reads === at) inject(this, key);
    return originalGet.call(this, key);
  });
}

async function seedEvidence(
  overrides: Partial<LocalBackupUiRestoreMarker> = {},
  finalizationOutcome?: 'completed' | 'rolled-back',
  quiescenceOwnerUserId = OWNER_USER_ID,
): Promise<{
  journal: ReturnType<typeof createLocalBackupUiRestoreJournal>;
  marker: LocalBackupUiRestoreMarker;
  quiescence: LocalBackupUiRestoreWriterQuiescenceService;
  quiescenceMarker: LocalBackupUiRestoreQuiescenceMarker;
}> {
  const quiescence = new LocalBackupUiRestoreWriterQuiescenceService({
    leaseMs: 1_000,
    pollIntervalMs: 1,
  });
  const preparedQuiescence = await quiescence.prepare(quiescenceOwnerUserId);
  if (finalizationOutcome) {
    await preparedQuiescence.prepareFinalization(finalizationOutcome);
  }
  const quiescenceMarker = preparedQuiescence.marker();
  vi.clearAllTimers();
  const journal = createLocalBackupUiRestoreJournal(OWNER_USER_ID);
  const marker = makeMarker(quiescenceMarker, { ownerUserId: OWNER_USER_ID, ...overrides });
  queueBackup.seedForMarker(marker);
  await journal.create(marker);
  return { journal, marker, quiescence, quiescenceMarker };
}

function makeMarker(
  identity: LocalBackupUiRestoreQuiescenceMarker,
  overrides: Partial<LocalBackupUiRestoreMarker> = {},
): LocalBackupUiRestoreMarker {
  return {
    schemaVersion: 2,
    ownerUserId: identity.ownerUserId,
    runId: identity.runId,
    restoreRunId: RESTORE_RUN_ID,
    actionQueueRestoreIdentity: actionQueueIdentity,
    createdAt: identity.createdAt,
    leaseExpiresAt: identity.leaseExpiresAt,
    state: 'prepared',
    phase: 'pre-image-captured',
    completedStages: [],
    rollbackCompletedStages: [],
    source: { kind: 'local-file', reference: 'phase-2c2a.json', checksum: SOURCE_DIGEST },
    touchedProjectIds: [],
    preImage: {
      projectState: {
        schemaVersion: 1,
        projects: [],
        externalSourceLinks: [],
        externalSourcePendingLinks: [],
        offlineSnapshot: { scopedLocalStorageValue: null, scopedIndexedDbRecord: null },
        dockSnapshot: { present: false, localStorage: null, indexedDb: null },
        launchSnapshot: { present: false, v1: null, v2: null },
        parkedTaskCache: { present: false, entries: [], syncMetadata: {} },
      },
      blackBox: {
        schemaVersion: 1,
        ownerUserId: OWNER_USER_ID,
        sourceDigest: SOURCE_DIGEST,
        before: [],
        target: [],
      },
      attachmentOutbox: [],
      actionQueue: { indexedDb: null, localStorage: null },
      retryQueue: { schemaVersion: 2, indexedDb: null, localStorage: null, restoredItems: [] },
      deadLetters: { indexedDb: null, localStorage: null },
      conflicts: { indexedDbRecords: null, fallbackLocalStorageEntries: {} },
      metadata: {
        projectCursors: [], lastSyncTime: null, replayLog: [], lastWriteExplain: null,
        taskTombstones: {}, connectionTombstones: [],
      },
    },
    rollbackErrors: [],
    ...overrides,
  };
}

function makeRecoveryOperations(): LocalBackupUiRestoreStageOperations {
  return {
    decodePreImage: vi.fn(decodeLocalBackupUiRestoreStageSnapshots),
    apply: vi.fn(async () => undefined),
    verifyApplied: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    verifyRolledBack: vi.fn(async () => undefined),
  };
}

function createQueueBackupFake(
  identity: () => QueueBackupPersonalRestoreIdentityV2,
) {
  let state: 'absent' | 'active' | 'terminal' = 'absent';
  let terminalReceipt: Record<string, unknown> | null = null;
  const terminalize = (outcome: 'finalized' | 'rolled-back' | 'abandoned-before-prepare') => {
    terminalReceipt = makeQueueBackupTerminalReceipt(identity(), outcome);
    state = 'terminal';
    return terminalReceipt;
  };
  return {
    seedForMarker(marker: LocalBackupUiRestoreMarker): void {
      terminalReceipt = null;
      if (marker.phase === 'finalizing'
        && (marker.state === 'completed' || marker.state === 'rolled-back')) {
        terminalize(marker.state === 'completed' ? 'finalized' : 'rolled-back');
      } else {
        state = marker.state === 'prepared' ? 'absent' : 'active';
      }
    },
    readPersonalRestoreIdentityState: vi.fn(async () => {
      if (state === 'absent') {
        return { status: 'absent-for-identity', identity: identity(), absenceProof: {} } as const;
      }
      if (state === 'active') {
        return {
          status: 'active',
          transition: { preparedReceipt: identity() } as never,
        } as const;
      }
      return { status: 'terminal', receipt: terminalReceipt as never } as const;
    }),
    applyPersonalBackupRestoreTransitionV2: vi.fn(async command => {
      if (command.kind === 'prepare') {
        state = 'active';
        return { status: 'prepared' as const };
      }
      const receipt = terminalize(command.kind === 'finalize' ? 'finalized' : 'rolled-back');
      return {
        status: command.kind === 'finalize' ? 'finalized' as const : 'rolled-back' as const,
        receipt: receipt as never,
      };
    }),
    abandonPersonalRestoreBeforePrepare: vi.fn(async () => ({
      status: 'abandoned-before-prepare' as const,
      receipt: terminalize('abandoned-before-prepare') as never,
    })),
    readPersonalRestoreProviderEvidence: vi.fn(async () => terminalReceipt
      ? makeQueueBackupProviderEvidence(identity(), terminalReceipt)
      : { status: 'REJECTED', reason: 'AUTH_UNAVAILABLE' } as const),
  };
}

function makeQueueBackupTerminalReceipt(
  identity: QueueBackupPersonalRestoreIdentityV2,
  outcome: 'finalized' | 'rolled-back' | 'abandoned-before-prepare',
): Record<string, unknown> {
  return {
    kind: 'queue-backup-personal-restore-receipt',
    schemaVersion: 2,
    ...identity,
    id: identity.receiptId,
    outcome,
    recordPresent: false,
    resultDigest: `sha256:${'c'.repeat(64)}`,
    completedAt: '2026-07-27T00:00:00.000Z',
  };
}

function makeQueueBackupProviderEvidence(
  identity: QueueBackupPersonalRestoreIdentityV2,
  receipt: Record<string, unknown>,
) {
  const catalog = {
    receipts: { [identity.receiptId]: receipt },
  };
  return {
    status: 'READABLE' as const,
    storage: 'READBACK_CONFIRMED' as const,
    identity,
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
  };
}

async function overwriteDurableMarker(marker: unknown): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('nanoflow-data-safety-restore-journal', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('test journal open failed'));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('restore_markers', 'readwrite');
      const store = transaction.objectStore('restore_markers');
      const request = store.get(`local-backup-ui-restore:${OWNER_USER_ID}`);
      request.onerror = () => reject(request.error ?? new Error('test marker read failed'));
      request.onsuccess = () => {
        const record = request.result as Record<string, unknown>;
        store.put({ ...record, marker });
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('test marker write failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('test marker write aborted'));
    });
  } finally {
    db.close();
  }
}

async function deleteDurableQuiescenceMarker(ownerUserId: string): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('nanoflow-data-safety-restore-journal', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('test journal open failed'));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('restore_markers', 'readwrite');
      transaction.objectStore('restore_markers')
        .delete(`local-backup-ui-restore-quiescence:${ownerUserId}`);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('test marker delete failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('test marker delete aborted'));
    });
  } finally {
    db.close();
  }
}
