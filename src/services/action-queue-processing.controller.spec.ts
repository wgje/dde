import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionQueueLifecycleController } from './action-queue-lifecycle.controller';
import {
  ActionQueueProcessingController,
  type ActionQueueProcessingControllerDeps,
} from './action-queue-processing.controller';
import type { ActionQueueTransitionReason } from './action-queue-durable-removal.controller';
import type { QueueProcessor } from './action-queue-processing.types';
import { createMockAction } from './action-queue-storage.spec-helpers';
import type { QueuedAction } from './action-queue.types';

type TraceSpy = ReturnType<typeof vi.fn>;

interface HarnessOptions {
  online?: boolean;
  processing?: boolean;
  writeGuardBlocked?: boolean;
  deferQueueProcessing?: boolean;
  leaseRequired?: boolean;
  leaseUnavailable?: boolean;
  leaseMemoryOnly?: boolean;
  stale?: boolean;
  persistenceFence?: boolean;
  transitionNull?: boolean;
  transitionReason?: 'missing-signal' | 'aborted' | 'stale-current' | 'missing-owner-strict-update'
    | 'identity-mismatch' | 'already-syncing' | 'state-not-transitionable' | 'persistence-failed';
  settleNull?: boolean;
  processorRejects?: boolean;
  withProcessor?: boolean;
}

function createHarness(options: HarnessOptions = {}): {
  controller: ActionQueueProcessingController;
  deps: ActionQueueProcessingControllerDeps;
  action: QueuedAction;
  processor: ReturnType<typeof vi.fn>;
} {
  const action = createMockAction();
  const pendingActions = signal<QueuedAction[]>([]);
  const isProcessing = signal(options.processing ?? false);
  const processor = vi.fn(async () => true);
  const transitionToSyncing = vi.fn(async (candidate: QueuedAction) => options.transitionNull ? null : candidate);
  const getLastQueueTransitionReason = vi.fn((): ActionQueueTransitionReason | null =>
    options.transitionNull ? (options.transitionReason ?? null) : null);
  const settleSuccessfulAction = vi.fn(async () => !options.settleNull);
  const processors = new Map<string, QueueProcessor>();
  if (options.withProcessor) {
    processors.set('task:update', processor);
  }

  const deps = {
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    },
    toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() },
    sentryLazyLoader: { addBreadcrumb: vi.fn() },
    storage: {
      isOnline: options.online ?? true,
      shouldDeferQueueProcessing: () => options.deferQueueProcessing ?? false,
      requestQueueProcessing: vi.fn(),
      handleRetryDurably: vi.fn(async () => 'retry'),
      moveToDeadLetter: vi.fn(),
      pauseDependentActions: vi.fn(),
      scheduleRetry: vi.fn(),
    },
    syncWriterLeaseGate: {
      isRequired: () => options.leaseRequired ?? true,
      acquire: vi.fn(async () => {
        if (options.leaseUnavailable) return null;
        return {
          mode: options.leaseMemoryOnly ? 'memory-only' : 'idb-lease',
          signal: new AbortController().signal,
          release: vi.fn(async () => undefined),
        };
      }),
    },
    writeGuard: options.writeGuardBlocked
      ? { assertWritable: vi.fn(() => false) }
      : null,
    queueViewState: {
      currentQueueViewGeneration: 1,
      isStaleProcess: () => options.stale ?? false,
      getStaleProcessPolicy: vi.fn(() => 'settle-owner'),
    },
    lifecycle: new ActionQueueLifecycleController(),
    pendingActions,
    isProcessing,
    processors,
    isProcessorRegistrationReady: () => true,
    getCurrentOwnerUserId: () => 'test-user',
    createPersistenceFence: () => () => options.persistenceFence ?? true,
    transitionToSyncing,
    getLastQueueTransitionReason,
    settleSuccessfulAction,
  } as unknown as ActionQueueProcessingControllerDeps;

  return {
    controller: new ActionQueueProcessingController(deps),
    deps,
    action,
    processor,
  };
}

function traceCalls(traceSpy: TraceSpy): Array<{ event: string; data?: unknown }> {
  return traceSpy.mock.calls.map(call => ({
    event: String(call[0]),
    data: call[1],
  }));
}

function installTraceSpy(): TraceSpy {
  const traceSpy = vi.fn();
  Object.defineProperty(window, '__NANOFLOW_PUSH_STARTUP_TRACE__', {
    value: traceSpy,
    configurable: true,
  });
  return traceSpy;
}

function clearTraceSpy(): void {
  delete (window as Window & { __NANOFLOW_PUSH_STARTUP_TRACE__?: unknown })
    .__NANOFLOW_PUSH_STARTUP_TRACE__;
}

describe('ActionQueueProcessingController trace boundary', () => {
  let traceSpy: TraceSpy;

  beforeEach(() => {
    traceSpy = installTraceSpy();
  });

  afterEach(() => {
    clearTraceSpy();
  });

  it.each([
    ['already-processing', { processing: true }],
    ['offline', { online: false }],
    ['write-guard-blocked', { writeGuardBlocked: true }],
    ['defer-queue-processing', { deferQueueProcessing: true }],
    ['lease-retry-later', { leaseRequired: true, leaseUnavailable: true }],
    ['lease-unavailable', { leaseRequired: false, leaseUnavailable: true }],
  ] as const)('records processing_early_return for %s', async (reason, options) => {
    const { controller } = createHarness(options);

    const result = await controller.processQueue();

    expect(result).toEqual({ processed: 0, failed: 0, movedToDeadLetter: 0 });
    expect(traceCalls(traceSpy)).toContainEqual({
      event: 'action_queue.processing_invoked',
      data: undefined,
    });
    expect(traceCalls(traceSpy)).toContainEqual({
      event: 'action_queue.processing_early_return',
      data: { reason },
    });
  });

  it('records processing_begun, processor reach and final success counts', async () => {
    const { controller, deps, action, processor } = createHarness({ withProcessor: true });
    deps.pendingActions.set([action]);

    const result = await controller.processQueue();

    expect(result).toEqual({ processed: 1, failed: 0, movedToDeadLetter: 0 });
    expect(processor).toHaveBeenCalledTimes(1);
    expect(deps.settleSuccessfulAction).toHaveBeenCalledTimes(1);
    expect(traceCalls(traceSpy).map(entry => entry.event)).toEqual([
      'action_queue.processing_invoked',
      'action_queue.processing_begun',
      'action_queue.processing_processor_invoked',
      'action_queue.processing_processor_resolved',
      'action_queue.processing_processor_finished',
    ]);
    expect(traceCalls(traceSpy)).toContainEqual({
      event: 'action_queue.processing_processor_resolved',
      data: expect.objectContaining({ outcome: 'success', processorKey: 'task:update' }),
    });
  });

  it('records missing processor once without invoking a processor', async () => {
    const { controller, deps, action, processor } = createHarness();
    deps.pendingActions.set([action]);

    const result = await controller.processQueue();

    expect(result).toEqual({ processed: 0, failed: 1, movedToDeadLetter: 0 });
    expect(processor).not.toHaveBeenCalled();
    expect(traceCalls(traceSpy)).toContainEqual({
      event: 'action_queue.processing_missing_processor',
      data: { processorKey: 'task:update' },
    });
  });

  it('records transition null before processor invocation', async () => {
    const { controller, deps, action, processor } = createHarness({ withProcessor: true, transitionNull: true });
    deps.pendingActions.set([action]);

    const result = await controller.processQueue();

    expect(result).toEqual({ processed: 0, failed: 0, movedToDeadLetter: 0 });
    expect(processor).not.toHaveBeenCalled();
    expect(traceCalls(traceSpy)).toContainEqual({
      event: 'action_queue.processing_transition_null',
      data: expect.objectContaining({ entityType: 'task', actionType: 'update' }),
    });
    expect(traceCalls(traceSpy)).toContainEqual({
      event: 'action_queue.processing_transition_null',
      data: expect.objectContaining({ transitionReason: null }),
    });
  });

  it.each<ActionQueueTransitionReason>([
    'missing-signal',
    'aborted',
    'stale-current',
    'missing-owner-strict-update',
    'identity-mismatch',
    'already-syncing',
    'state-not-transitionable',
    'persistence-failed',
  ])('forwards bounded transition reason %s into transition null trace data', async reason => {
    const { controller, deps, action, processor } = createHarness({
      withProcessor: true,
      transitionNull: true,
      transitionReason: reason,
    });
    deps.pendingActions.set([action]);

    const result = await controller.processQueue();

    expect(result).toEqual({ processed: 0, failed: 0, movedToDeadLetter: 0 });
    expect(processor).not.toHaveBeenCalled();
    expect(traceCalls(traceSpy)).toContainEqual({
      event: 'action_queue.processing_transition_null',
      data: expect.objectContaining({ transitionReason: reason }),
    });
  });

  it('records stale processor fence before processor invocation', async () => {
    const { controller, deps, action, processor } = createHarness({ withProcessor: true, persistenceFence: false });
    deps.pendingActions.set([action]);

    const result = await controller.processQueue();

    expect(result).toEqual({ processed: 0, failed: 0, movedToDeadLetter: 0 });
    expect(processor).not.toHaveBeenCalled();
    expect(traceCalls(traceSpy)).toContainEqual({
      event: 'action_queue.processing_fence_stale',
      data: expect.objectContaining({ entityType: 'task', actionType: 'update' }),
    });
  });

  it('records processor rejection and final failure count', async () => {
    const { controller, deps, action, processor } = createHarness({ withProcessor: true });
    processor.mockRejectedValue(new Error('sync failed'));
    deps.pendingActions.set([action]);

    const result = await controller.processQueue();

    expect(result).toEqual({ processed: 0, failed: 1, movedToDeadLetter: 0 });
    expect(processor).toHaveBeenCalledTimes(1);
    expect(traceCalls(traceSpy)).toContainEqual({
      event: 'action_queue.processing_processor_rejected',
      data: expect.objectContaining({ processorKey: 'task:update' }),
    });
    expect(traceCalls(traceSpy)).toContainEqual({
      event: 'action_queue.processing_processor_finished',
      data: expect.objectContaining({ processorKey: 'task:update' }),
    });
  });

  it('records settle null when successful settlement is rejected', async () => {
    const { controller, deps, action, processor } = createHarness({ withProcessor: true, settleNull: true });
    deps.pendingActions.set([action]);

    const result = await controller.processQueue();

    expect(result).toEqual({ processed: 1, failed: 0, movedToDeadLetter: 0 });
    expect(processor).toHaveBeenCalledTimes(1);
    expect(traceCalls(traceSpy)).toContainEqual({
      event: 'action_queue.processing_settle_null',
      data: expect.objectContaining({ entityType: 'task', actionType: 'update' }),
    });
  });

  it('records skipped action for a held queue item', async () => {
    const { controller, deps, action, processor } = createHarness({ withProcessor: true });
    deps.pendingActions.set([{ ...action, syncState: 'held' }]);

    const result = await controller.processQueue();

    expect(result).toEqual({ processed: 0, failed: 0, movedToDeadLetter: 0 });
    expect(processor).not.toHaveBeenCalled();
    expect(traceCalls(traceSpy)).toContainEqual({
      event: 'action_queue.processing_action_skipped',
      data: expect.objectContaining({ entityType: 'task', actionType: 'update' }),
    });
  });

  it('records stale stop before processing a queue item', async () => {
    const { controller, deps, action, processor } = createHarness({ withProcessor: true, stale: true });
    deps.pendingActions.set([action]);

    const result = await controller.processQueue();

    expect(result).toEqual({ processed: 0, failed: 0, movedToDeadLetter: 0 });
    expect(processor).not.toHaveBeenCalled();
    expect(traceCalls(traceSpy)).toContainEqual({
      event: 'action_queue.processing_stale_stop',
      data: expect.objectContaining({ entityType: 'task', actionType: 'update' }),
    });
  });

  it('records local handoff stop when lease is memory-only', async () => {
    const { controller, deps, action, processor } = createHarness({
      withProcessor: true,
      leaseRequired: false,
      leaseMemoryOnly: true,
    });
    deps.pendingActions.set([{
      ...action,
      localHandoff: {
        kind: 'resolved-project-conflict',
        state: 'reserved',
        ownerUserId: 'owner-1',
        projectId: 'project-1',
        actionId: action.id,
        operationId: action.operationId,
        payloadDigest: 'payload-digest-1',
        conflictFingerprint: 'conflict-1',
      },
    }]);

    const result = await controller.processQueue();

    expect(result).toEqual({ processed: 0, failed: 0, movedToDeadLetter: 0 });
    expect(processor).not.toHaveBeenCalled();
    expect(traceCalls(traceSpy)).toContainEqual({
      event: 'action_queue.processing_local_handoff',
      data: expect.objectContaining({ entityType: 'task', actionType: 'update' }),
    });
  });
});
