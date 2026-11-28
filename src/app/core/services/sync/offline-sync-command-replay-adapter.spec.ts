import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  createOfflineSyncCommand,
  OFFLINE_SYNC_COMMAND_KINDS,
  type KnownOfflineSyncCommandKind,
  type OfflineSyncCommandEnvelope,
  type OfflineSyncEntityType,
} from '../../../../services/sync/offline-sync-command-envelope';
import {
  replayOfflineSyncCommand,
  createOfflineSyncCommandRpcDispatchers,
  createOfflineSyncCommandEnvelopeDispatchers,
  OFFLINE_SYNC_SERVER_DOMAIN_COMMANDS,
  createOfflineSyncUnsupportedCommandQuarantiner,
  type OfflineSyncCommandEntityHandlers,
  type OfflineSyncCommandReplayDispatcher,
} from './offline-sync-command-replay-adapter';
import { IndexedDbOfflineCommandStore } from '../../../../services/sync/offline-command-store';
import type { RetryOperationHandler } from './retry-queue.types';

function command(
  status: 'pending' | 'unknown' = 'pending',
  commandKind: KnownOfflineSyncCommandKind = 'task.update',
  entityType: OfflineSyncEntityType = entityForCommand(commandKind),
): OfflineSyncCommandEnvelope {
  return createOfflineSyncCommand({
    ownerUserId: 'owner-1', installationId: 'installation-1', deviceId: 'device-1',
    entityType, entityId: 'entity-1', projectId: 'project-1', command: commandKind,
    intent: { writeIntent: 'task_content_update' },
    normalizedResultPatch: { id: 'entity-1', content: 'offline', taskIdsToDelete: ['task-old'] },
    operationId: `operation-${status}-${commandKind}`, status, nowMs: 1_000,
  });
}

function receiptIdentity(value: OfflineSyncCommandEnvelope): Record<string, unknown> {
  return {
    identityVersion: 1,
    schemaVersion: value.schemaVersion,
    operationId: value.operationId,
    ownerUserId: value.ownerUserId,
    installationId: value.installationId,
    deviceId: value.deviceId,
    logicalClock: value.logicalClock,
    entityType: value.entityType,
    entityId: value.entityId,
    projectId: value.projectId ?? null,
    command: value.command,
    intent: value.intent,
    baseVersion: value.baseVersion ?? null,
    baseUpdatedAt: value.baseUpdatedAt ?? null,
    normalizedResultPatch: value.normalizedResultPatch,
    dependencyOperationIds: value.dependencyOperationIds,
    fieldVersions: (value as unknown as Record<string, unknown>)['fieldVersions'] ?? {},
  };
}
function entityForCommand(kind: KnownOfflineSyncCommandKind): OfflineSyncEntityType {
  return kind.slice(0, kind.indexOf('.')) as OfflineSyncEntityType;
}

function handler(overrides: Partial<RetryOperationHandler> = {}): RetryOperationHandler {
  return {
    pushTask: vi.fn().mockResolvedValue(true),
    deleteTask: vi.fn().mockResolvedValue(true),
    pushProject: vi.fn().mockResolvedValue(true),
    pushConnection: vi.fn().mockResolvedValue(true),
    isSessionExpired: () => false,
    isOnline: () => true,
    onProcessingStateChange: () => undefined,
    ...overrides,
  };
}

describe('offline-sync-command-replay-adapter', () => {
  it('replays legacy task commands through the existing handler and preserves operationId', async () => {
    const retry = vi.fn().mockResolvedValue(true);
    const result = await replayOfflineSyncCommand(command(), handler({ pushTask: retry }));
    expect(result).toEqual({ status: 'replayed', success: true });
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({ id: 'entity-1' }), 'project-1', 'owner-1', 'task_content_update', 'operation-pending-task.update');
  });

  it('uses the command dispatcher for every registered command kind', async () => {
    const seen: string[] = [];
    const dispatchers = Object.fromEntries(OFFLINE_SYNC_COMMAND_KINDS.map(kind => [
      kind,
      vi.fn(async () => { seen.push(kind); return true; }),
    ])) as Partial<Record<KnownOfflineSyncCommandKind, OfflineSyncCommandReplayDispatcher>>;
    const retry = handler();

    for (const kind of OFFLINE_SYNC_COMMAND_KINDS) {
      const result = await replayOfflineSyncCommand(command('pending', kind), retry, { commands: dispatchers });
      expect(result).toEqual({ status: 'replayed', success: true });
    }

    expect(seen).toEqual([...OFFLINE_SYNC_COMMAND_KINDS]);
  });

  it('routes entity-specific durable categories through typed callbacks', async () => {
    const calls: string[] = [];
    const onEntity = (kind: string) => async (_command: OfflineSyncCommandEnvelope) => {
      calls.push(kind);
      return true;
    };
    const entities: OfflineSyncCommandEntityHandlers = {
      attachment: onEntity('attachment'),
      preference: onEntity('preference'),
      focus_routine: onEntity('focus_routine'),
      focus_session: onEntity('focus_session'),
      routine_task: onEntity('routine_task'),
      routine_completion: onEntity('routine_completion'),
    };
    const kinds = OFFLINE_SYNC_COMMAND_KINDS.filter(kind => {
      const entity = entityForCommand(kind);
      return entity in entities;
    });

    for (const kind of kinds) {
      const result = await replayOfflineSyncCommand(command('pending', kind), handler(), { entities });
      expect(result).toEqual({ status: 'replayed', success: true });
    }
    expect(calls).toEqual(kinds.map(entityForCommand));
  });

  it('reports unsupported when a registered command has no legacy or injected route', async () => {
    const result = await replayOfflineSyncCommand(command('pending', 'project.delete'), handler());
    expect(result).toEqual({ status: 'skipped', reason: 'unsupported' });
  });

  it('quarantines a registered command when no safe replay handler exists', async () => {
    const store = new IndexedDbOfflineCommandStore({ indexedDb: new IDBFactory(), dbName: 'offline-replay-quarantine' });
    const candidate = command('pending', 'project.delete');
    const result = await replayOfflineSyncCommand(candidate, handler(), {
      quarantineUnsupported: createOfflineSyncUnsupportedCommandQuarantiner(store, () => '2026-11-14T00:00:00.000Z'),
    });
    const exported = await store.exportOwner('owner-1');

    expect(result).toEqual({ status: 'skipped', reason: 'unsupported' });
    expect(exported.quarantine).toHaveLength(1);
    expect(exported.quarantine[0]).toMatchObject({ reason: 'no-replay-handler', raw: candidate });
  });

  it('keeps registered but unsupported server commands outside the envelope dispatcher', () => {
    const dispatchers = createOfflineSyncCommandEnvelopeDispatchers({
      applyOfflineCommand: vi.fn(),
      getOfflineCommandStatus: vi.fn(),
    });
    expect(Object.keys(dispatchers).sort()).toEqual([...OFFLINE_SYNC_SERVER_DOMAIN_COMMANDS].sort());
    expect(dispatchers['connection.delete']).toBeUndefined();
    expect(dispatchers['black_box_entry.delete']).toBeUndefined();
    expect(dispatchers['attachment.create']).toBeUndefined();
    expect(dispatchers['preference.delete']).toBeUndefined();
    expect(dispatchers['focus_routine.update']).toBeUndefined();
  });

  it('never falls a connection delete through to the legacy connection upsert handler', async () => {
    const pushConnection = vi.fn().mockResolvedValue(true);
    const quarantine = vi.fn().mockResolvedValue(undefined);
    const result = await replayOfflineSyncCommand(
      command('pending', 'connection.delete', 'connection'),
      handler({ pushConnection }),
      { quarantineUnsupported: quarantine },
    );
    expect(result).toEqual({ status: 'skipped', reason: 'unsupported' });
    expect(pushConnection).not.toHaveBeenCalled();
    expect(quarantine).toHaveBeenCalledWith(expect.objectContaining({ command: 'connection.delete' }), 'intentionally-quarantined-command');
  });

  it('quarantines task attachment metadata instead of replaying a full task upsert', async () => {
    const pushTask = vi.fn().mockResolvedValue(true);
    const quarantine = vi.fn().mockResolvedValue(undefined);
    const candidate = command('pending', 'task.attachments.update');

    const result = await replayOfflineSyncCommand(candidate, handler({ pushTask }), {
      quarantineUnsupported: quarantine,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'unsupported' });
    expect(pushTask).not.toHaveBeenCalled();
    expect(quarantine).toHaveBeenCalledWith(candidate, 'intentionally-quarantined-command');
  });

  it('allows an explicit entity handler to opt into an otherwise quarantined command', async () => {
    const dispatch = vi.fn().mockResolvedValue(true);
    const quarantine = vi.fn().mockResolvedValue(undefined);
    const candidate = command('pending', 'task.attachments.update');

    const result = await replayOfflineSyncCommand(candidate, handler(), {
      entities: { task: dispatch },
      quarantineUnsupported: quarantine,
    });

    expect(result).toEqual({ status: 'replayed', success: true });
    expect(dispatch).toHaveBeenCalledWith(candidate);
    expect(quarantine).not.toHaveBeenCalled();
  });
  it('requires owner-scoped domain-apply confirmation before acknowledging an ingested envelope', async () => {
    const applyOfflineCommand = vi.fn().mockResolvedValue({
      status: 'accepted-shadow', decision: 'accepted-shadow', raw: { status: 'accepted-shadow' },
    });
    const getOfflineCommandStatus = vi.fn().mockResolvedValue({
      status: 'applied', domainApplyStatus: 'applied', appliedToDomainTables: true,
      raw: { status: 'applied', domainApplyStatus: 'applied', appliedToDomainTables: true,
        operationId: command().operationId, commandDigest: 'c9a6ea7db738d8cb5fc354f55fd74805f0b1308183ce1b7cdaffb05d5502c619',
        commandIdentity: receiptIdentity(command()) },
    });
    const dispatchers = createOfflineSyncCommandEnvelopeDispatchers({ applyOfflineCommand, getOfflineCommandStatus });
    const candidate = command('pending', 'task.update');
    const result = await replayOfflineSyncCommand(candidate, handler(), {
      commands: dispatchers, captureRemoteEvidence: true,
    });
    expect(result).toMatchObject({ status: 'replayed', success: true, decision: 'applied' });
    expect(applyOfflineCommand).toHaveBeenCalledWith(expect.objectContaining({
      operationId: candidate.operationId,
      command: expect.objectContaining({ schemaVersion: 1, command: 'task.update' }),
    }));
    expect(getOfflineCommandStatus).toHaveBeenCalledWith({ operationId: candidate.operationId });
  });

  it('accepts the same command after transport metadata and object-key order change', async () => {
    const candidate = command('pending', 'task.update');
    const identity = receiptIdentity(candidate);
    const transportChanged = {
      ...candidate,
      status: 'unknown', createdAtIso: '2030-01-01T00:00:00Z',
      remoteResult: { decision: 'unknown' }, deployment_epoch: 42, client_git_sha: 'another-build',
    } as OfflineSyncCommandEnvelope;
    const dispatchers = createOfflineSyncCommandEnvelopeDispatchers({
      applyOfflineCommand: vi.fn().mockResolvedValue({ status: 'idempotent-replay', raw: {} }),
      getOfflineCommandStatus: vi.fn().mockResolvedValue({
        status: 'applied', domainApplyStatus: 'applied', appliedToDomainTables: true,
        raw: {
          operationId: candidate.operationId,
          commandDigest: 'c9a6ea7db738d8cb5fc354f55fd74805f0b1308183ce1b7cdaffb05d5502c619',
          commandIdentity: Object.fromEntries(Object.entries(identity).reverse()),
        },
      }),
    });

    await expect(dispatchers['task.update']!(transportChanged)).resolves.toMatchObject({ success: true });
  });

  it('retains pending commands as unknown when an old receipt cannot prove their identity', async () => {
    const dispatchers = createOfflineSyncCommandEnvelopeDispatchers({
      applyOfflineCommand: vi.fn().mockResolvedValue({ status: 'reconciliation-pending', raw: { reason: 'command-receipt-identity-unverified' } }),
    });

    await expect(replayOfflineSyncCommand(command(), handler(), {
      commands: dispatchers, captureRemoteEvidence: true,
    })).resolves.toMatchObject({ status: 'unknown', decision: 'reconciliation-pending' });
  });
  it('keeps historical receipts without a bound command identity unconfirmed', async () => {
    const dispatchers = createOfflineSyncCommandEnvelopeDispatchers({
      applyOfflineCommand: vi.fn().mockResolvedValue({ status: 'idempotent-replay', raw: {} }),
      getOfflineCommandStatus: vi.fn().mockResolvedValue({
        status: 'applied', domainApplyStatus: 'applied', appliedToDomainTables: true, raw: {},
      }),
    });

    await expect(dispatchers['task.update']!(command())).resolves.toMatchObject({
      success: false, decision: 'command-receipt-identity-unverified',
    });
  });
  it.each([
    { entityId: 'another-entity' },
    { normalizedResultPatch: { id: 'entity-1', content: 'different command' } },
    { ownerUserId: 'another-owner' },
  ])('does not acknowledge another command sharing the operation ID: %j', async change => {
    const candidate = command('pending', 'task.update');
    const stored = { ...candidate, ...change };
    const dispatchers = createOfflineSyncCommandEnvelopeDispatchers({
      applyOfflineCommand: vi.fn().mockResolvedValue({ status: 'idempotent-replay', raw: {} }),
      getOfflineCommandStatus: vi.fn().mockResolvedValue({
        status: 'applied', domainApplyStatus: 'applied', appliedToDomainTables: true,
        raw: {
          operationId: candidate.operationId,
          commandDigest: 'c9a6ea7db738d8cb5fc354f55fd74805f0b1308183ce1b7cdaffb05d5502c619',
          commandIdentity: receiptIdentity(stored),
        },
      }),
    });

    const result = await replayOfflineSyncCommand(candidate, handler(), {
      commands: dispatchers, captureRemoteEvidence: true,
    });

    expect(result).toMatchObject({ status: 'replayed', success: false, decision: 'command-receipt-identity-mismatch' });
  });
  it('does not acknowledge accepted-shadow when domain application failed', async () => {
    const dispatchers = createOfflineSyncCommandEnvelopeDispatchers({
      applyOfflineCommand: vi.fn().mockResolvedValue({ status: 'accepted-shadow', raw: { status: 'accepted-shadow' } }),
      getOfflineCommandStatus: vi.fn().mockResolvedValue({
        status: 'rejected', domainApplyStatus: 'domain-apply-error', appliedToDomainTables: false,
        raw: { domainApplyStatus: 'domain-apply-error', appliedToDomainTables: false },
      }),
    });
    const result = await replayOfflineSyncCommand(command('pending', 'task.update'), handler(), {
      commands: dispatchers, captureRemoteEvidence: true,
    });
    expect(result).toMatchObject({ status: 'replayed', success: false, decision: 'domain-apply-error' });
  });

  it('routes only exact focus/routine/preference commands through existing idempotent RPCs', async () => {
    const rpc = {
      upsertUserPreferences: vi.fn().mockResolvedValue({ status: 'applied' }),
      upsertFocusSession: vi.fn().mockResolvedValue({ status: 'idempotent-replay' }),
      upsertRoutineTask: vi.fn().mockResolvedValue({ status: 'applied' }),
      incrementRoutineCompletion: vi.fn().mockResolvedValue({ status: 'applied' }),
    };
    const dispatchers = createOfflineSyncCommandRpcDispatchers(rpc);
    const preference = command('pending', 'preference.update', 'preference');
    const focusSession = command('pending', 'focus_session.update', 'focus_session');
    const routineTask = command('pending', 'routine_task.update', 'routine_task');
    const completion = command('pending', 'routine_completion.create', 'routine_completion');

    expect(await replayOfflineSyncCommand(preference, handler(), { commands: dispatchers })).toEqual({ status: 'replayed', success: true });
    expect(await replayOfflineSyncCommand(focusSession, handler(), { commands: dispatchers })).toEqual({ status: 'replayed', success: true });
    expect(await replayOfflineSyncCommand(routineTask, handler(), { commands: dispatchers })).toEqual({ status: 'replayed', success: true });
    expect(await replayOfflineSyncCommand(completion, handler(), { commands: dispatchers })).toEqual({ status: 'replayed', success: true });
    expect(rpc.upsertUserPreferences).toHaveBeenCalledOnce();
    expect(rpc.upsertFocusSession).toHaveBeenCalledOnce();
    expect(rpc.upsertRoutineTask).toHaveBeenCalledOnce();
    expect(rpc.incrementRoutineCompletion).toHaveBeenCalledOnce();
  });

  it('routes project/connection/black-box commands only when matching legacy RPCs are injected', async () => {
    const rpc = {
      upsertProject: vi.fn().mockResolvedValue({ status: 'applied' }),
      deleteProject: vi.fn().mockResolvedValue({ status: 'idempotent-replay' }),
      upsertConnection: vi.fn().mockResolvedValue({ status: 'applied' }),
      upsertBlackboxEntry: vi.fn().mockResolvedValue({ status: 'applied' }),
      upsertUserPreferences: vi.fn().mockResolvedValue({ status: 'applied' }),
      upsertFocusSession: vi.fn().mockResolvedValue({ status: 'applied' }),
      upsertRoutineTask: vi.fn().mockResolvedValue({ status: 'applied' }),
      incrementRoutineCompletion: vi.fn().mockResolvedValue({ status: 'applied' }),
    };
    const dispatchers = createOfflineSyncCommandRpcDispatchers(rpc);
    const project = command('pending', 'project.update', 'project');
    const projectDelete = command('pending', 'project.delete', 'project');
    const connection = command('pending', 'connection.update', 'connection');
    const blackbox = command('pending', 'black_box_entry.update', 'black_box_entry');
    expect(await replayOfflineSyncCommand(project, handler(), { commands: dispatchers })).toEqual({ status: 'replayed', success: true });
    expect(await replayOfflineSyncCommand(projectDelete, handler(), { commands: dispatchers })).toEqual({ status: 'replayed', success: true });
    expect(await replayOfflineSyncCommand(connection, handler(), { commands: dispatchers })).toEqual({ status: 'replayed', success: true });
    expect(await replayOfflineSyncCommand(blackbox, handler(), { commands: dispatchers })).toEqual({ status: 'replayed', success: true });
    expect(rpc.upsertProject).toHaveBeenCalledOnce();
    expect(rpc.deleteProject).toHaveBeenCalledOnce();
    expect(rpc.upsertConnection).toHaveBeenCalledOnce();
    expect(rpc.upsertBlackboxEntry).toHaveBeenCalledOnce();
  });

  it('routes task structure commands through the existing write-intent task RPC', async () => {
    const rpc = {
      upsertTask: vi.fn().mockResolvedValue({ status: 'applied' }),
      upsertUserPreferences: vi.fn().mockResolvedValue({ status: 'applied' }),
      upsertFocusSession: vi.fn().mockResolvedValue({ status: 'applied' }),
      upsertRoutineTask: vi.fn().mockResolvedValue({ status: 'applied' }),
      incrementRoutineCompletion: vi.fn().mockResolvedValue({ status: 'applied' }),
    };
    const dispatchers = createOfflineSyncCommandRpcDispatchers(rpc);
    const move = command('pending', 'task.move', 'task');
    expect(await replayOfflineSyncCommand(move, handler(), { commands: dispatchers })).toEqual({ status: 'replayed', success: true });
    expect(rpc.upsertTask).toHaveBeenCalledWith(expect.objectContaining({ writeIntent: 'task_structure_update' }));
  });

  it('routes task soft-delete and purge through the guarded batch-delete RPC', async () => {
    const rpc = {
      deleteTasks: vi.fn().mockResolvedValue({ status: 'applied' }),
      upsertTask: vi.fn().mockResolvedValue({ status: 'applied' }),
      upsertUserPreferences: vi.fn().mockResolvedValue({ status: 'applied' }),
      upsertFocusSession: vi.fn().mockResolvedValue({ status: 'applied' }),
      upsertRoutineTask: vi.fn().mockResolvedValue({ status: 'applied' }),
      incrementRoutineCompletion: vi.fn().mockResolvedValue({ status: 'applied' }),
    };
    const dispatchers = createOfflineSyncCommandRpcDispatchers(rpc);
    const softDelete = command('pending', 'task.delete', 'task');
    const purge = command('pending', 'task.permanently_delete', 'task');

    expect(await replayOfflineSyncCommand(softDelete, handler(), { commands: dispatchers }))
      .toEqual({ status: 'replayed', success: true });
    expect(await replayOfflineSyncCommand(purge, handler(), { commands: dispatchers }))
      .toEqual({ status: 'replayed', success: true });
    expect(rpc.deleteTasks).toHaveBeenNthCalledWith(1, expect.objectContaining({
      operationId: softDelete.operationId,
      projectId: 'project-1',
      taskIds: ['entity-1'],
      baseUpdatedAt: null,
      deleteMode: 'soft',
    }));
    expect(rpc.deleteTasks).toHaveBeenNthCalledWith(2, expect.objectContaining({
      operationId: purge.operationId,
      projectId: 'project-1',
      taskIds: ['entity-1'],
      baseUpdatedAt: null,
      deleteMode: 'purge',
    }));
    expect(rpc.upsertTask).not.toHaveBeenCalled();
  });

  it('keeps task deletes quarantined when project scope is missing or delete RPC is unavailable', async () => {
    const rpc = {
      deleteTasks: vi.fn(),
      upsertUserPreferences: vi.fn().mockResolvedValue({ status: 'applied' }),
      upsertFocusSession: vi.fn().mockResolvedValue({ status: 'applied' }),
      upsertRoutineTask: vi.fn().mockResolvedValue({ status: 'applied' }),
      incrementRoutineCompletion: vi.fn().mockResolvedValue({ status: 'applied' }),
    };
    const dispatchers = createOfflineSyncCommandRpcDispatchers(rpc);
    const quarantine = vi.fn().mockResolvedValue(undefined);
    const missingProject = createOfflineSyncCommand({
      ownerUserId: 'owner-1', installationId: 'installation-1', deviceId: 'device-1',
      entityType: 'task', entityId: 'entity-1', command: 'task.delete', intent: {},
      normalizedResultPatch: { deleted: true }, operationId: 'missing-project', nowMs: 1_000,
    });
    const result = await replayOfflineSyncCommand(missingProject, handler(), {
      commands: dispatchers,
      quarantineUnsupported: quarantine,
    });
    expect(result).toEqual({ status: 'skipped', reason: 'unsupported' });
    expect(quarantine).toHaveBeenCalledWith(missingProject, 'no-replay-handler');
    expect(rpc.deleteTasks).not.toHaveBeenCalled();
  });
  it('does not route deletes or malformed payloads through an upsert RPC', async () => {
    const rpc = {
      upsertUserPreferences: vi.fn().mockResolvedValue({ status: 'applied' }),
      upsertFocusSession: vi.fn().mockResolvedValue({ status: 'applied' }),
      upsertRoutineTask: vi.fn().mockResolvedValue({ status: 'applied' }),
      incrementRoutineCompletion: vi.fn().mockResolvedValue({ status: 'applied' }),
    };
    const dispatchers = createOfflineSyncCommandRpcDispatchers(rpc);
    const quarantine = vi.fn().mockResolvedValue(undefined);
    const deleted = await replayOfflineSyncCommand(
      command('pending', 'preference.delete', 'preference'),
      handler(),
      { commands: dispatchers, quarantineUnsupported: quarantine },
    );
    const malformed = createOfflineSyncCommand({
      ownerUserId: 'owner-1', installationId: 'installation-1', deviceId: 'device-1',
      entityType: 'routine_task', entityId: 'entity-1', command: 'routine_task.update',
      intent: {}, normalizedResultPatch: {}, operationId: 'malformed-routine', nowMs: 1_000,
    });
    const malformedResult = await replayOfflineSyncCommand(
      malformed,
      handler(),
      { commands: dispatchers, quarantineUnsupported: quarantine },
    );
    expect(deleted).toEqual({ status: 'skipped', reason: 'unsupported' });
    expect(malformedResult).toEqual({ status: 'skipped', reason: 'unsupported' });
    expect(quarantine).toHaveBeenCalledTimes(2);
    expect(rpc.upsertUserPreferences).not.toHaveBeenCalled();
    expect(rpc.upsertRoutineTask).not.toHaveBeenCalled();
  });
  it('settles unknown commands without replay when reconciliation says settled', async () => {
    const retry = vi.fn().mockResolvedValue(true);
    const result = await replayOfflineSyncCommand(command('unknown'), handler({
      pushTask: retry,
      reconcileUnknownOutcome: vi.fn().mockResolvedValue('settled'),
    }));
    expect(result).toEqual({ status: 'acked' });
    expect(retry).not.toHaveBeenCalled();
  });

  it('keeps unknown commands unknown when reconciliation cannot decide', async () => {
    const retry = vi.fn().mockResolvedValue(true);
    const result = await replayOfflineSyncCommand(command('unknown'), handler({ pushTask: retry }));
    expect(result).toEqual({ status: 'unknown' });
    expect(retry).not.toHaveBeenCalled();
  });

  it('only resubmits an unknown command after reconciliation authorizes same-operation retry', async () => {
    const reconcileUnknownOutcome = vi.fn().mockResolvedValue('replay');
    const dispatch = vi.fn().mockResolvedValue({
      success: true,
      decision: 'idempotent-replay',
      rawResponse: { status: 'idempotent-replay', operationId: 'operation-unknown-task.update' },
    });
    const unknown = command('unknown', 'task.update');
    const result = await replayOfflineSyncCommand(unknown, handler(), {
      commands: { 'task.update': dispatch },
      reconcileUnknownOutcome,
      captureRemoteEvidence: true,
    });

    expect(reconcileUnknownOutcome).toHaveBeenCalledWith(unknown);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ operationId: unknown.operationId }));
    expect(result).toMatchObject({
      status: 'replayed', success: true, decision: 'idempotent-replay',
      rawResponse: { status: 'idempotent-replay', operationId: unknown.operationId },
    });
  });

  it('uses the specialized reconciler for non-RetryQueue entity commands', async () => {
    const dispatch = vi.fn().mockResolvedValue(true);
    const reconcileUnknownOutcome = vi.fn().mockResolvedValue('replay');
    const result = await replayOfflineSyncCommand(
      command('unknown', 'attachment.update'),
      handler(),
      { entities: { attachment: dispatch }, reconcileUnknownOutcome },
    );
    expect(reconcileUnknownOutcome).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(result).toEqual({ status: 'replayed', success: true });
  });
});
