import { describe, expect, it, vi } from 'vitest';

import {
  LocalBackupUiRestoreOwnershipLostError,
  runLocalBackupUiRestoreStartupRollbackProtocol,
  runLocalBackupUiRestoreStageProtocol,
  type LocalBackupUiRestoreProtocolRuntime,
  type LocalBackupUiRestoreStageOperations,
} from './local-backup-ui-restore-stage-protocol';
import type {
  LocalBackupUiRestoreMarker,
  LocalBackupUiRestoreStage,
} from './local-backup-ui-restore-types';
import { LOCAL_BACKUP_UI_RESTORE_STAGES } from './local-backup-ui-restore-types';

const RESTORE_RUN_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_DIGEST = `sha256:${'a'.repeat(64)}`;
const ACTION_QUEUE_RESTORE_IDENTITY = {
  ownerUserId: 'owner-1',
  restoreRunId: RESTORE_RUN_ID,
  participant: 'action-queue' as const,
  sourceDigest: SOURCE_DIGEST,
  token: '22222222-2222-4222-8222-222222222222',
  recordId: 'queue-backup:owner-1',
  identityDigest: `sha256:${'b'.repeat(64)}`,
  receiptId: `queue-backup-personal-restore-receipt:v2:${'b'.repeat(64)}`,
};

describe('local backup UI restore stage protocol', () => {
  it('records a stage only after durable mutation, drain, and read-back verification', async () => {
    const context = createContext();

    const result = await runLocalBackupUiRestoreStageProtocol(context.runtime, context.operations);

    expect(result.status).toBe('completed');
    expect(context.order.slice(0, 9)).toEqual([
      'decode',
      'verify',
      'transition:restoring:projects:',
      'verify',
      'apply:projects',
      'verify',
      'drain',
      'verify',
      'read-back:projects',
    ]);
    expect(context.order).toContain('transition:restoring:projects:projects');
    expect(context.runtime.marker().completedStages).toEqual([
      'projects',
      'attachment-outbox',
      'action-queue',
      'retry-queue',
      'dead-letters',
      'conflicts',
      'metadata',
    ]);
    expect(context.order.slice(-2)).toEqual(['transition:completed:finalizing:metadata', 'finalize:completed']);
  });

  it.each(LOCAL_BACKUP_UI_RESTORE_STAGES)(
    'rolls back the failed %s stage and all completed stages in reverse order',
    async failedStage => {
      const context = createContext(failedStage);
      const failedStageIndex = LOCAL_BACKUP_UI_RESTORE_STAGES.indexOf(failedStage);
      const expectedRollbackStages = LOCAL_BACKUP_UI_RESTORE_STAGES
        .slice(0, failedStageIndex + 1)
        .reverse();

      const result = await runLocalBackupUiRestoreStageProtocol(
        context.runtime,
        context.operations,
      );

      expect(result.status).toBe('rolled-back');
      expect(vi.mocked(context.operations.apply).mock.calls.map(([stage]) => stage)).toEqual(
        LOCAL_BACKUP_UI_RESTORE_STAGES.slice(0, failedStageIndex + 1),
      );
      expect(context.order.filter(entry => entry.startsWith('rollback:'))).toEqual(
        expectedRollbackStages.map(stage => `rollback:${stage}`),
      );
      expect(context.runtime.marker().rollbackCompletedStages).toEqual(expectedRollbackStages);
      expect(context.order.at(-1)).toBe('finalize:rolled-back');
    },
  );

  it('records rollback failure and retains the frozen transaction without finalizing', async () => {
    const context = createContext('retry-queue');
    context.operations.rollback = vi.fn(async stage => {
      context.order.push(`rollback:${stage}`);
      if (stage === 'action-queue') throw new Error('action queue compensation failed');
    });

    const result = await runLocalBackupUiRestoreStageProtocol(context.runtime, context.operations);

    expect(result).toMatchObject({ status: 'blocked', dataState: 'partial' });
    expect(context.runtime.marker()).toMatchObject({
      state: 'rollback-failed',
      phase: 'action-queue',
      rollbackErrors: [expect.objectContaining({
        stage: 'action-queue',
        message: 'action queue compensation failed',
      })],
    });
    expect(context.order.filter(entry => entry.startsWith('rollback:'))).toEqual([
      'rollback:retry-queue',
      'rollback:action-queue',
    ]);
    expect(context.runtime.finalize).not.toHaveBeenCalled();
  });

  it('retains completed finalization evidence without rolling back when terminal cleanup fails', async () => {
    const context = createContext();
    context.runtime.finalize = vi.fn(async () => {
      context.order.push('finalize:completed');
      throw new Error('terminal cleanup failed');
    });

    const result = await runLocalBackupUiRestoreStageProtocol(context.runtime, context.operations);

    expect(result).toMatchObject({ status: 'blocked', ownershipLost: false, dataState: 'completed' });
    expect(context.runtime.marker()).toMatchObject({ state: 'completed', phase: 'finalizing' });
    expect(context.operations.rollback).not.toHaveBeenCalled();
    expect(context.runtime.finalize).toHaveBeenCalledTimes(1);
  });

  it('retains rolled-back finalization evidence when terminal cleanup fails', async () => {
    const context = createContext('attachment-outbox');
    context.runtime.finalize = vi.fn(async () => {
      context.order.push('finalize:rolled-back');
      throw new Error('terminal cleanup failed');
    });

    const result = await runLocalBackupUiRestoreStageProtocol(context.runtime, context.operations);

    expect(result).toMatchObject({ status: 'blocked', ownershipLost: false, dataState: 'rolled-back' });
    expect(context.runtime.marker()).toMatchObject({
      state: 'rolled-back',
      phase: 'finalizing',
      rollbackErrors: [],
    });
    expect(context.runtime.marker().rollbackCompletedStages).toEqual([
      'attachment-outbox',
      'projects',
    ]);
    expect(context.runtime.finalize).toHaveBeenCalledTimes(1);
  });

  it('stops on ownership loss without rolling back, clearing, or reopening writers', async () => {
    const context = createContext();
    context.operations.apply = vi.fn(async stage => {
      context.order.push(`apply:${stage}`);
      throw new LocalBackupUiRestoreOwnershipLostError();
    });

    const result = await runLocalBackupUiRestoreStageProtocol(context.runtime, context.operations);

    expect(result).toMatchObject({ status: 'blocked', ownershipLost: true });
    expect(context.operations.rollback).not.toHaveBeenCalled();
    expect(context.runtime.finalize).not.toHaveBeenCalled();
    expect(context.runtime.abortBeforeMutation).not.toHaveBeenCalled();
  });

  it('retains the journal and blocks when a pre-image slot fails decoding', async () => {
    const context = createContext();
    context.operations.decodePreImage = vi.fn(() => {
      throw new Error('metadata slot malformed');
    });

    const result = await runLocalBackupUiRestoreStageProtocol(
      context.runtime,
      context.operations,
    );

    expect(result).toMatchObject({
      status: 'blocked',
      ownershipLost: false,
      dataState: 'partial',
      error: expect.objectContaining({ message: 'metadata slot malformed' }),
    });
    expect(context.runtime.marker()).toMatchObject({
      state: 'prepared',
      phase: 'pre-image-captured',
    });
    expect(context.runtime.abortBeforeMutation).not.toHaveBeenCalled();
    expect(context.operations.apply).not.toHaveBeenCalled();
    expect(context.runtime.finalize).not.toHaveBeenCalled();
  });

  it('retains a partial journal when startup pre-image decoding fails', async () => {
    const initialMarker = createMarker({
      state: 'rollback-failed',
      phase: 'action-queue',
      completedStages: ['projects', 'attachment-outbox', 'action-queue'],
      rollbackCompletedStages: ['action-queue'],
    });
    const context = createContext(undefined, initialMarker);
    context.operations.decodePreImage = vi.fn(() => {
      throw new Error('pre-image evidence changed');
    });

    const result = await runLocalBackupUiRestoreStartupRollbackProtocol(
      context.runtime,
      context.operations,
    );

    expect(result).toMatchObject({
      status: 'blocked',
      ownershipLost: false,
      dataState: 'partial',
      error: expect.objectContaining({ message: 'pre-image evidence changed' }),
    });
    expect(context.runtime.marker()).toEqual(initialMarker);
    expect(context.runtime.abortBeforeMutation).not.toHaveBeenCalled();
    expect(context.operations.rollback).not.toHaveBeenCalled();
    expect(context.runtime.finalize).not.toHaveBeenCalled();
  });

  it('startup rollback skips stages already confirmed in rollbackCompletedStages', async () => {
    const context = createContext(undefined, createMarker({
      state: 'rollback-failed',
      phase: 'action-queue',
      completedStages: ['projects', 'attachment-outbox', 'action-queue'],
      rollbackCompletedStages: ['action-queue'],
    }));

    const result = await runLocalBackupUiRestoreStartupRollbackProtocol(
      context.runtime,
      context.operations,
    );

    expect(result.status).toBe('rolled-back');
    expect(context.operations.apply).not.toHaveBeenCalled();
    expect(context.order.filter(entry => entry.startsWith('rollback:'))).toEqual([
      'rollback:attachment-outbox',
      'rollback:projects',
    ]);
    expect(context.runtime.marker().rollbackCompletedStages).toEqual([
      'action-queue',
      'attachment-outbox',
      'projects',
    ]);
    expect(context.order.at(-1)).toBe('finalize:rolled-back');
  });
});

function createContext(
  failStage?: LocalBackupUiRestoreStage,
  initialMarker: LocalBackupUiRestoreMarker = createMarker(),
): {
  order: string[];
  runtime: LocalBackupUiRestoreProtocolRuntime;
  operations: LocalBackupUiRestoreStageOperations;
} {
  const order: string[] = [];
  let marker = initialMarker;
  const runtime: LocalBackupUiRestoreProtocolRuntime = {
    marker: () => marker,
    verifyOwnership: vi.fn(async () => {
      order.push('verify');
      return true;
    }),
    transition: vi.fn(async update => {
      marker = update(marker);
      order.push(`transition:${marker.state}:${marker.phase}:${marker.completedStages.at(-1) ?? ''}`);
      return marker;
    }),
    runWriterMutation: vi.fn((_source, write) => write()),
    runWriterMutationAsync: vi.fn(async (_source, write) => await write()),
    drainWriters: vi.fn(async () => {
      order.push('drain');
    }),
    abortBeforeMutation: vi.fn(async () => {
      order.push('abort');
    }),
    finalize: vi.fn(async outcome => {
      order.push(`finalize:${outcome}`);
    }),
  };
  const operations: LocalBackupUiRestoreStageOperations = {
    decodePreImage: vi.fn(() => order.push('decode')),
    apply: vi.fn(async stage => {
      order.push(`apply:${stage}`);
      if (stage === failStage) throw new Error(`${stage} failed`);
      return stage;
    }),
    verifyApplied: vi.fn(async stage => {
      order.push(`read-back:${stage}`);
    }),
    rollback: vi.fn(async stage => {
      order.push(`rollback:${stage}`);
    }),
    verifyRolledBack: vi.fn(async stage => {
      order.push(`rollback-read-back:${stage}`);
    }),
  };
  return { order, runtime, operations };
}

function createMarker(
  overrides: Partial<LocalBackupUiRestoreMarker> = {},
): LocalBackupUiRestoreMarker {
  return {
    schemaVersion: 2,
    ownerUserId: 'owner-1',
    runId: 'run-1',
    restoreRunId: RESTORE_RUN_ID,
    actionQueueRestoreIdentity: ACTION_QUEUE_RESTORE_IDENTITY,
    createdAt: '2026-07-27T00:00:00.000Z',
    leaseExpiresAt: '2099-07-27T00:00:00.000Z',
    state: 'prepared',
    phase: 'pre-image-captured',
    completedStages: [],
    rollbackCompletedStages: [],
    source: { kind: 'local-file', reference: null, checksum: SOURCE_DIGEST },
    touchedProjectIds: ['project-1'],
    preImage: {
      projectState: {},
      attachmentOutbox: [],
      actionQueue: {},
      retryQueue: {},
      deadLetters: {},
      conflicts: {},
      metadata: {},
    },
    rollbackErrors: [],
    ...overrides,
  };
}
