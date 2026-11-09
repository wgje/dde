import { expect, it, vi } from 'vitest';
import { BlackBoxSyncService } from './black-box-sync.service';
import type { BlackBoxEntry } from '../models/focus';
import {
  createEntry,
  flushMicrotasks,
} from './black-box-sync.spec-helpers';

interface BlackBoxSyncCoreSpecContext {
  getService: () => BlackBoxSyncService;
}

export function registerBlackBoxSyncCoreSpecs(context: BlackBoxSyncCoreSpecContext): void {
  const service = context.getService;

  it('flushPendingToRetryQueue should keep pending entry when RetryQueue persistence fails', async () => {
    const entry = createEntry({
      id: crypto.randomUUID(),
      userId: 'user-1',
      syncStatus: 'pending',
    });
    const retryQueueHandler = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const schedulePendingPushFlush = vi.spyOn(
      service() as unknown as { schedulePendingPushFlush: () => void },
      'schedulePendingPushFlush',
    ).mockImplementation(() => undefined);
    const internals = service() as unknown as {
      pendingPushEntries: Map<string, BlackBoxEntry>;
      retryQueueHandler: ((entry: BlackBoxEntry) => Promise<boolean>) | null;
      flushPendingToRetryQueue: () => Promise<void>;
    };
    internals.retryQueueHandler = retryQueueHandler;
    internals.pendingPushEntries.set(entry.id, entry);

    await internals.flushPendingToRetryQueue();

    expect(retryQueueHandler).toHaveBeenCalledTimes(1);
    expect(internals.pendingPushEntries.get(entry.id)).toEqual(entry);
    expect(schedulePendingPushFlush).toHaveBeenCalledTimes(1);

    await internals.flushPendingToRetryQueue();

    expect(retryQueueHandler).toHaveBeenCalledTimes(2);
    expect(internals.pendingPushEntries.has(entry.id)).toBe(false);
  });

  it('enqueueEntryForRetry should fall back to pending entry when RetryQueue persistence fails', async () => {
    const entry = createEntry({
      id: crypto.randomUUID(),
      userId: 'user-1',
      syncStatus: 'pending',
    });
    const retryQueueHandler = vi.fn().mockResolvedValue(false);
    const schedulePendingPushFlush = vi.spyOn(
      service() as unknown as { schedulePendingPushFlush: () => void },
      'schedulePendingPushFlush',
    ).mockImplementation(() => undefined);
    const internals = service() as unknown as {
      pendingPushEntries: Map<string, BlackBoxEntry>;
      retryQueueHandler: ((entry: BlackBoxEntry) => Promise<boolean>) | null;
      enqueueEntryForRetry: (entry: BlackBoxEntry) => Promise<void>;
    };
    internals.retryQueueHandler = retryQueueHandler;

    await internals.enqueueEntryForRetry(entry);

    expect(retryQueueHandler).toHaveBeenCalledWith(entry);
    expect(internals.pendingPushEntries.get(entry.id)).toEqual(entry);
    expect(schedulePendingPushFlush).toHaveBeenCalledTimes(1);
  });

  it('flushPendingToRetryQueue should keep pending entry when RetryQueue handler throws', async () => {
    const entry = createEntry({
      id: crypto.randomUUID(),
      userId: 'user-1',
      syncStatus: 'pending',
    });
    const retryQueueHandler = vi.fn().mockRejectedValue(new Error('retry db unavailable'));
    const schedulePendingPushFlush = vi.spyOn(
      service() as unknown as { schedulePendingPushFlush: () => void },
      'schedulePendingPushFlush',
    ).mockImplementation(() => undefined);
    const internals = service() as unknown as {
      pendingPushEntries: Map<string, BlackBoxEntry>;
      retryQueueHandler: ((entry: BlackBoxEntry) => Promise<boolean>) | null;
      flushPendingToRetryQueue: () => Promise<void>;
    };
    internals.retryQueueHandler = retryQueueHandler;
    internals.pendingPushEntries.set(entry.id, entry);

    await expect(internals.flushPendingToRetryQueue()).resolves.toBeUndefined();

    expect(internals.pendingPushEntries.get(entry.id)).toEqual(entry);
    expect(schedulePendingPushFlush).toHaveBeenCalledTimes(1);
  });

  it('flushPendingToRetryQueue should keep pending entry when direct fallback push fails', async () => {
    const entry = createEntry({
      id: crypto.randomUUID(),
      userId: 'user-1',
      syncStatus: 'pending',
    });
    const pushToServer = vi.spyOn(service(), 'pushToServer').mockRejectedValueOnce(new Error('offline'));
    const schedulePendingPushFlush = vi.spyOn(
      service() as unknown as { schedulePendingPushFlush: () => void },
      'schedulePendingPushFlush',
    ).mockImplementation(() => undefined);
    const internals = service() as unknown as {
      pendingPushEntries: Map<string, BlackBoxEntry>;
      retryQueueHandler: ((entry: BlackBoxEntry) => Promise<boolean>) | null;
      flushPendingToRetryQueue: () => Promise<void>;
    };
    internals.retryQueueHandler = null;
    internals.pendingPushEntries.set(entry.id, entry);

    await internals.flushPendingToRetryQueue();
    await flushMicrotasks();

    expect(pushToServer).toHaveBeenCalledWith(entry);
    expect(internals.pendingPushEntries.get(entry.id)).toEqual(entry);
    expect(schedulePendingPushFlush).toHaveBeenCalledTimes(1);
  });

  it('flushPendingToRetryQueue should not resolve before direct fallback push settles', async () => {
    const entry = createEntry({
      id: crypto.randomUUID(),
      userId: 'user-1',
      syncStatus: 'pending',
    });
    const pushControl: { resolve?: (pushed: boolean) => void } = {};
    const pushToServer = vi.spyOn(service(), 'pushToServer').mockReturnValueOnce(
      new Promise<boolean>(resolve => {
        pushControl.resolve = resolve;
      }),
    );
    const internals = service() as unknown as {
      pendingPushEntries: Map<string, BlackBoxEntry>;
      retryQueueHandler: ((entry: BlackBoxEntry) => Promise<boolean>) | null;
      flushPendingToRetryQueue: () => Promise<void>;
    };
    internals.retryQueueHandler = null;
    internals.pendingPushEntries.set(entry.id, entry);

    const flushPromise = internals.flushPendingToRetryQueue();
    let flushSettled = false;
    const observedFlush = flushPromise.then(() => {
      flushSettled = true;
    });
    await flushMicrotasks();

    expect(pushToServer).toHaveBeenCalledWith(entry);
    const settledBeforePush = flushSettled;
    pushControl.resolve?.(true);
    await observedFlush;

    expect(settledBeforePush).toBe(false);
  });
}
