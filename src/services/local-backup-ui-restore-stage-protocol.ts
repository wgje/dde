import {
  LOCAL_BACKUP_UI_RESTORE_STAGES,
  type LocalBackupUiRestoreMarker,
  type LocalBackupUiRestoreStage,
} from './local-backup-ui-restore-types';
import type { LocalBackupUiRestoreWriterSource } from './local-backup-ui-restore-writer-quiescence.service';

export class LocalBackupUiRestoreOwnershipLostError extends Error {
  constructor(message = 'local backup UI restore ownership lost') {
    super(message);
    this.name = 'LocalBackupUiRestoreOwnershipLostError';
  }
}

export type LocalBackupUiRestoreFinalOutcome = 'completed' | 'rolled-back';

export type LocalBackupUiRestoreStageProtocolResult =
  | {
    status: 'completed';
    stageResults: Partial<Record<LocalBackupUiRestoreStage, unknown>>;
  }
  | {
    status: 'rolled-back';
    error: unknown;
    stageResults: Partial<Record<LocalBackupUiRestoreStage, unknown>>;
  }
  | {
    status: 'blocked';
    error: unknown;
    ownershipLost: boolean;
    dataState: 'partial' | 'completed' | 'rolled-back';
    stageResults: Partial<Record<LocalBackupUiRestoreStage, unknown>>;
  };

export interface LocalBackupUiRestoreProtocolRuntime {
  marker(): LocalBackupUiRestoreMarker;
  verifyOwnership(): Promise<boolean>;
  transition(
    update: (current: LocalBackupUiRestoreMarker) => LocalBackupUiRestoreMarker,
  ): Promise<LocalBackupUiRestoreMarker>;
  runWriterMutation<T>(
    source: LocalBackupUiRestoreWriterSource,
    write: () => Promise<T>,
  ): Promise<T>;
  drainWriters(): Promise<void>;
  abortBeforeMutation(): Promise<void>;
  finalize(outcome: LocalBackupUiRestoreFinalOutcome): Promise<void>;
}

export interface LocalBackupUiRestoreStageOperationContext {
  marker(): LocalBackupUiRestoreMarker;
  checkpoint(): Promise<void>;
  runWriterMutation<T>(
    source: LocalBackupUiRestoreWriterSource,
    write: () => Promise<T>,
  ): Promise<T>;
}

export interface LocalBackupUiRestoreStageOperations {
  decodePreImage(marker: LocalBackupUiRestoreMarker): void;
  apply(
    stage: LocalBackupUiRestoreStage,
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<unknown>;
  verifyApplied(
    stage: LocalBackupUiRestoreStage,
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<void>;
  rollback(
    stage: LocalBackupUiRestoreStage,
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<void>;
  verifyRolledBack(
    stage: LocalBackupUiRestoreStage,
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<void>;
}

export async function runLocalBackupUiRestoreStageProtocol(
  runtime: LocalBackupUiRestoreProtocolRuntime,
  operations: LocalBackupUiRestoreStageOperations,
): Promise<LocalBackupUiRestoreStageProtocolResult> {
  try {
    operations.decodePreImage(runtime.marker());
  } catch (error) {
    return blockedResult(error, isOwnershipLost(error), 'partial', {});
  }

  const stageResults: Partial<Record<LocalBackupUiRestoreStage, unknown>> = {};
  const context = createOperationContext(runtime);
  let currentStage: LocalBackupUiRestoreStage | null = null;

  try {
    for (const stage of LOCAL_BACKUP_UI_RESTORE_STAGES) {
      currentStage = stage;
      await transitionStage(runtime, stage, 'restoring');
      await checkpoint(runtime);
      stageResults[stage] = await operations.apply(stage, context);
      await checkpoint(runtime);
      await runtime.drainWriters();
      await checkpoint(runtime);
      await operations.verifyApplied(stage, context);
      await checkpoint(runtime);
      await completeForwardStage(runtime, stage);
    }
    await transitionFinalState(runtime, 'completed');
    await runtime.finalize('completed');
    return { status: 'completed', stageResults };
  } catch (error) {
    if (isOwnershipLost(error)) {
      return blockedResult(error, true, 'partial', stageResults);
    }
    if (currentStage === null) throw error;
    return await rollbackStages(
      runtime,
      operations,
      context,
      getRollbackStages(runtime.marker(), currentStage),
      error,
      stageResults,
    );
  }
}

export async function runLocalBackupUiRestoreStartupRollbackProtocol(
  runtime: LocalBackupUiRestoreProtocolRuntime,
  operations: LocalBackupUiRestoreStageOperations,
): Promise<LocalBackupUiRestoreStageProtocolResult> {
  try {
    operations.decodePreImage(runtime.marker());
  } catch (error) {
    return blockedResult(error, isOwnershipLost(error), 'partial', {});
  }

  return await rollbackStages(
    runtime,
    operations,
    createOperationContext(runtime),
    getStartupRollbackStages(runtime.marker()),
    new Error('local backup UI restore startup rollback resumed'),
    {},
  );
}

function createOperationContext(
  runtime: LocalBackupUiRestoreProtocolRuntime,
): LocalBackupUiRestoreStageOperationContext {
  return {
    marker: () => runtime.marker(),
    checkpoint: () => checkpoint(runtime),
    runWriterMutation: (source, write) => runtime.runWriterMutation(source, write),
  };
}

async function checkpoint(runtime: LocalBackupUiRestoreProtocolRuntime): Promise<void> {
  if (!await runtime.verifyOwnership()) {
    throw new LocalBackupUiRestoreOwnershipLostError();
  }
}

async function transitionStage(
  runtime: LocalBackupUiRestoreProtocolRuntime,
  stage: LocalBackupUiRestoreStage,
  state: 'restoring' | 'rolling-back',
): Promise<void> {
  await checkpoint(runtime);
  await runtime.transition(current => ({ ...current, state, phase: stage }));
}

async function completeForwardStage(
  runtime: LocalBackupUiRestoreProtocolRuntime,
  stage: LocalBackupUiRestoreStage,
): Promise<void> {
  await runtime.transition(current => {
    if (current.phase !== stage || current.state !== 'restoring') {
      throw new LocalBackupUiRestoreOwnershipLostError('restore marker stage drifted');
    }
    return {
      ...current,
      completedStages: [...current.completedStages, stage],
    };
  });
}

async function rollbackStages(
  runtime: LocalBackupUiRestoreProtocolRuntime,
  operations: LocalBackupUiRestoreStageOperations,
  context: LocalBackupUiRestoreStageOperationContext,
  rollbackStages: readonly LocalBackupUiRestoreStage[],
  originalError: unknown,
  stageResults: Partial<Record<LocalBackupUiRestoreStage, unknown>>,
): Promise<LocalBackupUiRestoreStageProtocolResult> {
  try {
    for (const stage of rollbackStages) {
      await transitionStage(runtime, stage, 'rolling-back');
      await checkpoint(runtime);
      await operations.rollback(stage, context);
      await checkpoint(runtime);
      await runtime.drainWriters();
      await checkpoint(runtime);
      await operations.verifyRolledBack(stage, context);
      await checkpoint(runtime);
      await completeRollbackStage(runtime, stage);
    }
    await transitionFinalState(runtime, 'rolled-back');
    await runtime.finalize('rolled-back');
    return { status: 'rolled-back', error: originalError, stageResults };
  } catch (rollbackError) {
    const ownershipLost = isOwnershipLost(rollbackError);
    if (!ownershipLost) await recordRollbackFailure(runtime, rollbackError).catch(() => undefined);
    return blockedResult(rollbackError, ownershipLost, 'partial', stageResults);
  }
}

function getRollbackStages(
  marker: LocalBackupUiRestoreMarker,
  currentStage: LocalBackupUiRestoreStage,
): LocalBackupUiRestoreStage[] {
  const alreadyRolledBack = new Set(marker.rollbackCompletedStages);
  const stages = [currentStage, ...marker.completedStages.slice().reverse()];
  return stages.filter((stage, index) => (
    stages.indexOf(stage) === index && !alreadyRolledBack.has(stage)
  ));
}

function getStartupRollbackStages(
  marker: LocalBackupUiRestoreMarker,
): LocalBackupUiRestoreStage[] {
  if (marker.phase === 'finalizing' || marker.phase === 'pre-image-captured') return [];
  return getRollbackStages(marker, marker.phase);
}

async function completeRollbackStage(
  runtime: LocalBackupUiRestoreProtocolRuntime,
  stage: LocalBackupUiRestoreStage,
): Promise<void> {
  await runtime.transition(current => {
    if (current.phase !== stage || current.state !== 'rolling-back') {
      throw new LocalBackupUiRestoreOwnershipLostError('rollback marker stage drifted');
    }
    return {
      ...current,
      rollbackCompletedStages: [...current.rollbackCompletedStages, stage],
    };
  });
}

async function recordRollbackFailure(
  runtime: LocalBackupUiRestoreProtocolRuntime,
  error: unknown,
): Promise<void> {
  if (!await runtime.verifyOwnership()) return;
  await runtime.transition(current => ({
    ...current,
    state: 'rollback-failed',
    rollbackErrors: [...current.rollbackErrors, {
      stage: current.phase as LocalBackupUiRestoreStage,
      message: formatError(error),
      recordedAt: new Date().toISOString(),
    }],
  }));
}

async function transitionFinalState(
  runtime: LocalBackupUiRestoreProtocolRuntime,
  state: LocalBackupUiRestoreFinalOutcome,
): Promise<void> {
  await checkpoint(runtime);
  await runtime.transition(current => ({ ...current, state, phase: 'finalizing' }));
}

function blockedResult(
  error: unknown,
  ownershipLost: boolean,
  dataState: 'partial' | 'completed' | 'rolled-back',
  stageResults: Partial<Record<LocalBackupUiRestoreStage, unknown>>,
): LocalBackupUiRestoreStageProtocolResult {
  return { status: 'blocked', error, ownershipLost, dataState, stageResults };
}

function isOwnershipLost(error: unknown): boolean {
  return error instanceof LocalBackupUiRestoreOwnershipLostError;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
