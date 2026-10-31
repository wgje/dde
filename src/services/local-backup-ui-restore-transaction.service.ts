import { Injectable, inject } from '@angular/core';

import type { Project } from '../models';
import type { BackupData } from '../../supabase/functions/_shared/backup-utils';
import type {
  QueuedAction,
  QueueBackupPersonalRestoreIdentityV2,
} from './action-queue.types';
import { extractBackupActionQueueActions } from './action-queue-restore.helpers';
import {
  createLocalBackupUiRestoreJournal,
  startLocalBackupUiRestoreMarkerHeartbeat,
  type LocalBackupUiRestoreJournal,
  type LocalBackupUiRestoreMarkerHeartbeat,
} from './local-backup-ui-restore-journal';
import {
  LocalBackupUiRestorePreImageService,
  type CaptureLocalBackupUiRestorePreImageInput,
} from './local-backup-ui-restore-pre-image.service';
import {
  LOCAL_BACKUP_UI_RESTORE_MARKER_SCHEMA_VERSION,
  validateLocalBackupUiRestoreMarker,
  type LocalBackupUiRestoreMarker,
  type LocalBackupUiRestorePreImage,
  type LocalBackupUiRestoreSource,
} from './local-backup-ui-restore-types';
import {
  LocalBackupUiRestoreOwnershipLostError,
  runLocalBackupUiRestoreStartupRollbackProtocol,
  runLocalBackupUiRestoreStageProtocol,
  type LocalBackupUiRestoreFinalOutcome,
  type LocalBackupUiRestoreProtocolRuntime,
  type LocalBackupUiRestoreStageOperations,
  type LocalBackupUiRestoreStageProtocolResult,
} from './local-backup-ui-restore-stage-protocol';
import type { LocalBackupUiRestoreActionQueueParticipant } from './local-backup-ui-restore-stage.service';
import {
  localBackupUiRestoreWriterQuiescence,
  type LocalBackupUiRestoreQuiescenceMarker,
  type PreparedLocalBackupUiRestoreWriterQuiescence,
} from './local-backup-ui-restore-writer-quiescence.service';
import {
  abortLocalBackupUiRestoreTerminal,
  finalizeLocalBackupUiRestoreTerminal,
  isExactActiveQueueBackupState,
  settleAndVerifyLocalBackupUiRestoreQueueBackup,
  type LocalBackupUiRestoreQueueBackupPort,
  type LocalBackupUiRestoreTerminalState,
} from './local-backup-ui-restore-writer-quiescence-tracker';
import { QueueBackupService } from './queue-backup.service';
import { createQueueBackupPersonalRestoreIdentity } from './queue-backup-personal-restore-transition.helpers';
import {
  LocalBackupUiBlackBoxRestoreService,
  type PrepareLocalBackupUiBlackBoxRestoreInput,
} from './local-backup-ui-black-box-restore.service';
import type { LocalBackupUiBlackBoxRestoreSnapshot } from './local-backup-ui-black-box-restore.types';

export interface PrepareLocalBackupUiRestoreTransactionInput {
  ownerUserId: string;
  source: LocalBackupUiRestoreSource;
  touchedProjectIds: readonly string[];
  currentProjects: readonly Project[];
  retryQueueRestoreItems: readonly unknown[];
  restoredActionQueueItems: readonly QueuedAction[];
  blackBoxBackup: BackupData;
}

export interface PreparedLocalBackupUiRestoreTransaction {
  marker(): LocalBackupUiRestoreMarker;
  actionQueueRestore: LocalBackupUiRestoreActionQueueParticipant;
  verifyOwnership(): Promise<boolean>;
  run(operations: LocalBackupUiRestoreStageOperations): Promise<LocalBackupUiRestoreStageProtocolResult>;
  runStartupRollback(
    operations: LocalBackupUiRestoreStageOperations,
  ): Promise<LocalBackupUiRestoreStageProtocolResult>;
  finishFinalization(outcome: LocalBackupUiRestoreFinalOutcome): Promise<void>;
  abortBeforeMutation(): Promise<void>;
}

export interface LocalBackupUiRestoreTransactionDependencies {
  prepareQuiescence(ownerUserId: string): Promise<PreparedLocalBackupUiRestoreWriterQuiescence>;
  capturePreImage(input: CaptureLocalBackupUiRestorePreImageInput): Promise<LocalBackupUiRestorePreImage>;
  prepareBlackBox(input: PrepareLocalBackupUiBlackBoxRestoreInput): Promise<LocalBackupUiBlackBoxRestoreSnapshot>;
  createJournal(ownerUserId: string): LocalBackupUiRestoreJournal;
  startMarkerHeartbeat(
    journal: LocalBackupUiRestoreJournal,
    marker: LocalBackupUiRestoreMarker,
  ): LocalBackupUiRestoreMarkerHeartbeat;
  createRestoreRunId(): string;
  createRestoreToken(): string;
  createQueueBackupIdentity(
    input: Parameters<typeof createQueueBackupPersonalRestoreIdentity>[0],
  ): Promise<QueueBackupPersonalRestoreIdentityV2>;
  queueBackup: LocalBackupUiRestoreQueueBackupPort;
}

export interface TakeoverExpiredLocalBackupUiRestoreTransactionDependencies {
  createJournal(ownerUserId: string): LocalBackupUiRestoreJournal;
  takeoverQuiescence(
    expected: LocalBackupUiRestoreQuiescenceMarker,
    claimedMarker: LocalBackupUiRestoreMarker,
  ): Promise<PreparedLocalBackupUiRestoreWriterQuiescence>;
  startMarkerHeartbeat(
    journal: LocalBackupUiRestoreJournal,
    marker: LocalBackupUiRestoreMarker,
  ): LocalBackupUiRestoreMarkerHeartbeat;
  queueBackup: LocalBackupUiRestoreQueueBackupPort;
}

@Injectable({ providedIn: 'root' })
export class LocalBackupUiRestoreTransactionService {
  private readonly preImage = inject(LocalBackupUiRestorePreImageService);
  private readonly blackBoxRestore = inject(LocalBackupUiBlackBoxRestoreService);
  private readonly queueBackup = inject(QueueBackupService);

  prepare(
    input: PrepareLocalBackupUiRestoreTransactionInput,
  ): Promise<PreparedLocalBackupUiRestoreTransaction> {
    return prepareLocalBackupUiRestoreTransaction(input, {
      prepareQuiescence: ownerUserId => (
        localBackupUiRestoreWriterQuiescence.prepare(ownerUserId)
      ),
      capturePreImage: captureInput => this.preImage.capture(captureInput),
      prepareBlackBox: prepareInput => this.blackBoxRestore.prepare(prepareInput),
      createJournal: createLocalBackupUiRestoreJournal,
      startMarkerHeartbeat: startLocalBackupUiRestoreMarkerHeartbeat,
      createRestoreRunId: createRestoreIdentityValue,
      createRestoreToken: createRestoreIdentityValue,
      createQueueBackupIdentity: createQueueBackupPersonalRestoreIdentity,
      queueBackup: this.queueBackup,
    });
  }

  takeoverExpired(
    marker: LocalBackupUiRestoreMarker,
    quiescence: LocalBackupUiRestoreQuiescenceMarker,
  ): Promise<PreparedLocalBackupUiRestoreTransaction> {
    return takeoverExpiredLocalBackupUiRestoreTransaction(marker, quiescence, {
      createJournal: createLocalBackupUiRestoreJournal,
      takeoverQuiescence: (expected, claimedMarker) => (
        localBackupUiRestoreWriterQuiescence.takeoverExpired(expected, claimedMarker)
      ),
      startMarkerHeartbeat: startLocalBackupUiRestoreMarkerHeartbeat,
      queueBackup: this.queueBackup,
    });
  }
}

export async function prepareLocalBackupUiRestoreTransaction(
  input: PrepareLocalBackupUiRestoreTransactionInput,
  dependencies: LocalBackupUiRestoreTransactionDependencies,
): Promise<PreparedLocalBackupUiRestoreTransaction> {
  const touchedProjectIds = normalizeProjectIds(input.touchedProjectIds);
  const quiescence = await dependencies.prepareQuiescence(input.ownerUserId);
  let markerCreated = false;
  let markerHeartbeat: LocalBackupUiRestoreMarkerHeartbeat | null = null;
  let preparedHandle: PreparedLocalBackupUiRestoreTransaction | null = null;
  try {
    const capturedPreImage = await dependencies.capturePreImage({
      ownerUserId: input.ownerUserId,
      touchedProjectIds,
      currentProjects: input.currentProjects,
      retryQueueRestoreItems: input.retryQueueRestoreItems,
    });
    const blackBox = await dependencies.prepareBlackBox({
      ownerUserId: input.ownerUserId,
      sourceDigest: input.source.checksum,
      backup: input.blackBoxBackup,
    });
    const preImage: LocalBackupUiRestorePreImage = {
      ...capturedPreImage,
      blackBox: blackBox as unknown as LocalBackupUiRestorePreImage['blackBox'],
    };
    const queueIdentity = await createPreparedQueueIdentity(input, quiescence, dependencies);
    const marker = buildPreparedMarker(
      input,
      touchedProjectIds,
      preImage,
      quiescence,
      queueIdentity,
    );
    const journal = dependencies.createJournal(input.ownerUserId);
    await journal.create(marker);
    markerCreated = true;
    const readBack = await journal.read();
    if (!readBack || JSON.stringify(readBack) !== JSON.stringify(marker)) {
      throw new Error('local backup UI restore marker read-back verification failed');
    }
    if (!await journal.verifyOwnership(marker)) {
      throw new Error('local backup UI restore marker ownership lost');
    }
    markerHeartbeat = dependencies.startMarkerHeartbeat(journal, marker);
    if (!await markerHeartbeat.verifyOwnership()) {
      throw new Error('local backup UI restore marker heartbeat ownership lost');
    }
    preparedHandle = createPreparedHandle(
      quiescence,
      journal,
      markerHeartbeat,
      dependencies.startMarkerHeartbeat,
      dependencies.queueBackup,
      input.restoredActionQueueItems.length,
    );
    await quiescence.runMutation('action-queue', () => (
      prepareActionQueueRestore(input, preImage, queueIdentity, dependencies)
    ));
    return preparedHandle;
  } catch (error) {
    if (!markerCreated) {
      await quiescence.abortBeforeMutation();
    } else if (preparedHandle) {
      try {
        await preparedHandle.abortBeforeMutation();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'local backup UI restore prepare cleanup failed',
        );
      }
    } else if (markerHeartbeat) {
      await markerHeartbeat.stop();
    }
    throw error;
  }
}

export async function takeoverExpiredLocalBackupUiRestoreTransaction(
  marker: LocalBackupUiRestoreMarker,
  quiescence: LocalBackupUiRestoreQuiescenceMarker,
  dependencies: TakeoverExpiredLocalBackupUiRestoreTransactionDependencies,
): Promise<PreparedLocalBackupUiRestoreTransaction> {
  const journal = dependencies.createJournal(marker.ownerUserId);
  const claimedMarker = await journal.claimExpired(marker);
  if (!claimedMarker || !await journal.verifyOwnership(claimedMarker)) {
    throw new LocalBackupUiRestoreOwnershipLostError();
  }
  const readBack = await journal.read();
  if (!readBack || JSON.stringify(readBack) !== JSON.stringify(claimedMarker)) {
    throw new Error('local backup UI restore marker read-back verification failed');
  }
  const adoptedQuiescence = await dependencies.takeoverQuiescence(quiescence, claimedMarker);
  if (!hasSharedStartupRecoveryIdentity(claimedMarker, adoptedQuiescence.marker())) {
    throw new Error('local backup UI restore startup quiescence read-back verification failed');
  }
  const markerHeartbeat = dependencies.startMarkerHeartbeat(journal, claimedMarker);
  if (!await markerHeartbeat.verifyOwnership() || !await adoptedQuiescence.verifyOwnership()) {
    throw new LocalBackupUiRestoreOwnershipLostError();
  }
  return createPreparedHandle(
    adoptedQuiescence,
    journal,
    markerHeartbeat,
    dependencies.startMarkerHeartbeat,
    dependencies.queueBackup,
    0,
  );
}

function buildPreparedMarker(
  input: PrepareLocalBackupUiRestoreTransactionInput,
  touchedProjectIds: string[],
  preImage: LocalBackupUiRestorePreImage,
  quiescence: PreparedLocalBackupUiRestoreWriterQuiescence,
  actionQueueRestoreIdentity: QueueBackupPersonalRestoreIdentityV2,
): LocalBackupUiRestoreMarker {
  const identity = quiescence.marker();
  const marker: LocalBackupUiRestoreMarker = {
    schemaVersion: LOCAL_BACKUP_UI_RESTORE_MARKER_SCHEMA_VERSION,
    ownerUserId: identity.ownerUserId,
    runId: identity.runId,
    restoreRunId: actionQueueRestoreIdentity.restoreRunId,
    actionQueueRestoreIdentity,
    createdAt: identity.createdAt,
    leaseExpiresAt: identity.leaseExpiresAt,
    state: 'prepared',
    phase: 'pre-image-captured',
    completedStages: [],
    rollbackCompletedStages: [],
    source: input.source,
    touchedProjectIds,
    preImage,
    rollbackErrors: [],
  };
  if (identity.ownerUserId !== input.ownerUserId
    || !validateLocalBackupUiRestoreMarker(marker, input.ownerUserId)) {
    throw new Error('local backup UI restore prepared marker failed schema validation');
  }
  return marker;
}

async function createPreparedQueueIdentity(
  input: PrepareLocalBackupUiRestoreTransactionInput,
  quiescence: PreparedLocalBackupUiRestoreWriterQuiescence,
  dependencies: LocalBackupUiRestoreTransactionDependencies,
): Promise<QueueBackupPersonalRestoreIdentityV2> {
  const restoreRunId = dependencies.createRestoreRunId();
  const token = dependencies.createRestoreToken();
  if (!restoreRunId || !token || restoreRunId === quiescence.marker().runId) {
    throw new Error('local backup UI restore stable identity generation failed');
  }
  return await dependencies.createQueueBackupIdentity({
    ownerUserId: input.ownerUserId,
    restoreRunId,
    participant: 'action-queue',
    sourceDigest: input.source.checksum,
    token,
  });
}

async function prepareActionQueueRestore(
  input: PrepareLocalBackupUiRestoreTransactionInput,
  preImage: LocalBackupUiRestorePreImage,
  identity: QueueBackupPersonalRestoreIdentityV2,
  dependencies: LocalBackupUiRestoreTransactionDependencies,
): Promise<void> {
  const actionQueuePreImage = preImage.actionQueue;
  const indexedDb = actionQueuePreImage && typeof actionQueuePreImage === 'object'
    && !Array.isArray(actionQueuePreImage)
    ? actionQueuePreImage['indexedDb']
    : undefined;
  await dependencies.queueBackup.applyPersonalBackupRestoreTransitionV2({
    kind: 'prepare',
    identity,
    expectedActions: extractBackupActionQueueActions(indexedDb),
    restoredActions: [...input.restoredActionQueueItems],
  }, input.ownerUserId);
  const state = await dependencies.queueBackup.readPersonalRestoreIdentityState(
    identity,
    input.ownerUserId,
  );
  if (!isExactActiveQueueBackupState(state, identity)) {
    throw new Error('local backup UI restore queue prepare read-back verification failed');
  }
}

function createRestoreIdentityValue(): string {
  const value = globalThis.crypto?.randomUUID?.();
  if (!value) throw new Error('local backup UI restore identity generation is unavailable');
  return value;
}

function createPreparedHandle(
  quiescence: PreparedLocalBackupUiRestoreWriterQuiescence,
  journal: LocalBackupUiRestoreJournal,
  initialHeartbeat: LocalBackupUiRestoreMarkerHeartbeat,
  startMarkerHeartbeat: LocalBackupUiRestoreTransactionDependencies['startMarkerHeartbeat'],
  queueBackup: LocalBackupUiRestoreQueueBackupPort,
  restoredActionCount: number,
): PreparedLocalBackupUiRestoreTransaction {
  const state: PreparedRestoreHandleState = {
    closed: false,
    running: false,
    markerHeartbeat: initialHeartbeat,
  };
  const verifyOwnership = (): Promise<boolean> => verifyPreparedOwnership(state, quiescence);
  const terminalContext = { state, quiescence, journal, queueBackup, verifyOwnership };
  const abortBeforeMutation = (): Promise<void> => abortLocalBackupUiRestoreTerminal(terminalContext);
  const actionQueueRestore = createActionQueueParticipant(
    state,
    quiescence,
    queueBackup,
    restoredActionCount,
  );
  const runtime: LocalBackupUiRestoreProtocolRuntime = {
    marker: () => state.markerHeartbeat.marker(),
    verifyOwnership,
    transition: update => transitionPreparedMarker(state, journal, startMarkerHeartbeat, update),
    runWriterMutation: (source, write) => quiescence.runMutation(source, write),
    drainWriters: () => quiescence.drainWriters(),
    abortBeforeMutation,
    finalize: outcome => finalizeLocalBackupUiRestoreTerminal(terminalContext, outcome),
  };
  return {
    marker: () => state.markerHeartbeat.marker(),
    actionQueueRestore,
    verifyOwnership,
    run: async operations => {
      if (state.running || state.closed) {
        throw new Error('local backup UI restore prepared transaction is no longer runnable');
      }
      state.running = true;
      return await runLocalBackupUiRestoreStageProtocol(runtime, operations);
    },
    runStartupRollback: async operations => {
      if (state.running || state.closed) {
        throw new Error('local backup UI restore prepared transaction is no longer runnable');
      }
      state.running = true;
      return await runLocalBackupUiRestoreStartupRollbackProtocol(runtime, operations);
    },
    finishFinalization: async outcome => {
      if (state.running || state.closed) {
        throw new Error('local backup UI restore prepared transaction is no longer runnable');
      }
      await finalizeLocalBackupUiRestoreTerminal(terminalContext, outcome);
    },
    abortBeforeMutation,
  };
}

function createActionQueueParticipant(
  state: PreparedRestoreHandleState,
  quiescence: PreparedLocalBackupUiRestoreWriterQuiescence,
  queueBackup: LocalBackupUiRestoreQueueBackupPort,
  restoredActionCount: number,
): LocalBackupUiRestoreActionQueueParticipant {
  return {
    confirmPrepared: async () => {
      if (!await verifyPreparedOwnership(state, quiescence)) {
        throw new LocalBackupUiRestoreOwnershipLostError();
      }
      const marker = state.markerHeartbeat.marker();
      const queueState = await queueBackup.readPersonalRestoreIdentityState(
        marker.actionQueueRestoreIdentity,
        marker.ownerUserId,
      );
      if (!isExactActiveQueueBackupState(queueState, marker.actionQueueRestoreIdentity)) {
        throw new Error('local backup UI restore queue prepared evidence changed');
      }
      return restoredActionCount;
    },
    rollback: async () => {
      if (!await verifyPreparedOwnership(state, quiescence)) {
        throw new LocalBackupUiRestoreOwnershipLostError();
      }
      const marker = state.markerHeartbeat.marker();
      await settleAndVerifyLocalBackupUiRestoreQueueBackup(
        marker.actionQueueRestoreIdentity,
        marker.ownerUserId,
        queueBackup,
        'rolled-back',
      );
    },
  };
}

interface PreparedRestoreHandleState extends LocalBackupUiRestoreTerminalState {
  running: boolean;
}

async function verifyPreparedOwnership(
  state: PreparedRestoreHandleState,
  quiescence: PreparedLocalBackupUiRestoreWriterQuiescence,
): Promise<boolean> {
  if (state.closed || !await quiescence.verifyOwnership()) return false;
  return await state.markerHeartbeat.verifyOwnership();
}

async function transitionPreparedMarker(
  state: PreparedRestoreHandleState,
  journal: LocalBackupUiRestoreJournal,
  startMarkerHeartbeat: LocalBackupUiRestoreTransactionDependencies['startMarkerHeartbeat'],
  update: Parameters<LocalBackupUiRestoreProtocolRuntime['transition']>[0],
): Promise<LocalBackupUiRestoreMarker> {
  if (state.closed) throw new LocalBackupUiRestoreOwnershipLostError();
  await state.markerHeartbeat.stop();
  const expected = state.markerHeartbeat.marker();
  if (!await journal.verifyOwnership(expected)) {
    throw new LocalBackupUiRestoreOwnershipLostError();
  }
  const next = update(expected);
  if (!validateLocalBackupUiRestoreMarker(next, expected.ownerUserId)
    || next.runId !== expected.runId) {
    throw new LocalBackupUiRestoreOwnershipLostError('restore marker transition is invalid');
  }
  const replaced = await journal.replace(expected, next);
  if (!replaced) throw new LocalBackupUiRestoreOwnershipLostError();
  state.markerHeartbeat = startMarkerHeartbeat(journal, replaced);
  if (!await state.markerHeartbeat.verifyOwnership()) {
    throw new LocalBackupUiRestoreOwnershipLostError();
  }
  return state.markerHeartbeat.marker();
}

function normalizeProjectIds(projectIds: readonly string[]): string[] {
  if (projectIds.some(projectId => typeof projectId !== 'string' || projectId.length === 0)) {
    throw new Error('local backup UI restore touched project IDs are invalid');
  }
  const uniqueIds = new Set(projectIds);
  if (uniqueIds.size !== projectIds.length) {
    throw new Error('local backup UI restore touched project IDs must be unique');
  }
  return Array.from(uniqueIds).sort();
}

function hasSharedStartupRecoveryIdentity(
  marker: LocalBackupUiRestoreMarker,
  quiescence: LocalBackupUiRestoreQuiescenceMarker,
): boolean {
  return marker.ownerUserId === quiescence.ownerUserId
    && marker.runId === quiescence.runId
    && marker.createdAt === quiescence.createdAt
    && marker.leaseExpiresAt === quiescence.leaseExpiresAt;
}
