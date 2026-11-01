import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../models';
import type { ProjectConflictLocalHandoffState, ProjectPayload, QueuedAction } from './action-queue.types';
import type {
  LocalHandoffQueueMutationResult,
  LocalHandoffTransitionInput,
} from './action-queue-held-action.controller';
import {
  createProjectConflictRecordFingerprint,
  type ProjectConflictLocalHandoffMutationResult,
  type ProjectConflictLocalHandoffReservationResult,
} from './conflict-storage.helpers';
import {
  ActionQueueProjectConflictHandoffRecoveryController,
  type ActionQueueProjectConflictHandoffRecoveryDeps,
  createActionQueueProjectConflictHandoffSettlement,
  createProjectConflictHandoffPayloadDigest,
  createProjectConflictHandoffReservationId,
  ProjectOperationConflictRetrySettlementController,
  type ProjectConflictRetrySettlementInput,
} from './project-operation-conflict-retry-settlement.controller';

type RecoveryLease = Awaited<ReturnType<ActionQueueProjectConflictHandoffRecoveryDeps['acquireLease']>>;

describe('ProjectOperationConflictRetrySettlementController', () => {
  it('commits snapshot and publication before completing conflict and removing A', async () => {
    const harness = createHarness();

    const result = await harness.controller.settle(harness.input);

    expect(result).toBe('complete');
    expect(harness.events).toEqual([
      'reserve-conflict',
      'action:required->reserved',
      'verify-reservation',
      'snapshot',
      'verify-reservation',
      'publish',
      'action:reserved->effects-applied',
      'conflict:reserved->effects-applied',
      'conflict:effects-applied->complete',
      'action:effects-applied->complete',
      'clear-conflict',
      'remove-action',
    ]);
    expect(harness.queueState()).toBeNull();
  });

  it('returns retry with zero effects when durable reservation is contended', async () => {
    const harness = createHarness();
    harness.reserveConflict.mockResolvedValueOnce({ status: 'contended' });

    const result = await harness.controller.settle(harness.input);

    expect(result).toBe('retry');
    expect(harness.reserveConflict).toHaveBeenCalledOnce();
    expect(harness.events).toEqual([]);
    expect(harness.queueState()).toBe('required');
    expect(harness.persistSnapshot).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it('stops after committed snapshot when the owner/session/Auth fence becomes stale', async () => {
    const harness = createHarness();
    harness.persistSnapshot.mockImplementationOnce(async () => {
      harness.events.push('snapshot');
      harness.setFenceCurrent(false);
      return true;
    });

    const result = await harness.controller.settle(harness.input);

    expect(result).toBe('stale');
    expect(harness.queueState()).toBe('reserved');
    expect(harness.publish).not.toHaveBeenCalled();
    expect(harness.events).toEqual([
      'reserve-conflict',
      'action:required->reserved',
      'verify-reservation',
      'snapshot',
    ]);
  });

  it('resumes effects-applied evidence without repeating snapshot or publication', async () => {
    const harness = createHarness({ queueState: 'effects-applied', conflictState: 'reserved' });

    const result = await harness.controller.settle(harness.input);

    expect(result).toBe('complete');
    expect(harness.persistSnapshot).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
    expect(harness.events).toEqual([
      'reserve-conflict',
      'action:required->reserved',
      'conflict:reserved->effects-applied',
      'conflict:effects-applied->complete',
      'action:effects-applied->complete',
      'clear-conflict',
      'remove-action',
    ]);
  });

  it('retains complete A when identity becomes stale after conflict clear and removes it on retry', async () => {
    const harness = createHarness();
    harness.clearConflict.mockImplementationOnce(async () => {
      harness.events.push('clear-conflict');
      harness.setFenceCurrent(false);
      return true;
    });

    await expect(harness.controller.settle(harness.input)).resolves.toBe('stale');
    expect(harness.queueState()).toBe('complete');
    expect(harness.removeAction).not.toHaveBeenCalled();

    harness.setFenceCurrent(true);
    harness.events.length = 0;
    await expect(harness.controller.settle(harness.input)).resolves.toBe('complete');
    expect(harness.events).toEqual(['reserve-conflict', 'action:required->reserved', 'remove-action']);
    expect(harness.queueState()).toBeNull();
  });

  it('composes the ActionQueue lease fence before publication and removal', async () => {
    let leaseCurrent = true;
    const resolvedProject = project();
    const reservationId = createProjectConflictHandoffReservationId(
      'operation-a', 'payload-a', 'fingerprint-a',
    );
    const action: QueuedAction = {
      id: 'action-a', operationId: 'operation-a', type: 'update', entityType: 'project',
      entityId: 'project-a', payload: { project: resolvedProject, sourceUserId: 'owner-a' },
      timestamp: 1, syncState: 'syncing', retryCount: 0,
      localHandoff: {
        kind: 'resolved-project-conflict', state: 'required', ownerUserId: 'owner-a',
        projectId: 'project-a', actionId: 'action-a', operationId: 'operation-a',
        payloadDigest: 'payload-a', conflictFingerprint: 'fingerprint-a',
      },
    };
    const publish = vi.fn();
    const remove = vi.fn(async () => ({ status: 'committed' as const }));
    const settle = createActionQueueProjectConflictHandoffSettlement({
      isFenceCurrent: () => true,
      getCurrentProjects: () => [resolvedProject],
      getPendingProjectActions: () => [],
      persistProjects: async () => { leaseCurrent = false; },
      publishProjects: publish,
      reserveConflictLocalHandoff: vi.fn(async () => ({
        status: 'committed' as const, reservationId,
      })),
      transitionActionLocalHandoff: vi.fn(async input => ({
        status: 'committed' as const,
        action: {
          ...action,
          localHandoff: { ...action.localHandoff!, state: input.nextState, reservationId },
        },
      })),
      verifyConflictReservation: vi.fn(async () => ({ status: 'committed' as const })),
      advanceConflictLocalHandoff: vi.fn(async () => ({ status: 'committed' as const })),
      clearCompletedConflict: vi.fn(async () => ({ status: 'committed' as const })),
      removeCompletedAction: remove,
      now: () => '2026-07-29T00:10:00.000Z',
    });

    const result = await settle({
      action, resolvedProject, ownerUserId: 'owner-a', sessionGeneration: 7,
      authFence: 'opaque-fence-a', queueViewGeneration: 1, projectMutationViewGeneration: 1,
    }, () => leaseCurrent);

    expect(result).toBe('stale');
    expect(publish).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('rechecks the fence before reserved action effects publication is recorded', async () => {
    const harness = createHarness();
    harness.publish.mockImplementationOnce(() => {
      harness.events.push('publish');
      queueMicrotask(() => harness.setFenceCurrent(false));
    });

    await expect(harness.controller.settle(harness.input)).resolves.toBe('stale');

    expect(harness.events).not.toContain('action:reserved->effects-applied');
    expect(harness.queueState()).toBe('reserved');
  });

  it('rechecks the fence before completed conflict is recorded on the action', async () => {
    const harness = createHarness({ queueState: 'effects-applied', conflictState: 'reserved' });
    let current = true;
    let checks = 0;
    harness.setFenceReader(() => {
      if (++checks === 5) queueMicrotask(() => { current = false; });
      return current;
    });

    await expect(harness.controller.settle(harness.input)).resolves.toBe('stale');

    expect(harness.events).not.toContain('action:effects-applied->complete');
    expect(harness.queueState()).toBe('effects-applied');
  });

  it('does not persist or activate malformed held evidence during reload recovery', async () => {
    const resolvedProject = project();
    const conflictRecord = {
      projectId: resolvedProject.id, ownerUserId: 'owner-a', localProject: resolvedProject,
      remoteSnapshotFresh: false, conflictedAt: '2026-07-29T00:00:00.000Z',
      localVersion: 5, reason: 'version_mismatch' as const, acknowledged: false,
    };
    const payload: ProjectPayload = {
      project: resolvedProject, sourceUserId: 'owner-a',
      conflictHandoff: { conflictRecord },
    };
    const action: QueuedAction<ProjectPayload> = {
      id: 'action-a', operationId: 'operation-a', type: 'update', entityType: 'project',
      entityId: resolvedProject.id, payload, timestamp: 1, syncState: 'held', retryCount: 0,
      localHandoff: {
        kind: 'resolved-project-conflict', state: 'required', ownerUserId: 'owner-a',
        projectId: resolvedProject.id, actionId: 'action-a', operationId: 'operation-a',
        payloadDigest: 'tampered-digest',
        conflictFingerprint: createProjectConflictRecordFingerprint(conflictRecord),
      },
    };
    const persistRequirement = vi.fn(async () => ({ status: 'committed' as const }));
    const activateHandoff = vi.fn(async () => ({ status: 'committed' as const }));
    const processQueue = vi.fn(async () => undefined);
    const recovery = new ActionQueueProjectConflictHandoffRecoveryController({
      isOwnerStorageLoaded: () => true, getCurrentOwnerUserId: () => 'owner-a',
      getSessionGeneration: () => 7, captureAuthFence: () => 'opaque-fence-a',
      getQueueViewGeneration: () => 1, isSessionContextCurrent: () => true,
      isQueueViewCurrent: () => true, getPendingActions: () => [action],
      acquireLease: async () => ({
        mode: 'idb-lease', signal: new AbortController().signal, release: async () => undefined,
      }),
      reserveConflictHandoff: vi.fn(), transitionActionHandoff: vi.fn(),
      verifyConflictReservation: vi.fn(),
      persistRequirement, activateHandoff, processQueue,
      scheduleRetry: callback => callback, clearRetry: vi.fn(),
      now: () => '2026-07-29T00:10:00.000Z',
    });

    recovery.request();
    await Promise.resolve();
    await Promise.resolve();

    expect(persistRequirement).not.toHaveBeenCalled();
    expect(activateHandoff).not.toHaveBeenCalled();
    expect(processQueue).not.toHaveBeenCalled();
  });

  it('durably reserves missing held evidence before activation and scheduling', async () => {
    const harness = createRecoveryHarness('missing');

    harness.recovery.request();
    await vi.waitFor(() => expect(harness.processQueue).toHaveBeenCalledOnce());

    expect(harness.events).toEqual(['requirement', 'reserve-conflict', 'reserve-action', 'activate', 'process']);
    expect(harness.action.localHandoff?.reservationId).toBe(harness.canonicalReservationId);
    expect(harness.transitionAction).toHaveBeenCalledWith(expect.objectContaining({
      expectedState: 'required', nextState: 'reserved', reservationId: harness.canonicalReservationId,
    }));
    expect(harness.release.mock.invocationCallOrder[0])
      .toBeLessThan(harness.processQueue.mock.invocationCallOrder[0]);
  });

  it('verifies canonical reserved evidence and activates it without rewriting reservation', async () => {
    const harness = createRecoveryHarness('canonical');

    harness.recovery.request();
    await vi.waitFor(() => expect(harness.processQueue).toHaveBeenCalledOnce());

    expect(harness.verifyConflict).toHaveBeenCalledOnce();
    expect(harness.persistRequirement).not.toHaveBeenCalled();
    expect(harness.reserveConflict).not.toHaveBeenCalled();
    expect(harness.transitionAction).not.toHaveBeenCalled();
    expect(harness.action.localHandoff?.reservationId).toBe(harness.canonicalReservationId);
  });

  it('verifies canonical pending sync evidence before processing after lease release', async () => {
    const harness = createRecoveryHarness('canonical', 'pending_sync');
    let resolveVerification!: (result: ProjectConflictLocalHandoffMutationResult) => void;
    const verification = new Promise<ProjectConflictLocalHandoffMutationResult>(resolve => {
      resolveVerification = resolve;
    });
    harness.verifyConflict.mockImplementationOnce(() => verification);

    harness.recovery.request();
    await vi.waitFor(() => expect(harness.verifyConflict).toHaveBeenCalledOnce());

    expect(harness.processQueue).not.toHaveBeenCalled();
    resolveVerification({ status: 'committed' });
    await vi.waitFor(() => expect(harness.processQueue).toHaveBeenCalledOnce());

    expect(harness.verifyConflict).toHaveBeenCalledWith(expect.objectContaining({
      actionId: harness.action.id,
      operationId: harness.action.operationId,
      reservationId: harness.canonicalReservationId,
    }));
    expect(harness.transitionAction).not.toHaveBeenCalled();
    expect(harness.activateHandoff).not.toHaveBeenCalled();
    expect(harness.release.mock.invocationCallOrder[0])
      .toBeLessThan(harness.processQueue.mock.invocationCallOrder[0]);
  });

  it('processes canonical complete evidence after conflict clear without reservation verification', async () => {
    const harness = createRecoveryHarness('canonical', 'pending_sync', 'complete');
    harness.verifyConflict.mockResolvedValueOnce({ status: 'missing' });

    harness.recovery.request();
    await vi.waitFor(() => expect(harness.processQueue).toHaveBeenCalledOnce());

    expect(harness.verifyConflict).not.toHaveBeenCalled();
    expect(harness.transitionAction).not.toHaveBeenCalled();
    expect(harness.activateHandoff).not.toHaveBeenCalled();
    expect(harness.release.mock.invocationCallOrder[0])
      .toBeLessThan(harness.processQueue.mock.invocationCallOrder[0]);
  });

  it('blocks noncanonical complete evidence without processing or removal routing', async () => {
    const harness = createRecoveryHarness('noncanonical', 'pending_sync', 'complete');

    harness.recovery.request();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.verifyConflict).not.toHaveBeenCalled();
    expect(harness.processQueue).not.toHaveBeenCalled();
  });

  it('still blocks effects-applied replay when its persisted reservation is missing', async () => {
    const harness = createRecoveryHarness('canonical', 'pending_sync', 'effects-applied');
    harness.verifyConflict.mockResolvedValueOnce({ status: 'missing' });

    harness.recovery.request();
    await vi.waitFor(() => expect(harness.verifyConflict).toHaveBeenCalledOnce());

    expect(harness.processQueue).not.toHaveBeenCalled();
  });

  it('blocks terminal scheduling when the owner fence drifts during lease release', async () => {
    const harness = createRecoveryHarness('canonical', 'pending_sync', 'complete');
    harness.release.mockImplementationOnce(async () => {
      harness.setCurrent(false);
    });

    harness.recovery.request();
    await vi.waitFor(() => expect(harness.release).toHaveBeenCalledOnce());

    expect(harness.processQueue).not.toHaveBeenCalled();
  });

  it.each(['missing', 'identity-mismatch', 'contended'] as const)(
    'blocks pending sync replay when persisted reservation verification is %s',
    async status => {
      const harness = createRecoveryHarness('canonical', 'pending_sync');
      harness.verifyConflict.mockResolvedValueOnce({ status });

      harness.recovery.request();
      await vi.waitFor(() => expect(harness.verifyConflict).toHaveBeenCalledOnce());
      await Promise.resolve();

      expect(harness.processQueue).not.toHaveBeenCalled();
      expect(harness.transitionAction).not.toHaveBeenCalled();
      expect(harness.activateHandoff).not.toHaveBeenCalled();
      expect(harness.retryCallbacks).toHaveLength(0);
    },
  );

  it('blocks pending sync replay with a noncanonical queue reservation', async () => {
    const harness = createRecoveryHarness('noncanonical', 'pending_sync', 'reserved');

    harness.recovery.request();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.verifyConflict).not.toHaveBeenCalled();
    expect(harness.processQueue).not.toHaveBeenCalled();
    expect(harness.transitionAction).not.toHaveBeenCalled();
    expect(harness.activateHandoff).not.toHaveBeenCalled();
  });

  it.each(['auth', 'lease'] as const)(
    'stops pending sync replay when %s drifts across reservation verification',
    async drift => {
      const harness = createRecoveryHarness('canonical', 'pending_sync');
      let resolveVerification!: (result: ProjectConflictLocalHandoffMutationResult) => void;
      const verification = new Promise<ProjectConflictLocalHandoffMutationResult>(resolve => {
        resolveVerification = resolve;
      });
      harness.verifyConflict.mockImplementationOnce(() => verification);

      harness.recovery.request();
      await vi.waitFor(() => expect(harness.verifyConflict).toHaveBeenCalledOnce());
      if (drift === 'auth') harness.setAuthFence('opaque-fence-b');
      else harness.abortLease();
      resolveVerification({ status: 'committed' });
      await vi.waitFor(() => expect(harness.release).toHaveBeenCalledOnce());

      expect(harness.processQueue).not.toHaveBeenCalled();
      expect(harness.transitionAction).not.toHaveBeenCalled();
      expect(harness.activateHandoff).not.toHaveBeenCalled();
    },
  );

  it('resumes once after identity changes between durable reservation and activation', async () => {
    const harness = createRecoveryHarness('missing');
    harness.transitionAction.mockImplementationOnce(async input => {
      const result = await harness.commitTransition(input);
      harness.setCurrent(false);
      return result;
    });

    harness.recovery.request();
    await vi.waitFor(() => expect(harness.transitionAction).toHaveBeenCalledOnce());
    expect(harness.activateHandoff).not.toHaveBeenCalled();
    harness.setCurrent(true);
    harness.recovery.request();
    await vi.waitFor(() => expect(harness.processQueue).toHaveBeenCalledOnce());

    expect(harness.activateHandoff).toHaveBeenCalledOnce();
    expect(harness.transitionAction).toHaveBeenCalledOnce();
    expect(harness.verifyConflict).toHaveBeenCalledOnce();
  });

  it.each(['requirement', 'conflict reservation', 'action reservation'] as const)(
    'retains missing held evidence when %s persistence fails',
    async stage => {
      const harness = createRecoveryHarness('missing');
      if (stage === 'requirement') harness.persistRequirement.mockResolvedValueOnce({ status: 'storage-failed' });
      if (stage === 'conflict reservation') harness.reserveConflict.mockResolvedValueOnce({ status: 'storage-failed' });
      if (stage === 'action reservation') harness.transitionAction.mockResolvedValueOnce({ status: 'storage-failed' });

      harness.recovery.request();
      await vi.waitFor(() => expect(harness.persistRequirement).toHaveBeenCalledOnce());
      await Promise.resolve();

      expect(harness.activateHandoff).not.toHaveBeenCalled();
      expect(harness.processQueue).not.toHaveBeenCalled();
      expect(harness.retryCallbacks).toHaveLength(1);
    },
  );

  it('retains required evidence when the conflict reservation is missing', async () => {
    const harness = createRecoveryHarness('missing');
    harness.reserveConflict.mockResolvedValueOnce({ status: 'missing' });

    harness.recovery.request();
    await vi.waitFor(() => expect(harness.reserveConflict).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(harness.transitionAction).not.toHaveBeenCalled();
    expect(harness.activateHandoff).not.toHaveBeenCalled();
    expect(harness.processQueue).not.toHaveBeenCalled();
    expect(harness.retryCallbacks).toHaveLength(0);
  });

  it.each(['null', 'memory-only', 'missing-signal'] as const)(
    'coalesces one delayed retry when recovery lease is %s',
    async leaseFailure => {
      const harness = createRecoveryHarness('missing');
      harness.acquireLease.mockResolvedValue(leaseFailure === 'null' ? null : {
        mode: leaseFailure === 'memory-only' ? 'memory-only' : 'idb-lease',
        signal: leaseFailure === 'missing-signal' ? undefined : new AbortController().signal,
        release: harness.release,
      });

      harness.recovery.request();
      harness.recovery.request();
      await vi.waitFor(() => expect(harness.retryCallbacks).toHaveLength(1));

      expect(harness.persistRequirement).not.toHaveBeenCalled();
      expect(harness.processQueue).not.toHaveBeenCalled();
      if (leaseFailure !== 'null') expect(harness.release).toHaveBeenCalledOnce();
    },
  );

  it('destroy clears a pending retry and makes its captured callback inert', async () => {
    const harness = createRecoveryHarness('missing');
    harness.acquireLease.mockResolvedValueOnce(null);
    harness.recovery.request();
    await vi.waitFor(() => expect(harness.retryCallbacks).toHaveLength(1));
    const retry = harness.retryCallbacks[0]!;

    harness.recovery.destroy();
    retry();
    await Promise.resolve();

    expect(harness.clearRetry).toHaveBeenCalledOnce();
    expect(harness.acquireLease).toHaveBeenCalledOnce();
  });

  it('never rewrites a supplied noncanonical reservation during recovery', async () => {
    const harness = createRecoveryHarness('noncanonical');

    harness.recovery.request();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.persistRequirement).not.toHaveBeenCalled();
    expect(harness.reserveConflict).not.toHaveBeenCalled();
    expect(harness.transitionAction).not.toHaveBeenCalled();
    expect(harness.activateHandoff).not.toHaveBeenCalled();
  });
});

function createRecoveryHarness(
  reservation: 'missing' | 'canonical' | 'noncanonical' = 'missing',
  syncState: QueuedAction['syncState'] = 'held',
  handoffState?: ProjectConflictLocalHandoffState,
) {
  const resolvedProject = project();
  const conflictRecord = {
    projectId: resolvedProject.id, ownerUserId: 'owner-a', localProject: resolvedProject,
    remoteSnapshotFresh: false, conflictedAt: '2026-07-29T00:00:00.000Z',
    localVersion: 5, reason: 'version_mismatch' as const, acknowledged: false,
  };
  const payload: ProjectPayload = {
    project: resolvedProject, sourceUserId: 'owner-a', conflictHandoff: { conflictRecord },
  };
  const payloadDigest = createProjectConflictHandoffPayloadDigest(payload);
  const conflictFingerprint = createProjectConflictRecordFingerprint(conflictRecord);
  const canonicalReservationId = createProjectConflictHandoffReservationId(
    'operation-a', payloadDigest, conflictFingerprint,
  );
  const action: QueuedAction<ProjectPayload> = {
    id: 'action-a', operationId: 'operation-a', type: 'update', entityType: 'project',
    entityId: resolvedProject.id, payload, timestamp: 1, syncState, retryCount: 0,
    localHandoff: {
      kind: 'resolved-project-conflict',
      state: handoffState ?? (reservation === 'canonical' ? 'reserved' : 'required'),
      ownerUserId: 'owner-a',
      projectId: resolvedProject.id, actionId: 'action-a', operationId: 'operation-a',
      payloadDigest, conflictFingerprint,
      ...(reservation === 'canonical' ? { reservationId: canonicalReservationId }
        : reservation === 'noncanonical' ? { reservationId: 'noncanonical' } : {}),
    },
  };
  const events: string[] = [];
  let current = true;
  let authFence = 'opaque-fence-a';
  const persistRequirement = vi.fn(async (): Promise<ProjectConflictLocalHandoffMutationResult> => {
    events.push('requirement');
    return { status: 'committed' as const };
  });
  const reserveConflict = vi.fn(async (
    input: { reservationId: string },
  ): Promise<ProjectConflictLocalHandoffReservationResult> => {
    events.push('reserve-conflict');
    return { status: 'committed' as const, reservationId: input.reservationId };
  });
  const verifyConflict = vi.fn(async (): Promise<ProjectConflictLocalHandoffMutationResult> => {
    events.push('verify-conflict');
    return { status: 'committed' as const };
  });
  const commitTransition = async (
    input: LocalHandoffTransitionInput,
  ): Promise<LocalHandoffQueueMutationResult> => {
    events.push('reserve-action');
    action.localHandoff = {
      ...action.localHandoff!, state: input.nextState, reservationId: input.reservationId,
    };
    return { status: 'committed' as const, action };
  };
  const transitionAction = vi.fn(commitTransition);
  const activateHandoff = vi.fn(async (): Promise<LocalHandoffQueueMutationResult> => {
    events.push('activate');
    action.syncState = 'pending_sync';
    return { status: 'committed' as const, action };
  });
  const processQueue = vi.fn(async () => { events.push('process'); });
  const release = vi.fn(async () => undefined);
  const leaseController = new AbortController();
  const acquireLease = vi.fn(async (): Promise<RecoveryLease> => ({
    mode: 'idb-lease' as const, signal: leaseController.signal, release,
  }));
  const retryCallbacks: Array<() => void> = [];
  const scheduleRetry = vi.fn((callback: () => void) => {
    retryCallbacks.push(callback);
    return callback;
  });
  const clearRetry = vi.fn();
  const recovery = new ActionQueueProjectConflictHandoffRecoveryController({
    isOwnerStorageLoaded: () => true,
    getCurrentOwnerUserId: () => current ? 'owner-a' : 'owner-b',
    getSessionGeneration: () => 7, captureAuthFence: () => authFence,
    getQueueViewGeneration: () => 1, isSessionContextCurrent: () => true,
    isQueueViewCurrent: () => true, getPendingActions: () => [action],
    acquireLease,
    persistRequirement, reserveConflictHandoff: reserveConflict,
    transitionActionHandoff: transitionAction, verifyConflictReservation: verifyConflict,
    activateHandoff, processQueue, scheduleRetry, clearRetry,
    now: () => '2026-07-29T00:10:00.000Z',
  });
  return {
    recovery, action, canonicalReservationId, events, persistRequirement,
    reserveConflict, verifyConflict, transitionAction, activateHandoff, processQueue,
    acquireLease, release, retryCallbacks, clearRetry, commitTransition,
    setCurrent: (value: boolean) => { current = value; },
    setAuthFence: (value: string) => { authFence = value; },
    abortLease: () => leaseController.abort(),
  };
}

function createHarness(options: {
  queueState?: ProjectConflictLocalHandoffState;
  conflictState?: ProjectConflictLocalHandoffState | null;
} = {}) {
  const events: string[] = [];
  let queueState: ProjectConflictLocalHandoffState | null = options.queueState ?? 'required';
  let conflictState: ProjectConflictLocalHandoffState | null = options.conflictState ?? 'required';
  let fenceCurrent = true;
  let fenceReader = () => fenceCurrent;
  const input: ProjectConflictRetrySettlementInput = {
    ownerUserId: 'owner-a', sessionGeneration: 7, authFence: 'opaque-fence-a',
    projectId: 'project-a', actionId: 'action-a', operationId: 'operation-a',
    payloadDigest: 'payload-a', conflictFingerprint: 'fingerprint-a',
    resolvedProject: project(), reservationId: 'reservation-a',
  };
  const action = (): QueuedAction => ({
    id: input.actionId,
    operationId: input.operationId,
    type: 'update',
    entityType: 'project',
    entityId: input.projectId,
    payload: { project: input.resolvedProject, sourceUserId: input.ownerUserId },
    timestamp: 1,
    syncState: 'held',
    retryCount: 0,
    localHandoff: queueState ? {
      kind: 'resolved-project-conflict', state: queueState,
      ownerUserId: input.ownerUserId, projectId: input.projectId,
      actionId: input.actionId, operationId: input.operationId,
      payloadDigest: input.payloadDigest, conflictFingerprint: input.conflictFingerprint,
      reservationId: queueState === 'required' ? undefined : input.reservationId,
    } : undefined,
  });
  const reserveConflict = vi.fn(async (): Promise<ProjectConflictLocalHandoffReservationResult> => {
    events.push('reserve-conflict');
    if (conflictState === null && queueState === 'complete') {
      return { status: 'missing' as const };
    }
    if (conflictState === 'required') conflictState = 'reserved';
    return { status: 'committed' as const, reservationId: input.reservationId };
  });
  const transitionAction = vi.fn(async (transition: {
    expectedState: ProjectConflictLocalHandoffState;
    nextState: ProjectConflictLocalHandoffState;
  }) => {
    events.push(`action:${transition.expectedState}->${transition.nextState}`);
    if (queueState === null) return { status: 'missing' as const };
    const rank = ['required', 'reserved', 'effects-applied', 'complete'];
    if (rank.indexOf(queueState) <= rank.indexOf(transition.nextState)) {
      queueState = transition.nextState;
    }
    return { status: 'committed' as const, action: action() };
  });
  const verifyReservation = vi.fn(async () => {
    events.push('verify-reservation');
    return { status: 'committed' as const };
  });
  const advanceConflict = vi.fn(async (transition: {
    expectedState: 'reserved' | 'effects-applied';
    nextState: 'effects-applied' | 'complete';
  }) => {
    events.push(`conflict:${transition.expectedState}->${transition.nextState}`);
    conflictState = transition.nextState;
    return { status: 'committed' as const };
  });
  const persistSnapshot = vi.fn(async () => {
    events.push('snapshot');
    return true;
  });
  const publish = vi.fn((): void => void events.push('publish'));
  const clearConflict = vi.fn(async () => {
    events.push('clear-conflict');
    conflictState = null;
    return true;
  });
  const removeAction = vi.fn(async () => {
    events.push('remove-action');
    queueState = null;
    return { status: 'committed' as const };
  });
  const controller = new ProjectOperationConflictRetrySettlementController({
    isFenceCurrent: () => fenceReader(),
    reserveConflictLocalHandoff: reserveConflict,
    transitionActionLocalHandoff: transitionAction,
    verifyConflictReservation: verifyReservation,
    advanceConflictLocalHandoff: advanceConflict,
    persistOwnerSnapshot: persistSnapshot,
    publishResolvedProject: publish,
    clearCompletedConflict: clearConflict,
    removeCompletedAction: removeAction,
    now: () => '2026-07-29T00:10:00.000Z',
  });
  return {
    controller, input, events, reserveConflict, persistSnapshot, publish,
    clearConflict, removeAction,
    queueState: () => queueState,
    setFenceCurrent: (current: boolean) => { fenceCurrent = current; },
    setFenceReader: (reader: () => boolean) => { fenceReader = reader; },
  };
}

function project(): Project {
  return {
    id: 'project-a', name: 'Resolved', description: '',
    createdDate: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z', version: 5,
    tasks: [], connections: [],
  };
}
