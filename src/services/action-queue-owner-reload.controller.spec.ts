import { describe, expect, it, vi } from 'vitest';

import {
  ActionQueueOwnerReloadController,
  type ActionQueueOwnerReloadPreflightResult,
  type ActionQueueOwnerReloadStage,
  type ActionQueueOwnerReloadState,
  type ActionQueueOwnerReloadToken,
} from './action-queue-owner-reload.controller';

interface TestItem { id: string }

describe('ActionQueueOwnerReloadController', () => {
  it('publishes one staged owner snapshot and marks loaded last', async () => {
    const events: string[] = [];
    const preimage = createState('old');
    const staged = createState('new');
    const harness = createHarness(preimage, staged, events);

    await new ActionQueueOwnerReloadController(harness.dependencies).reload();

    expect(harness.readState()).toBe(staged);
    expect(events).toEqual([
      'loading', 'preflight', 'readback', 'stage', 'publish', 'readback', 'loaded', 'activate',
    ]);
  });

  it('keeps owner storage untouched when the pre-ActionQueue fence returns HOLD', async () => {
    const preimage = createState('old');
    const harness = createHarness(preimage, createState('unused'), []);
    harness.preflight.mockResolvedValueOnce({ status: 'HOLD', reason: 'marker-active' });

    await new ActionQueueOwnerReloadController(harness.dependencies).reload();

    expect(harness.readState()).toBe(preimage);
    expect(harness.stage).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
    expect(harness.activate).not.toHaveBeenCalled();
    expect(harness.complete).toHaveBeenCalledWith(harness.token, 'failed');
  });

  it('keeps the exact preimage and unknown state when staging fails', async () => {
    const preimage = createState('old');
    const harness = createHarness(preimage, createState('unused'), []);
    harness.stage.mockResolvedValueOnce({ outcome: 'failed' });

    await new ActionQueueOwnerReloadController(harness.dependencies).reload();

    expect(harness.readState()).toBe(preimage);
    expect(harness.publish).not.toHaveBeenCalled();
    expect(harness.complete).toHaveBeenCalledWith(harness.token, 'failed');
  });

  it('restores the exact preimage after a partial publication failure', async () => {
    const preimage = createState('old');
    const staged = createState('new');
    const harness = createHarness(preimage, staged, []);
    harness.publish.mockImplementationOnce(state => {
      harness.replaceState({ ...state, deadLetters: preimage.deadLetters });
      throw new Error('dead-letter publication failed');
    });

    await new ActionQueueOwnerReloadController(harness.dependencies).reload();

    expect(harness.readState()).toBe(preimage);
    expect(harness.publish).toHaveBeenLastCalledWith(preimage);
    expect(harness.complete).toHaveBeenCalledWith(harness.token, 'failed');
    expect(harness.warn).toHaveBeenCalledWith(
      'ActionQueue owner storage publication failed',
      expect.objectContaining({ rollbackVerified: true }),
    );
  });

  it('rolls back publication when the owner generation changes before loaded', async () => {
    const preimage = createState('owner-a');
    const staged = createState('owner-b');
    const harness = createHarness(preimage, staged, []);
    harness.publish.mockImplementationOnce(state => {
      harness.replaceState(state);
      harness.setCurrent(false);
    });

    await new ActionQueueOwnerReloadController(harness.dependencies).reload();

    expect(harness.readState()).toBe(preimage);
    expect(harness.complete).toHaveBeenCalledWith(harness.token, 'stale');
  });

  it('restores the exact preimage and invalidates loaded state when activation fails', async () => {
    const preimage = createState('old');
    const harness = createHarness(preimage, createState('new'), []);
    harness.activate.mockImplementationOnce(() => { throw new Error('listener activation failed'); });

    await new ActionQueueOwnerReloadController(harness.dependencies).reload();

    expect(harness.readState()).toBe(preimage);
    expect(harness.invalidateLoaded).toHaveBeenCalledWith(harness.token);
    expect(harness.warn).toHaveBeenCalledWith(
      'ActionQueue owner storage publication failed',
      expect.objectContaining({ rollbackVerified: true }),
    );
  });
});

function createState(id: string): ActionQueueOwnerReloadState<TestItem, TestItem> {
  const queue = [{ id: `queue-${id}` }];
  const deadLetters = [{ id: `dead-${id}` }];
  return {
    queue,
    queueSize: queue.length,
    deadLetters,
    deadLetterSize: deadLetters.length,
    queueFrozen: id === 'old',
    queueFreezeReason: id === 'old' ? 'old-freeze' : null,
  };
}

function createHarness(
  initial: ActionQueueOwnerReloadState<TestItem, TestItem>,
  staged: ActionQueueOwnerReloadState<TestItem, TestItem>,
  events: string[],
) {
  let current = initial;
  let isCurrent = true;
  const token: ActionQueueOwnerReloadToken = { ownerUserId: 'owner-a', generation: 1 };
  const stage = vi.fn<(
    token: ActionQueueOwnerReloadToken,
  ) => Promise<ActionQueueOwnerReloadStage<TestItem, TestItem>>>(async () => {
    events.push('stage');
    return { outcome: 'ready' as const, state: staged };
  });
  const publish = vi.fn((state: ActionQueueOwnerReloadState<TestItem, TestItem>) => {
    events.push('publish');
    current = state;
  });
  const complete = vi.fn((_token: ActionQueueOwnerReloadToken, outcome: string) => {
    events.push(outcome === 'ready' ? 'loaded' : 'unknown');
  });
  const preflight = vi.fn<(
    token: ActionQueueOwnerReloadToken,
  ) => Promise<ActionQueueOwnerReloadPreflightResult>>(async () => {
    events.push('preflight');
    return { status: 'CLEAR' as const };
  });
  const activate = vi.fn(() => { events.push('activate'); });
  const invalidateLoaded = vi.fn();
  const warn = vi.fn();
  return {
    token,
    stage,
    publish,
    complete,
    preflight,
    activate,
    invalidateLoaded,
    warn,
    readState: () => current,
    replaceState: (state: ActionQueueOwnerReloadState<TestItem, TestItem>) => { current = state; },
    setCurrent: (value: boolean) => { isCurrent = value; },
    dependencies: {
      beginLoad: () => { events.push('loading'); return token; },
      isLoadCurrent: () => isCurrent,
      preflight,
      completeLoad: complete,
      isLoadedCurrent: () => isCurrent,
      invalidateLoaded,
      captureState: () => { events.push('readback'); return current; },
      stage,
      publishState: publish,
      statesMatch: (left: ActionQueueOwnerReloadState<TestItem, TestItem>, right: typeof left) => (
        left === right
      ),
      activate,
      warn,
    },
  };
}
