import { TestBed } from '@angular/core/testing';
import { expect, vi } from 'vitest';

import type { BlackBoxEntry } from '../models/focus';
import { blackBoxEntriesMap, setBlackBoxEntries } from '../state/focus-stores';
import {
  createEntry,
  createScopedQuery,
  flushMicrotasks,
} from './black-box-sync.spec-helpers';
import type {
  BlackBoxSyncRemoteReconcileSpec,
  BlackBoxSyncRemoteReconcileSpecTools,
} from './black-box-sync-remote-reconcile.spec-helpers';
import { NetworkAwarenessService } from './network-awareness.service';
import { SupabaseClientService } from './supabase-client.service';

export const blackBoxSyncRemoteReconcileStartupSpecs: readonly BlackBoxSyncRemoteReconcileSpec[] = [
  ['should skip startup retry recovery when server already has a newer authoritative row', runBlackBoxSyncRemoteReconcileSpec12],
  ['should keep startup pending recovery local-only when network is offline', runBlackBoxSyncRemoteReconcileSpec13],
  ['should rerun pending recovery after auth settles and suppress stale startup pending rows', runBlackBoxSyncRemoteReconcileSpec14],
  ['should keep startup pending recovery scheduled when RetryQueue enqueue fails', runBlackBoxSyncRemoteReconcileSpec15],
];

async function runBlackBoxSyncRemoteReconcileSpec12(
  tools: BlackBoxSyncRemoteReconcileSpecTools,
): Promise<void> {
  const { service } = tools;

  const entryId = crypto.randomUUID();
  const pendingEntry = createEntry({
    id: entryId,
    updatedAt: '2026-03-04T00:00:00.000Z',
    isCompleted: false,
    syncStatus: 'pending',
  });
  const remoteRow = {
    id: entryId,
    project_id: null,
    user_id: 'user-1',
    content: 'entry',
    focus_meta: null,
    date: '2026-03-04',
    created_at: '2026-03-04T00:00:00.000Z',
    updated_at: '2026-03-04T00:00:05.000Z',
    is_read: false,
    is_completed: true,
    is_archived: false,
    snooze_until: null,
    snooze_count: 0,
    deleted_at: null,
  };
  const enqueue = vi.fn();
  const inQuery = vi.fn().mockResolvedValue({ data: [remoteRow], error: null });
  const scopedQuery = createScopedQuery({ in: inQuery });
  const selectQuery = vi.fn(() => scopedQuery);
  const from = vi.fn(() => ({ select: selectQuery }));
  const supabase = TestBed.inject(SupabaseClientService) as unknown as {
    clientAsync: ReturnType<typeof vi.fn>;
  };
  vi.spyOn(service(), 'loadFromLocal').mockResolvedValue([pendingEntry]);
  vi.spyOn(service(), 'saveToLocal').mockResolvedValue(undefined);
  supabase.clientAsync.mockResolvedValue({ from });
  setBlackBoxEntries([pendingEntry]);
  (service() as unknown as { retryQueueHandler: ((entry: BlackBoxEntry) => void) | null }).retryQueueHandler = enqueue;

  await (service() as unknown as { recoverPendingEntries: () => Promise<void> }).recoverPendingEntries();

  expect(scopedQuery.eq).toHaveBeenCalledWith('user_id', 'user-1');
  expect(inQuery).toHaveBeenCalledWith('id', [entryId]);
  expect(enqueue).not.toHaveBeenCalled();
  expect(blackBoxEntriesMap().get(entryId)).toEqual(
    expect.objectContaining({
      id: entryId,
      isCompleted: true,
      syncStatus: 'synced',
      updatedAt: remoteRow.updated_at,
    })
  );
}

async function runBlackBoxSyncRemoteReconcileSpec13(
  tools: BlackBoxSyncRemoteReconcileSpecTools,
): Promise<void> {
  const { service } = tools;

  const entryId = crypto.randomUUID();
  const pendingEntry = createEntry({
    id: entryId,
    syncStatus: 'pending',
  });
  const enqueue = vi.fn();
  const supabase = TestBed.inject(SupabaseClientService) as unknown as {
    clientAsync: ReturnType<typeof vi.fn>;
  };
  const network = TestBed.inject(NetworkAwarenessService) as unknown as {
    isOnline: ReturnType<typeof vi.fn>;
  };
  vi.spyOn(service(), 'loadFromLocal').mockResolvedValue([pendingEntry]);
  setBlackBoxEntries([pendingEntry]);
  network.isOnline.mockReturnValue(false);
  (service() as unknown as { retryQueueHandler: ((entry: BlackBoxEntry) => void) | null }).retryQueueHandler = enqueue;

  await (service() as unknown as { recoverPendingEntries: () => Promise<void> }).recoverPendingEntries();

  expect(supabase.clientAsync).not.toHaveBeenCalled();
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(enqueue).toHaveBeenCalledWith(pendingEntry);
}

async function runBlackBoxSyncRemoteReconcileSpec14(
  tools: BlackBoxSyncRemoteReconcileSpecTools,
): Promise<void> {
  const { service, authSignals } = tools;

  const entryId = crypto.randomUUID();
  const pendingEntry = createEntry({
    id: entryId,
    updatedAt: '2026-03-04T00:00:00.000Z',
    isCompleted: false,
    syncStatus: 'pending',
  });
  const remoteRow = {
    id: entryId,
    project_id: null,
    user_id: 'user-1',
    content: 'entry',
    focus_meta: null,
    date: '2026-03-04',
    created_at: '2026-03-04T00:00:00.000Z',
    updated_at: '2026-03-04T00:00:05.000Z',
    is_read: false,
    is_completed: true,
    is_archived: false,
    snooze_until: null,
    snooze_count: 0,
    deleted_at: null,
  };
  const enqueue = vi.fn();
  const inQuery = vi.fn().mockResolvedValue({ data: [remoteRow], error: null });
  const scopedQuery = createScopedQuery({ in: inQuery });
  const selectQuery = vi.fn(() => scopedQuery);
  const from = vi.fn(() => ({ select: selectQuery }));
  const supabase = TestBed.inject(SupabaseClientService) as unknown as {
    clientAsync: ReturnType<typeof vi.fn>;
  };
  vi.spyOn(service(), 'loadFromLocal').mockResolvedValue([pendingEntry]);
  vi.spyOn(service(), 'saveToLocal').mockResolvedValue(undefined);
  supabase.clientAsync.mockResolvedValue({ from });
  setBlackBoxEntries([pendingEntry]);

  authSignals().sessionInitialized.set(false);
  authSignals().runtimeState.set('pending');
  authSignals().currentUserId.set(null);

  service().setRetryQueueHandler(enqueue);
  await flushMicrotasks();

  expect(enqueue).not.toHaveBeenCalled();
  expect(supabase.clientAsync).not.toHaveBeenCalled();

  authSignals().currentUserId.set('user-1');
  authSignals().authState.update(state => ({ ...state, userId: 'user-1', isCheckingSession: false }));
  authSignals().sessionInitialized.set(true);
  authSignals().runtimeState.set('ready');

  await vi.waitFor(() => {
    expect(inQuery).toHaveBeenCalledWith('id', [entryId]);
  });

  expect(enqueue).not.toHaveBeenCalled();
  expect(blackBoxEntriesMap().get(entryId)).toEqual(
    expect.objectContaining({
      id: entryId,
      isCompleted: true,
      syncStatus: 'synced',
      updatedAt: remoteRow.updated_at,
    })
  );
}

async function runBlackBoxSyncRemoteReconcileSpec15(
  tools: BlackBoxSyncRemoteReconcileSpecTools,
): Promise<void> {
  const { service } = tools;

  const pendingEntry = createEntry({
    id: crypto.randomUUID(),
    syncStatus: 'pending',
  });
  const enqueue = vi.fn().mockResolvedValue(false);
  const network = TestBed.inject(NetworkAwarenessService) as unknown as {
    isOnline: ReturnType<typeof vi.fn>;
  };
  const internals = service() as unknown as {
    pendingPushEntries: Map<string, BlackBoxEntry>;
    retryQueueHandler: ((entry: BlackBoxEntry) => Promise<boolean>) | null;
    recoverPendingEntries: () => Promise<void>;
    schedulePendingPushFlush: () => void;
  };
  const scheduleFlushSpy = vi
    .spyOn(internals, 'schedulePendingPushFlush')
    .mockImplementation(() => undefined);

  vi.spyOn(service(), 'loadFromLocal').mockResolvedValue([pendingEntry]);
  setBlackBoxEntries([pendingEntry]);
  network.isOnline.mockReturnValue(false);
  internals.retryQueueHandler = enqueue;

  await internals.recoverPendingEntries();

  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(enqueue).toHaveBeenCalledWith(pendingEntry);
  expect(internals.pendingPushEntries.get(pendingEntry.id)).toEqual(pendingEntry);
  expect(scheduleFlushSpy).toHaveBeenCalledTimes(1);
}
