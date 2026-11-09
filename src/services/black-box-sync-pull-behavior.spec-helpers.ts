import { expect, it, vi } from 'vitest';

import type { BlackBoxEntry } from '../models/focus';
import type { BlackBoxSyncService } from './black-box-sync.service';
import type { SupabaseClientService } from './supabase-client.service';
import { setBlackBoxEntries } from '../state/focus-stores';
import { createBrowserNetworkSuspendedError } from '../utils/browser-network-suspension';
import {
  createEntry,
  flushMicrotasks,
} from './black-box-sync.spec-helpers';

interface BlackBoxSyncPullBehaviorSpecContext {
  getService: () => BlackBoxSyncService;
  getMockSentry: () => {
    captureMessage: ReturnType<typeof vi.fn>;
  };
  getSupabaseClientService: () => SupabaseClientService;
}

export function registerBlackBoxSyncPullBehaviorSpecs(
  context: BlackBoxSyncPullBehaviorSpecContext,
): void {
  const service = context.getService;

  it('should apply resume pull cooldown by default', async () => {
    const doPullSpy = vi.spyOn(
      service() as unknown as { doPullChanges: () => Promise<boolean> },
      'doPullChanges'
    ).mockResolvedValue(true);

    await service().pullChanges({ reason: 'resume' });
    await service().pullChanges({ reason: 'resume' });

    expect(doPullSpy).toHaveBeenCalledTimes(1);
  });

  it('should bypass cooldown when force=true', async () => {
    const doPullSpy = vi.spyOn(
      service() as unknown as { doPullChanges: () => Promise<boolean> },
      'doPullChanges'
    ).mockResolvedValue(true);

    await service().pullChanges({ reason: 'resume' });
    await service().pullChanges({ reason: 'resume', force: true });

    expect(doPullSpy).toHaveBeenCalledTimes(2);
  });

  it('should fall back to local cache when remote transport is marked unavailable', async () => {
    const supabase = context.getSupabaseClientService() as unknown as {
      isOfflineMode: ReturnType<typeof vi.fn>;
    };
    supabase.isOfflineMode.mockReturnValue(true);

    const doPullSpy = vi.spyOn(
      service() as unknown as { doPullChanges: () => Promise<boolean> },
      'doPullChanges'
    ).mockResolvedValue(true);
    const loadLocalSpy = vi.spyOn(
      service() as unknown as { loadFromLocal: () => Promise<unknown[]> },
      'loadFromLocal'
    ).mockResolvedValue([]);

    await service().pullChanges({ reason: 'resume', force: true });

    expect(doPullSpy).not.toHaveBeenCalled();
    expect(loadLocalSpy).toHaveBeenCalledTimes(1);
  });

  it('should block duplicate pull by freshness window and report to Sentry', async () => {
    const doPullSpy = vi.spyOn(
      service() as unknown as { doPullChanges: () => Promise<boolean> },
      'doPullChanges'
    ).mockResolvedValue(true);

    await service().pullChanges({ reason: 'manual', force: true });
    expect(doPullSpy).toHaveBeenCalledTimes(1);

    await service().pullChanges({ reason: 'manual' });
    expect(doPullSpy).toHaveBeenCalledTimes(1);

    expect(context.getMockSentry().captureMessage).toHaveBeenCalledWith(
      'BlackBox duplicate pull blocked',
      expect.objectContaining({
        level: 'info',
        tags: expect.objectContaining({
          classification: 'duplicate_blocked',
        }),
      })
    );
  });

  it('should not refresh pull freshness when a delta page reports browser network suspension', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const loadLocalSpy = vi.spyOn(
      service() as unknown as { loadFromLocal: () => Promise<unknown[]> },
      'loadFromLocal',
    ).mockResolvedValue([]);
    const pullPagesSpy = vi.spyOn(
      service() as unknown as {
        pullBlackBoxDeltaPages: () => Promise<{
          status: 'completed';
          pulledRowCount: number;
          error: unknown;
        }>;
      },
      'pullBlackBoxDeltaPages',
    ).mockResolvedValue({
      status: 'completed',
      pulledRowCount: 0,
      error: createBrowserNetworkSuspendedError(),
    });
    (service() as unknown as { lastPullTime: number }).lastPullTime = 0;

    try {
      await service().pullChanges({ reason: 'manual', force: true });

      expect(pullPagesSpy).toHaveBeenCalledTimes(1);
      expect(loadLocalSpy).toHaveBeenCalledTimes(1);
      expect((service() as unknown as { lastPullTime: number }).lastPullTime).toBe(0);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('should bypass freshness window when pending entries need authoritative reconcile', async () => {
    const doPullSpy = vi.spyOn(
      service() as unknown as { doPullChanges: () => Promise<boolean> },
      'doPullChanges'
    ).mockResolvedValue(true);
    const pendingEntry = createEntry({
      id: crypto.randomUUID(),
      syncStatus: 'pending',
    });

    setBlackBoxEntries([pendingEntry]);
    (service() as unknown as { lastPullTime: number }).lastPullTime = Date.now();

    await service().pullChanges({ reason: 'panel-open' });

    expect(doPullSpy).toHaveBeenCalledTimes(1);
    expect(context.getMockSentry().captureMessage).not.toHaveBeenCalled();
  });

  it('should bypass resume cooldown when pending entries need authoritative reconcile', async () => {
    const doPullSpy = vi.spyOn(
      service() as unknown as { doPullChanges: () => Promise<boolean> },
      'doPullChanges'
    ).mockResolvedValue(true);
    const pendingEntry = createEntry({
      id: crypto.randomUUID(),
      syncStatus: 'pending',
    });

    setBlackBoxEntries([pendingEntry]);
    (service() as unknown as { lastResumePullAt: number }).lastResumePullAt = Date.now();

    await service().pullChanges({ reason: 'resume' });

    expect(doPullSpy).toHaveBeenCalledTimes(1);
  });

  it('panel-open reason should bypass freshness window for cross-device sync', async () => {
    const doPullSpy = vi.spyOn(
      service() as unknown as { doPullChanges: () => Promise<boolean> },
      'doPullChanges'
    ).mockResolvedValue(true);

    await service().pullChanges({ reason: 'panel-open', force: true });
    context.getMockSentry().captureMessage.mockClear();

    await service().pullChanges({ reason: 'panel-open' });
    expect(doPullSpy).toHaveBeenCalledTimes(2);
    expect(context.getMockSentry().captureMessage).not.toHaveBeenCalled();
  });

  it('forceSync should await pending push flush before manual pull', async () => {
    const entry = createEntry({
      id: crypto.randomUUID(),
      userId: 'user-1',
      syncStatus: 'pending',
    });
    let resolveFlush: (() => void) | null = null;
    const retryQueueHandler = vi.fn(() => new Promise<boolean>(resolve => {
      resolveFlush = () => resolve(true);
    }));
    const pullChangesSpy = vi.spyOn(service(), 'pullChanges').mockResolvedValue(undefined);
    const internals = service() as unknown as {
      pendingPushEntries: Map<string, BlackBoxEntry>;
      retryQueueHandler: (queuedEntry: BlackBoxEntry) => Promise<boolean>;
    };
    internals.pendingPushEntries.set(entry.id, entry);
    internals.retryQueueHandler = retryQueueHandler;

    const forceSyncPromise = service().forceSync();
    await flushMicrotasks();

    expect(retryQueueHandler).toHaveBeenCalledWith(entry);
    expect(pullChangesSpy).not.toHaveBeenCalled();

    resolveFlush!();
    await forceSyncPromise;

    expect(pullChangesSpy).toHaveBeenCalledWith({ reason: 'manual', force: true });
  });
}
