import { inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./sentry-lazy-loader.service.ts', () => ({
  SentryLazyLoaderService: class {
    captureException(): void {}
    captureMessage(): void {}
  },
}));
vi.mock('../environments/environment.ts', () => ({
  environment: { production: false },
}));

import type { Project } from '../models';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service.ts';
import { LoggerService } from './logger.service';
import { AttachmentUploadOutboxService, type PendingAttachmentUploadRecord } from './attachment-upload-outbox.service';
import { ProjectDataService, RetryQueueService } from '../core-bridge';
import {
  ProjectOfflineSnapshotService,
  type OfflineSnapshotWriteOptions,
} from '../app/core/services/sync/project-offline-snapshot.service';
import { IndexedDBService } from '../app/core/state/persistence/indexeddb.service';
import { SyncCursorPersistenceService } from '../app/core/state/persistence/sync-cursor-persistence.service';
import { ProjectStateService } from './project-state.service';
import { ExternalSourceCacheService } from '../app/core/external-sources/external-source-cache.service';
import { ImportService } from './import.service';
import { ActionQueueStorageService } from './action-queue-storage.service';
import { ConflictStorageService } from './conflict-storage.service';
import { BackupDataSafetyMetadataRestoreService } from './backup-data-safety-metadata-restore.service';
import { LocalBackupUiBlackBoxRestoreService } from './local-backup-ui-black-box-restore.service';
import type { LocalBackupUiBlackBoxRestoreSnapshot } from './local-backup-ui-black-box-restore.types';
import type { BackupData } from '../../supabase/functions/_shared/backup-utils';
import type { ExportData } from './export.service';
import type { QueueBackupPersonalRestoreIdentityV2 } from './action-queue.types';
import { QueueBackupService } from './queue-backup.service';
import { createQueueBackupPersonalRestoreIdentity } from './queue-backup-personal-restore-transition.helpers';
import {
  deleteDataSafetyRestoreMarkerJournalDatabaseForTests,
} from './data-safety-restore-marker-journal';
import { createLocalBackupUiRestoreJournal } from './local-backup-ui-restore-journal';
import type {
  LocalBackupUiRestoreJsonValue,
  LocalBackupUiRestoreMarker,
} from './local-backup-ui-restore-types';
import { LocalBackupUiRestoreStageService } from './local-backup-ui-restore-stage.service';
import { LocalBackupUiRestoreTransactionService } from './local-backup-ui-restore-transaction.service';
import { LocalBackupUiRestorePreImageService } from './local-backup-ui-restore-pre-image.service';
import { LocalBackupUiRestoreStartupRecoveryService } from './local-backup-ui-restore-startup-recovery.service';
import {
  LocalBackupUiRestoreWriterQuiescenceService,
  type PreparedLocalBackupUiRestoreWriterQuiescence,
} from './local-backup-ui-restore-writer-quiescence.service';
import {
  readOfflineSnapshotRestoreSnapshot,
  restoreOfflineSnapshotRestoreSnapshot,
} from './data-safety-offline-snapshot-restore.helpers';
import {
  CONNECTION_TOMBSTONES_STORAGE_KEY,
  TASK_TOMBSTONES_STORAGE_KEY,
  writeScopedConnectionTombstones,
  writeScopedTaskTombstones,
} from './data-safety-tombstone-storage.helpers';

const SOURCE_DIGEST = `sha256:${'a'.repeat(64)}`;
const RESTORE_RUN_ID = '11111111-1111-4111-8111-111111111111';
const RESTORE_TOKEN = '22222222-2222-4222-8222-222222222222';
const STARTED_AT = new Date('2026-01-01T00:00:00.000Z');

describe('local backup UI restore forward crash recovery', () => {
  afterEach(async () => {
    vi.clearAllTimers();
    vi.useRealTimers();
    TestBed.resetTestingModule();
    await deleteDataSafetyRestoreMarkerJournalDatabaseForTests();
  });

  it('recovers a durable attachment write cut before progress and rolls back its completed project prefix', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(STARTED_AT);

    const ownerUserId = `rst-a5-owner-${crypto.randomUUID()}`;
    const otherOwnerUserId = `rst-a5-other-${crypto.randomUUID()}`;
    const projectId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const connectedTaskId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    const beforeProject = makeProject(projectId, taskId, connectedTaskId, connectionId, 'before');
    const restoredProject = makeProject(projectId, taskId, connectedTaskId, connectionId, 'forward');
    const cursor = {
      updatedAt: STARTED_AT.toISOString(),
      entityType: 'task' as const,
      id: taskId,
    };
    const identity = await createQueueBackupPersonalRestoreIdentity({
      ownerUserId,
      restoreRunId: RESTORE_RUN_ID,
      participant: 'action-queue',
      sourceDigest: SOURCE_DIGEST,
      token: RESTORE_TOKEN,
    });
    const queueBackup = makeQueueBackupFake(identity);
    const taskTombstones = { [projectId]: { [crypto.randomUUID()]: STARTED_AT.getTime() } };
    const connectionTombstones = [{
      projectId,
      connectionId: crypto.randomUUID(),
      timestamp: STARTED_AT.getTime(),
    }];
    const originalTaskTombstones = localStorage.getItem(TASK_TOMBSTONES_STORAGE_KEY);
    const originalConnectionTombstones = localStorage.getItem(CONNECTION_TOMBSTONES_STORAGE_KEY);
    const originalOfflineSnapshot = await readOfflineSnapshotRestoreSnapshot(ownerUserId);
    const otherOwnerOfflineSnapshot = await readOfflineSnapshotRestoreSnapshot(otherOwnerUserId);
    let cursorPersistence: SyncCursorPersistenceService | null = null;

    try {
      configureHarness(makeProjectState([beforeProject]), restoredProject, queueBackup);
      const initialOfflineSnapshots = TestBed.inject(ProjectOfflineSnapshotService);
      cursorPersistence = TestBed.inject(SyncCursorPersistenceService);
      await cursorPersistence.commitProjectCursor(projectId, ownerUserId, cursor);
      writeScopedTaskTombstones(taskTombstones, new Set([projectId]));
      writeScopedConnectionTombstones(connectionTombstones, new Set([projectId]));
      await initialOfflineSnapshots.saveOfflineSnapshotAndWait([beforeProject], ownerUserId);

      const outbox = TestBed.inject(AttachmentUploadOutboxService);
      const beforeUpload = makeUpload(ownerUserId, 'before-upload', 'before-operation', 'before');
      const otherOwnerSentinel = makeUpload(otherOwnerUserId, 'other-owner-upload', 'other-owner-operation', 'sentinel');
      const forwardUpload = makeUpload(ownerUserId, 'forward-upload', 'forward-operation', 'forward');
      await outbox.savePendingUpload(beforeUpload);
      await outbox.savePendingUpload(otherOwnerSentinel);

      const ownerPreImage = await outbox.listPendingUploads(ownerUserId, { restoreSnapshot: true });
      const projectPreImage = await readOfflineSnapshotRestoreSnapshot(ownerUserId);
      const quiescenceService = new LocalBackupUiRestoreWriterQuiescenceService({
        leaseMs: 1_000,
        pollIntervalMs: 1,
      });
      const preparedQuiescence = await quiescenceService.prepare(ownerUserId);
      const quiescenceMarker = preparedQuiescence.marker();
      const journal = createLocalBackupUiRestoreJournal(ownerUserId);
      const attachmentPreImage = await Promise.all(ownerPreImage.map(toBackupUpload));
      let marker = makeMarker({
        ownerUserId,
        projectId,
        beforeProject,
        projectPreImage,
        ownerPreImage,
        quiescence: quiescenceMarker,
        identity,
        cursor,
        taskTombstones,
        connectionTombstones,
      }, attachmentPreImage);
      queueBackup.seedForMarker();
      await journal.create(marker);
      await expect(journal.read()).resolves.toEqual(marker);

      const backup = makeBackup(ownerUserId, await toBackupUpload(forwardUpload));
      const stageService = TestBed.inject(LocalBackupUiRestoreStageService);
      const actionQueueRestore = {
        confirmPrepared: vi.fn(async () => 0),
        rollback: vi.fn(async () => undefined),
      };
      const operations = stageService.createOperations({
        ownerUserId,
        data: {} as ExportData,
        backup,
        existingProjects: [beforeProject],
        actionQueueRestore,
      });
      const context = {
        marker: () => marker,
        checkpoint: async () => {
          if (!await preparedQuiescence.verifyOwnership()
            || !await journal.verifyOwnership(marker)) {
            throw new Error('test restore transaction ownership lost');
          }
        },
        runWriterMutation: <T>(
          source: Parameters<PreparedLocalBackupUiRestoreWriterQuiescence['runMutation']>[0],
          write: () => Promise<T>,
        ) => preparedQuiescence.runMutation(source, write),
      };

      operations.decodePreImage(marker);
      await operations.apply('projects', context);
      await operations.verifyApplied('projects', context);

      const markerAfterProjects: LocalBackupUiRestoreMarker = {
        ...marker,
        phase: 'attachment-outbox',
        completedStages: ['projects'],
      };
      const projectProgress = await journal.replace(marker, markerAfterProjects);
      if (!projectProgress) throw new Error('could not persist projects prefix progress');
      marker = projectProgress;

      await operations.apply('attachment-outbox', context);
      await operations.verifyApplied('attachment-outbox', context);

      const cutMarker = await journal.read();
      expect(cutMarker).toMatchObject({
        state: 'restoring',
        phase: 'attachment-outbox',
        completedStages: ['projects'],
      });
      expect(await readUploadProjection(new AttachmentUploadOutboxService(), ownerUserId))
        .toEqual(expect.arrayContaining(await Promise.all([
          uploadProjection(beforeUpload),
          uploadProjection(forwardUpload),
        ])));
      expect(await readUploadProjection(new AttachmentUploadOutboxService(), otherOwnerUserId))
        .toEqual([await uploadProjection(otherOwnerSentinel)]);

      const rawSnapshotAtCut = await readOfflineSnapshotRestoreSnapshot(ownerUserId);
      const rawSnapshotPayloads = [
        rawSnapshotAtCut.scopedLocalStorageValue,
        rawSnapshotAtCut.scopedIndexedDbRecord?.['data'],
      ].filter((value): value is string => typeof value === 'string');
      expect(rawSnapshotPayloads.length).toBeGreaterThan(0);
      for (const payload of rawSnapshotPayloads) {
        const envelope = JSON.parse(payload) as Record<string, unknown>;
        expect(envelope['ownerUserId']).toBe(ownerUserId);
        expect(envelope['projects']).toEqual([restoredProject]);
      }
      const sameServiceSnapshot = await initialOfflineSnapshots.loadStartupOfflineSnapshot({ ownerUserId });
      expect(sameServiceSnapshot.projects).toEqual([restoredProject]);

      vi.clearAllTimers();
      const quiescenceEvidence = await quiescenceService.readStartupRecoveryEvidence(ownerUserId);
      if (!cutMarker || !quiescenceEvidence) throw new Error('durable crash-cut evidence missing');
      const freshQueueBackup = makeQueueBackupFake(identity);
      freshQueueBackup.seedForMarker();
      vi.setSystemTime(new Date(Math.max(
        Date.parse(cutMarker.leaseExpiresAt),
        Date.parse(quiescenceEvidence.leaseExpiresAt),
      ) + 1));

      TestBed.resetTestingModule();
      const freshProjectState = makeProjectState([]);
      configureHarness(freshProjectState, restoredProject, freshQueueBackup);
      const freshOfflineSnapshots = TestBed.inject(ProjectOfflineSnapshotService);
      const hydrated = await freshOfflineSnapshots.loadStartupOfflineSnapshot({ ownerUserId });
      expect(hydrated.projects).toEqual([restoredProject]);
      freshProjectState.setProjects(hydrated.projects);

      const freshStageService = TestBed.inject(LocalBackupUiRestoreStageService);
      const rollbackOrder: string[] = [];
      const createRecoveryOperations = freshStageService.createRecoveryOperations.bind(freshStageService);
      vi.spyOn(freshStageService, 'createRecoveryOperations').mockImplementation((recoveryOwner, participant) => {
        const recoveryOperations = createRecoveryOperations(recoveryOwner, participant);
        const rollback = recoveryOperations.rollback.bind(recoveryOperations);
        recoveryOperations.rollback = async (stage, operationContext) => {
          rollbackOrder.push(stage);
          await rollback(stage, operationContext);
        };
        return recoveryOperations;
      });
      const recovery = TestBed.inject(LocalBackupUiRestoreStartupRecoveryService);
      await expect(recovery.recover(ownerUserId)).resolves.toEqual({ status: 'recovered' });

      expect(rollbackOrder).toEqual(['attachment-outbox', 'projects']);
      const recoveredOutbox = new AttachmentUploadOutboxService();
      expect(await readUploadProjection(recoveredOutbox, ownerUserId))
        .toEqual([await uploadProjection(beforeUpload)]);
      expect(await readUploadProjection(recoveredOutbox, otherOwnerUserId))
        .toEqual([await uploadProjection(otherOwnerSentinel)]);

      const recoveredSnapshot = await freshOfflineSnapshots.loadStartupOfflineSnapshot({ ownerUserId });
      expect(recoveredSnapshot.projects).toEqual([beforeProject]);
      expect(freshProjectState.getProjectsWithCurrentData()).toEqual([beforeProject]);
      expect(await TestBed.inject(SyncCursorPersistenceService).loadProjectCursor(projectId, ownerUserId))
        .toEqual(cursor);
      expect(JSON.parse(localStorage.getItem(TASK_TOMBSTONES_STORAGE_KEY) ?? '{}')[projectId])
        .toEqual(taskTombstones[projectId]);
      expect((JSON.parse(localStorage.getItem(CONNECTION_TOMBSTONES_STORAGE_KEY) ?? '[]') as Array<Record<string, unknown>>)
        .filter(row => row['projectId'] === projectId))
        .toEqual(connectionTombstones.map(row => ({
          projectId: row.projectId,
          id: row.connectionId,
          connectionId: row.connectionId,
          timestamp: row.timestamp,
        })));

      const freshJournal = createLocalBackupUiRestoreJournal(ownerUserId);
      const freshQuiescence = new LocalBackupUiRestoreWriterQuiescenceService();
      await expect(freshJournal.read()).resolves.toBeNull();
      await expect(freshQuiescence.readStartupRecoveryEvidence(ownerUserId)).resolves.toBeNull();
    } finally {
      vi.clearAllTimers();
      const cleanupOutbox = new AttachmentUploadOutboxService();
      await cleanupOutbox.clearPendingUploadsForTests();
      if (cursorPersistence) await cursorPersistence.clearProjectCursor(projectId, ownerUserId);
      if (originalOfflineSnapshot.scopedLocalStorageValue !== null
        || originalOfflineSnapshot.scopedIndexedDbRecord !== null) {
        await restoreOfflineSnapshotRestoreSnapshot(ownerUserId, originalOfflineSnapshot);
      } else {
        await restoreOfflineSnapshotRestoreSnapshot(ownerUserId, originalOfflineSnapshot);
      }
      await restoreOfflineSnapshotRestoreSnapshot(otherOwnerUserId, otherOwnerOfflineSnapshot);
      restoreRawStorage(TASK_TOMBSTONES_STORAGE_KEY, originalTaskTombstones);
      restoreRawStorage(CONNECTION_TOMBSTONES_STORAGE_KEY, originalConnectionTombstones);
      vi.useRealTimers();
      TestBed.resetTestingModule();
      await deleteDataSafetyRestoreMarkerJournalDatabaseForTests();
    }
  });
});

function configureHarness(
  projectState: ReturnType<typeof makeProjectState>,
  restoredProject: Project,
  queueBackup: ReturnType<typeof makeQueueBackupFake>,
): void {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [
      LocalBackupUiRestoreStageService,
      LocalBackupUiRestoreTransactionService,
      LocalBackupUiRestoreStartupRecoveryService,
      ProjectOfflineSnapshotService,
      AttachmentUploadOutboxService,
      IndexedDBService,
      SyncCursorPersistenceService,
      { provide: LoggerService, useValue: { category: vi.fn(() => logger) } },
      { provide: SentryLazyLoaderService, useValue: { captureException: vi.fn(), captureMessage: vi.fn() } },
      {
        provide: ProjectDataService,
        useFactory: () => {
          const offlineSnapshots = inject(ProjectOfflineSnapshotService);
          return {
            saveOfflineSnapshotAndWait: (
              projects: Project[],
              ownerUserId: string,
              options?: OfflineSnapshotWriteOptions,
            ) => (
              offlineSnapshots.saveOfflineSnapshotAndWait(projects, ownerUserId, options)
            ),
          };
        },
      },
      { provide: ProjectStateService, useValue: projectState },
      {
        provide: ImportService,
        useValue: {
          prepareLocalBackupRestorePlan: vi.fn(async () => ({
            importedCount: 1,
            projects: [restoredProject],
            externalSourceLinks: [],
          })),
        },
      },
      { provide: ExternalSourceCacheService, useValue: makeExternalSourceCache() },
      { provide: RetryQueueService, useValue: { MAX_RETRIES: 50, restoreFromBackupItems: vi.fn(async () => 0) } },
      { provide: ActionQueueStorageService, useValue: {} },
      { provide: ConflictStorageService, useValue: { saveConflict: vi.fn(async () => true) } },
      { provide: BackupDataSafetyMetadataRestoreService, useValue: {} },
      { provide: LocalBackupUiBlackBoxRestoreService, useValue: makeBlackBoxRestore() },
      { provide: LocalBackupUiRestorePreImageService, useValue: { capture: vi.fn() } },
      { provide: QueueBackupService, useValue: queueBackup },
    ],
  });
}

function makeProjectState(initial: Project[]) {
  let projects = structuredClone(initial);
  return {
    getProjectsWithCurrentData: () => structuredClone(projects),
    updateProjects: (update: () => Project[]) => { projects = update(); },
    setProjects: (next: Project[]) => { projects = structuredClone(next); },
  };
}

function makeExternalSourceCache() {
  const linksByOwner = new Map<string, unknown[]>();
  const pendingByOwner = new Map<string, unknown[]>();
  return {
    loadLinks: vi.fn(async (ownerUserId: string) => structuredClone(linksByOwner.get(ownerUserId) ?? [])),
    loadPendingLinks: vi.fn(async (ownerUserId: string) => structuredClone(pendingByOwner.get(ownerUserId) ?? [])),
    saveLinks: vi.fn(async (links: unknown[], ownerUserId: string) => {
      linksByOwner.set(ownerUserId, structuredClone(links));
    }),
    replacePendingLinksForOwner: vi.fn(async (links: unknown[], ownerUserId: string) => {
      pendingByOwner.set(ownerUserId, structuredClone(links));
    }),
  };
}

function makeBlackBoxRestore() {
  return {
    decode: vi.fn((value: unknown) => value as LocalBackupUiBlackBoxRestoreSnapshot),
    apply: vi.fn(async () => 0),
    read: vi.fn(async () => []),
    rollback: vi.fn(async () => undefined),
  };
}

function makeQueueBackupFake(identity: QueueBackupPersonalRestoreIdentityV2) {
  let state: 'active' | 'terminal' = 'active';
  let receipt: Record<string, unknown> | null = null;
  const makeReceipt = (outcome: 'rolled-back' | 'finalized') => ({
    kind: 'queue-backup-personal-restore-receipt',
    schemaVersion: 2,
    ...identity,
    id: identity.receiptId,
    outcome,
    recordPresent: false,
    resultDigest: `sha256:${'c'.repeat(64)}`,
    completedAt: STARTED_AT.toISOString(),
  });
  const terminalEvidence = () => {
    if (!receipt) return { status: 'REJECTED' as const, reason: 'AUTH_UNAVAILABLE' as const };
    return {
      status: 'READABLE' as const,
      storage: 'READBACK_CONFIRMED' as const,
      identity,
      queue: { status: 'ABSENT' as const },
      deadLetters: { status: 'ABSENT' as const },
      catalog: {
        status: 'PRESENT_VALID' as const,
        value: { receipts: { [identity.receiptId]: receipt } },
        rawSignature: 'catalog',
      },
      receipt: { status: 'PRESENT_VALID' as const, value: receipt, rawSignature: 'receipt' },
      terminal: {
        status: 'TERMINAL_CONFIRMED' as const,
        receipt,
        resultDigest: receipt['resultDigest'] as string,
        recordPresent: false,
      },
      snapshotSignature: 'snapshot',
    };
  };
  return {
    seedForMarker: vi.fn(() => { state = 'active'; receipt = null; }),
    readPersonalRestoreIdentityState: vi.fn(async () => state === 'active'
      ? { status: 'active' as const, transition: { preparedReceipt: identity } as never }
      : { status: 'terminal' as const, receipt: receipt as never }),
    applyPersonalBackupRestoreTransitionV2: vi.fn(async (command: { kind: string }) => {
      if (command.kind === 'prepare') {
        state = 'active';
        return { status: 'prepared' as const };
      }
      state = 'terminal';
      receipt = makeReceipt(command.kind === 'finalize' ? 'finalized' : 'rolled-back');
      return {
        status: command.kind === 'finalize' ? 'finalized' as const : 'rolled-back' as const,
        receipt: receipt as never,
      };
    }),
    abandonPersonalRestoreBeforePrepare: vi.fn(async () => {
      state = 'terminal';
      receipt = {
        ...makeReceipt('rolled-back'),
        outcome: 'abandoned-before-prepare',
      };
      return { status: 'abandoned-before-prepare' as const, receipt: receipt as never };
    }),
    readPersonalRestoreProviderEvidence: vi.fn(async () => terminalEvidence()),
  };
}

function makeProject(
  projectId: string,
  taskId: string,
  connectedTaskId: string,
  connectionId: string,
  label: string,
): Project {
  return {
    id: projectId,
    name: label,
    description: '',
    createdDate: STARTED_AT.toISOString(),
    updatedAt: STARTED_AT.toISOString(),
    tasks: [{
      id: taskId,
      title: 'Stable task identity',
      content: `${label} content`,
      stage: null,
      parentId: null,
      order: 0,
      rank: 0,
      status: 'active',
      displayId: taskId,
      x: 0,
      y: 0,
      createdDate: STARTED_AT.toISOString(),
    }, {
      id: connectedTaskId,
      title: 'Stable connected task identity',
      content: `${label} connected content`,
      stage: null,
      parentId: null,
      order: 1,
      rank: 1,
      status: 'active',
      displayId: connectedTaskId,
      x: 0,
      y: 0,
      createdDate: STARTED_AT.toISOString(),
    }],
    connections: [{ id: connectionId, source: taskId, target: connectedTaskId }],
  };
}

function makeUpload(
  ownerUserId: string,
  blobKey: string,
  operationId: string,
  content: string,
): PendingAttachmentUploadRecord {
  const blob = new Blob([content], { type: 'text/plain' });
  return {
    ownerUserId,
    operationId,
    attachmentId: `attachment-${blobKey}`,
    blobKey,
    fileName: `${blobKey}.txt`,
    mimeType: 'text/plain',
    size: blob.size,
    blob,
    createdAt: STARTED_AT.toISOString(),
  };
}

async function readUploadProjection(
  service: AttachmentUploadOutboxService,
  ownerUserId: string,
): Promise<Array<Record<string, unknown>>> {
  const records = await service.listPendingUploads(ownerUserId, { restoreSnapshot: true });
  return Promise.all(records.map(uploadProjection));
}

async function uploadProjection(upload: PendingAttachmentUploadRecord): Promise<Record<string, unknown>> {
  return {
    ownerUserId: upload.ownerUserId,
    operationId: upload.operationId,
    attachmentId: upload.attachmentId,
    blobKey: upload.blobKey,
    fileName: upload.fileName,
    mimeType: upload.mimeType,
    size: upload.size,
    createdAt: upload.createdAt,
    blobText: await upload.blob.text(),
  };
}

async function toBackupUpload(
  upload: PendingAttachmentUploadRecord,
): Promise<Record<string, LocalBackupUiRestoreJsonValue>> {
  const bytes = new Uint8Array(await upload.blob.arrayBuffer());
  const encoded = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
  return {
    ownerUserId: upload.ownerUserId,
    operationId: upload.operationId,
    attachmentId: upload.attachmentId,
    blobKey: upload.blobKey,
    fileName: upload.fileName,
    mimeType: upload.mimeType,
    size: upload.size,
    createdAt: upload.createdAt,
    encoding: 'base64',
    blobBase64: encoded,
  };
}

function makeBackup(ownerUserId: string, upload: Record<string, unknown>): BackupData {
  return {
    version: '2.0.0',
    payloadVersion: '2.0.0',
    type: 'full',
    createdAt: STARTED_AT.toISOString(),
    tableCounts: {},
    coverage: {},
    projects: [],
    tasks: [],
    connections: [],
    userPreferences: [],
    blackBoxEntries: [],
    focusSessions: [],
    transcriptionUsage: [],
    routineTasks: [],
    routineCompletions: [],
    localState: {
      dataSafety: {
        schemaVersion: '1.0.0',
        exportedAt: STARTED_AT.toISOString(),
        ownerUserId,
      },
      attachmentUploadOutbox: [upload],
      dockSnapshot: { localStorage: null, indexedDb: null },
      launchSnapshot: { v1: null, v2: null },
      parkedTaskCache: { entries: [], syncMetadata: {} },
    },
  } as unknown as BackupData;
}

function makeMarker(input: {
  ownerUserId: string;
  projectId: string;
  beforeProject: Project;
  projectPreImage: Awaited<ReturnType<typeof readOfflineSnapshotRestoreSnapshot>>;
  ownerPreImage: PendingAttachmentUploadRecord[];
  quiescence: { runId: string; createdAt: string; leaseExpiresAt: string };
  identity: QueueBackupPersonalRestoreIdentityV2;
  cursor: { updatedAt: string; entityType: 'task'; id: string };
  taskTombstones: Record<string, Record<string, number>>;
  connectionTombstones: Array<{ projectId: string; connectionId: string; timestamp: number }>;
}, attachmentPreImage: LocalBackupUiRestoreJsonValue[]): LocalBackupUiRestoreMarker {
  return {
    schemaVersion: 2,
    ownerUserId: input.ownerUserId,
    runId: input.quiescence.runId,
    restoreRunId: RESTORE_RUN_ID,
    actionQueueRestoreIdentity: input.identity,
    createdAt: input.quiescence.createdAt,
    leaseExpiresAt: input.quiescence.leaseExpiresAt,
    state: 'restoring',
    phase: 'projects',
    completedStages: [],
    rollbackCompletedStages: [],
    source: { kind: 'local-file', reference: 'rst-a5-crash-cut.json', checksum: SOURCE_DIGEST },
    touchedProjectIds: [input.projectId],
    preImage: {
      projectState: {
        schemaVersion: 1,
        projects: [{
          projectId: input.projectId,
          existed: true,
          project: asRestoreJsonValue(input.beforeProject),
        }],
        externalSourceLinks: [],
        externalSourcePendingLinks: [],
        offlineSnapshot: asRestoreJsonValue(input.projectPreImage),
        dockSnapshot: { present: false, localStorage: null, indexedDb: null },
        launchSnapshot: { present: false, v1: null, v2: null },
        parkedTaskCache: { present: false, entries: [], syncMetadata: {} },
      },
      blackBox: {
        schemaVersion: 1,
        ownerUserId: input.ownerUserId,
        sourceDigest: SOURCE_DIGEST,
        before: [],
        target: [],
      },
      attachmentOutbox: attachmentPreImage,
      actionQueue: { indexedDb: null, localStorage: null },
      retryQueue: { schemaVersion: 2, indexedDb: null, localStorage: null, restoredItems: [] },
      deadLetters: { indexedDb: null, localStorage: null },
      conflicts: { indexedDbRecords: null, fallbackLocalStorageEntries: {} },
      metadata: {
        projectCursors: [{
          projectId: input.projectId,
          userId: input.ownerUserId,
          cursor: input.cursor,
        }],
        lastSyncTime: STARTED_AT.toISOString(),
        replayLog: [],
        lastWriteExplain: null,
        taskTombstones: input.taskTombstones,
        connectionTombstones: input.connectionTombstones,
      },
    },
    rollbackErrors: [],
  };
}

function asRestoreJsonValue(value: unknown): LocalBackupUiRestoreJsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('restore fixture value is not JSON serializable');
  return JSON.parse(serialized) as LocalBackupUiRestoreJsonValue;
}

function restoreRawStorage(key: string, value: string | null): void {
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}
