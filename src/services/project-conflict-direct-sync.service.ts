import { Injectable, inject } from '@angular/core';
import type { Project } from '../models';
import { ActionQueueService } from './action-queue.service';
import type {
  LocalHandoffIdentity,
  LocalHandoffQueueMutationResult,
} from './action-queue-held-action.controller';
import type { ProjectPayload, QueuedAction } from './action-queue.types';
import { AuthService } from './auth.service';
import {
  ConflictStorageService,
  createProjectConflictRecordFingerprint,
  type ConflictRecord,
} from './conflict-storage.service';
import {
  createProjectConnectionUpsertOperationId,
  createProjectTaskDeleteBatchOperationId,
  createProjectTaskUpsertOperationId,
} from './project-operation-child-operation-id';
import { SyncRpcClientService, type SyncRpcResult } from './sync-rpc-client.service';
import { SyncWriterLeaseService, type LeaseHandle } from './sync-writer-lease.service';
import { UserSessionService } from './user-session.service';
import {
  createProjectConflictHandoffPayloadDigest,
  createProjectConflictHandoffReservationId,
  isCanonicalProjectConflictHandoffAction,
  type ProjectConflictRetrySettlementInput,
  type ProjectConflictRetrySettlementResult,
} from './project-operation-conflict-retry-settlement.controller';

export interface ProjectConflictDirectSyncRequest {
  resolvedProject: Project;
  remoteProject?: Project;
  ownerUserId: string;
  sessionGeneration: number;
  authFence: string;
  operationId: string;
  taskIdsToDelete: string[];
  taskDeleteBaseUpdatedAtMap: Record<string, string | null | undefined>;
  abortSignal: AbortSignal;
}

export interface ProjectConflictActivatedHandoffRequest {
  action: QueuedAction;
  ownerUserId: string;
  sessionGeneration: number;
  authFence: string;
  abortSignal?: AbortSignal;
}

export type ProjectConflictDirectSyncResult =
  | { status: 'applied' }
  | { status: 'aborted' }
  | { status: 'conflict'; result: SyncRpcResult }
  | { status: 'partial'; skippedIds: string[] };

export interface ProjectConflictDurableSyncRequest {
  resolvedProject: Project;
  remoteProject?: Project;
  ownerUserId: string;
  sessionGeneration: number;
  authFence: string;
  conflictRecord: ConflictRecord;
  taskIdsToDelete: string[];
  taskDeleteBaseUpdatedAtMap: Record<string, string | null | undefined>;
  background: boolean;
}

export type ProjectConflictDurableSyncResult =
  | { status: 'complete' | 'queued' | 'deferred' | 'stale' | 'storage-failed' };

type SettleProjectConflictHandoff = (
  input: ProjectConflictRetrySettlementInput,
  additionalFence: () => boolean,
) => Promise<ProjectConflictRetrySettlementResult>;

interface PreparedDurableHandoff extends ProjectConflictRetrySettlementInput {
  conflictRecord: ConflictRecord;
  remoteProject?: Project;
  taskIdsToDelete: string[];
  taskDeleteBaseUpdatedAtMap: Record<string, string | null | undefined>;
}

@Injectable({ providedIn: 'root' })
export class ProjectConflictDirectSyncService {
  private readonly rpc = inject(SyncRpcClientService);
  private readonly actionQueue = inject(ActionQueueService);
  private readonly auth = inject(AuthService);
  private readonly conflictStorage = inject(ConflictStorageService);
  private readonly userSession = inject(UserSessionService);
  private readonly writerLease = inject(SyncWriterLeaseService);

  async executeDurably(
    input: ProjectConflictDurableSyncRequest,
    settle: SettleProjectConflictHandoff,
  ): Promise<ProjectConflictDurableSyncResult> {
    const conflictRecord = { ...input.conflictRecord, ownerUserId: input.ownerUserId };
    const conflictFingerprint = createProjectConflictRecordFingerprint(conflictRecord);
    const payload: ProjectPayload = {
      project: input.resolvedProject,
      sourceUserId: input.ownerUserId,
      taskIdsToDelete: input.taskIdsToDelete,
      taskDeleteBaseUpdatedAtMap: input.taskDeleteBaseUpdatedAtMap,
      conflictHandoff: { conflictRecord },
    };
    const payloadDigest = createProjectConflictHandoffPayloadDigest(payload);
    const receipt = await this.actionQueue.enqueueHeldDurablyForOwner(
      input.ownerUserId,
      {
        type: 'update', entityType: 'project', entityId: input.resolvedProject.id,
        payload,
      },
      { projectId: input.resolvedProject.id, payloadDigest, conflictFingerprint },
    );
    if (!receipt) return { status: 'storage-failed' };
    if (!this.isFenceCurrent(input)) return { status: 'stale' };

    const reservationId = createProjectConflictHandoffReservationId(
      receipt.operationId, payloadDigest, conflictFingerprint,
    );
    const prepared: PreparedDurableHandoff = {
      ownerUserId: input.ownerUserId,
      sessionGeneration: input.sessionGeneration,
      authFence: input.authFence,
      projectId: input.resolvedProject.id,
      actionId: receipt.actionId,
      operationId: receipt.operationId,
      payloadDigest,
      conflictFingerprint,
      reservationId,
      conflictRecord,
      resolvedProject: input.resolvedProject,
      remoteProject: input.remoteProject,
      taskIdsToDelete: input.taskIdsToDelete,
      taskDeleteBaseUpdatedAtMap: input.taskDeleteBaseUpdatedAtMap,
    };
    const required = await this.conflictStorage.persistProjectConflictLocalHandoffRequirement({
      ...this.identity(prepared),
      conflictRecord,
    });
    if (!this.isFenceCurrent(input)) return { status: 'stale' };
    if (required.status !== 'committed') return { status: 'deferred' };

    const continuation = this.runPreparedHandoff(prepared, settle);
    if (!input.background) return continuation;
    void continuation.catch(() => undefined);
    await Promise.resolve();
    return { status: 'queued' };
  }

  private async runPreparedHandoff(
    input: PreparedDurableHandoff,
    settle: SettleProjectConflictHandoff,
  ): Promise<ProjectConflictDurableSyncResult> {
    let lease: LeaseHandle | null = null;
    let processActivatedAction = false;
    try {
      try {
        lease = await this.writerLease.requestLease({
          userId: input.ownerUserId,
          projectId: input.projectId,
        });
      } catch {
        return await this.deferPreparedHandoff(input);
      }
      if (!this.isFenceCurrent(input, lease)) return { status: 'stale' };
      if (lease.mode === 'memory-only' || !lease.signal) {
        processActivatedAction = await this.prepareAndActivateHandoff(input, lease);
        if (!this.isFenceCurrent(input, lease)) return { status: 'stale' };
        return { status: 'deferred' };
      }

      let result: ProjectConflictDirectSyncResult;
      try {
        result = await this.execute({
          resolvedProject: input.resolvedProject,
          remoteProject: input.remoteProject,
          ownerUserId: input.ownerUserId,
          sessionGeneration: input.sessionGeneration,
          authFence: input.authFence,
          operationId: input.operationId,
          taskIdsToDelete: input.taskIdsToDelete,
          taskDeleteBaseUpdatedAtMap: input.taskDeleteBaseUpdatedAtMap,
          abortSignal: lease.signal,
        });
      } catch {
        if (!this.isFenceCurrent(input, lease)) return { status: 'stale' };
        processActivatedAction = await this.prepareAndActivateHandoff(input, lease);
        if (!this.isFenceCurrent(input, lease)) return { status: 'stale' };
        return { status: 'deferred' };
      }
      if (!this.isFenceCurrent(input, lease)) return { status: 'stale' };
      if (result.status !== 'applied') {
        processActivatedAction = await this.prepareAndActivateHandoff(input, lease);
        if (!this.isFenceCurrent(input, lease)) return { status: 'stale' };
        return { status: 'deferred' };
      }

      const settled = await settle(input, () => this.isFenceCurrent(input, lease));
      if (!this.isFenceCurrent(input, lease)) return { status: 'stale' };
      if (settled === 'retry') {
        processActivatedAction = await this.prepareAndActivateHandoff(input, lease);
        if (!this.isFenceCurrent(input, lease)) return { status: 'stale' };
        return { status: 'deferred' };
      }
      return { status: settled === 'complete' ? 'complete' : 'stale' };
    } finally {
      if (lease) {
        try { await lease.release(); } catch { /* Durable evidence remains retryable. */ }
      }
      if (processActivatedAction && this.isFenceCurrent(input)) {
        void this.actionQueue.processQueue();
      }
    }
  }

  private async deferPreparedHandoff(
    input: PreparedDurableHandoff,
  ): Promise<ProjectConflictDurableSyncResult> {
    const activated = await this.prepareAndActivateHandoff(input);
    if (activated && this.isFenceCurrent(input)) void this.actionQueue.processQueue();
    return { status: 'deferred' };
  }

  private async prepareAndActivateHandoff(
    input: PreparedDurableHandoff,
    lease?: LeaseHandle | null,
  ): Promise<boolean> {
    if (!this.isFenceCurrent(input, lease)) return false;
    try {
      const identity = this.identity(input);
      const required = await this.conflictStorage.persistProjectConflictLocalHandoffRequirement({
        ...identity, conflictRecord: input.conflictRecord,
      });
      if (!this.isFenceCurrent(input, lease) || required.status !== 'committed') return false;
      const reservation = await this.conflictStorage.reserveProjectConflictLocalHandoff({
        ...identity, reservedAt: new Date().toISOString(),
      });
      if (!this.isFenceCurrent(input, lease)
        || reservation.status !== 'committed'
        || reservation.reservationId !== identity.reservationId) return false;
      const transitioned = await this.actionQueue.transitionLocalHandoffStrictlyForOwner({
        ...identity, expectedState: 'required', nextState: 'reserved',
        transitionedAt: new Date().toISOString(),
      });
      if (!this.isFenceCurrent(input, lease)
        || !this.matchesPreparedAction(transitioned, identity)) return false;
      const activated = await this.actionQueue.activateLocalHandoffStrictlyForOwner(identity);
      return this.isFenceCurrent(input, lease)
        && this.matchesPreparedAction(activated, identity, 'pending_sync');
    } catch {
      return false;
    }
  }

  private matchesPreparedAction(
    result: LocalHandoffQueueMutationResult,
    identity: LocalHandoffIdentity,
    syncState?: QueuedAction['syncState'],
  ): boolean {
    const action = result.status === 'committed' ? result.action : undefined;
    const handoff = action?.localHandoff;
    return !!action && !!handoff && action.id === identity.actionId
      && action.operationId === identity.operationId
      && handoff.ownerUserId === identity.ownerUserId
      && handoff.projectId === identity.projectId
      && handoff.actionId === identity.actionId
      && handoff.operationId === identity.operationId
      && handoff.payloadDigest === identity.payloadDigest
      && handoff.conflictFingerprint === identity.conflictFingerprint
      && handoff.state !== 'required'
      && handoff.reservationId === identity.reservationId
      && (!syncState || action.syncState === syncState);
  }

  private isFenceCurrent(
    input: Pick<ProjectConflictRetrySettlementInput, 'ownerUserId' | 'sessionGeneration' | 'authFence'>,
    lease?: LeaseHandle | null,
  ): boolean {
    return lease?.signal?.aborted !== true
      && this.auth.currentUserId() === input.ownerUserId
      && this.auth.captureAuthIdentityFence() === input.authFence
      && this.userSession.isSessionContextCurrent(input.sessionGeneration, input.ownerUserId);
  }

  private identity(input: PreparedDurableHandoff) {
    const {
      ownerUserId, projectId, actionId, operationId,
      payloadDigest, conflictFingerprint, reservationId,
    } = input;
    return {
      ownerUserId, projectId, actionId, operationId,
      payloadDigest, conflictFingerprint, reservationId,
    };
  }

  async executeActivatedHandoff(
    input: ProjectConflictActivatedHandoffRequest,
  ): Promise<ProjectConflictDirectSyncResult> {
    const request = this.createActivatedHandoffRequest(input);
    return request ? this.execute(request) : { status: 'aborted' };
  }

  private createActivatedHandoffRequest(
    input: ProjectConflictActivatedHandoffRequest,
  ): ProjectConflictDirectSyncRequest | null {
    const { abortSignal, ownerUserId } = input;
    if (!abortSignal || abortSignal.aborted) return null;
    const action: QueuedAction = structuredClone(input.action);
    const payload = action.payload as ProjectPayload;
    const handoff = action.localHandoff;
    const conflictRecord = payload.conflictHandoff?.conflictRecord;
    if (!conflictRecord || !handoff
      || !isCanonicalProjectConflictHandoffAction(action, ownerUserId)) return null;
    const reservationId = createProjectConflictHandoffReservationId(
      action.operationId, handoff.payloadDigest, handoff.conflictFingerprint,
    );
    if (handoff.reservationId !== reservationId) return null;
    return {
      resolvedProject: payload.project,
      remoteProject: conflictRecord.remoteSnapshotFresh ? conflictRecord.remoteProject : undefined,
      ownerUserId, sessionGeneration: input.sessionGeneration, authFence: input.authFence,
      operationId: action.operationId, taskIdsToDelete: payload.taskIdsToDelete ?? [],
      taskDeleteBaseUpdatedAtMap: payload.taskDeleteBaseUpdatedAtMap ?? {}, abortSignal,
    };
  }

  async execute(input: ProjectConflictDirectSyncRequest): Promise<ProjectConflictDirectSyncResult> {
    if (!this.isDirectSyncFenceCurrent(input)) return { status: 'aborted' };

    const projectResult = await this.rpc.upsertProject({
      operationId: input.operationId,
      project: input.resolvedProject,
      ownerId: input.ownerUserId,
      baseUpdatedAt: input.remoteProject?.updatedAt ?? null,
      abortSignal: input.abortSignal,
    });
    if (!this.isDirectSyncFenceCurrent(input)) return { status: 'aborted' };
    if (!isApplied(projectResult)) return { status: 'conflict', result: projectResult };

    const remoteTasks = new Map((input.remoteProject?.tasks ?? []).map(task => [task.id, task]));
    for (const task of [...input.resolvedProject.tasks].sort(byId)) {
      const result = await this.rpc.upsertTask({
        operationId: createProjectTaskUpsertOperationId(
          input.operationId, input.resolvedProject.id, task,
        ),
        task,
        projectId: input.resolvedProject.id,
        baseUpdatedAt: remoteTasks.get(task.id)?.updatedAt ?? null,
        writeIntent: 'task_full_upsert',
        abortSignal: input.abortSignal,
      });
      if (!this.isDirectSyncFenceCurrent(input)) return { status: 'aborted' };
      if (!isApplied(result)) return { status: 'conflict', result };
    }

    if (input.taskIdsToDelete.length > 0) {
      const result = await this.rpc.deleteTasks({
        operationId: createProjectTaskDeleteBatchOperationId(
          input.operationId,
          input.resolvedProject.id,
          input.taskIdsToDelete,
          input.taskDeleteBaseUpdatedAtMap,
        ),
        projectId: input.resolvedProject.id,
        taskIds: input.taskIdsToDelete,
        baseUpdatedAt: input.remoteProject?.updatedAt ?? null,
        baseUpdatedAtMap: input.taskDeleteBaseUpdatedAtMap,
        abortSignal: input.abortSignal,
      });
      if (!this.isDirectSyncFenceCurrent(input)) return { status: 'aborted' };
      if (!isApplied(result)) return { status: 'conflict', result };
      if (result.skippedIds?.length) {
        return { status: 'partial', skippedIds: result.skippedIds };
      }
    }

    const remoteConnections = new Map(
      (input.remoteProject?.connections ?? []).map(connection => [connection.id, connection]),
    );
    for (const connection of [...input.resolvedProject.connections].sort(byId)) {
      const result = await this.rpc.upsertConnection({
        operationId: createProjectConnectionUpsertOperationId(
          input.operationId, input.resolvedProject.id, connection,
        ),
        connection,
        projectId: input.resolvedProject.id,
        baseUpdatedAt: remoteConnections.get(connection.id)?.updatedAt ?? null,
        abortSignal: input.abortSignal,
      });
      if (!this.isDirectSyncFenceCurrent(input)) return { status: 'aborted' };
      if (!isApplied(result)) return { status: 'conflict', result };
    }

    return { status: 'applied' };
  }

  private isDirectSyncFenceCurrent(input: ProjectConflictDirectSyncRequest): boolean {
    return !input.abortSignal.aborted && this.isFenceCurrent(input);
  }
}

function isApplied(result: SyncRpcResult): boolean {
  return result.status === 'applied' || result.status === 'idempotent-replay';
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id.localeCompare(b.id);
}
