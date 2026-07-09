import { TestBed } from '@angular/core/testing';
import { expect, it, vi } from 'vitest';

import type { BlackBoxEntry } from '../models/focus';
import { setBlackBoxEntries } from '../state/focus-stores';
import { BlackBoxSyncService } from './black-box-sync.service';
import { createEntry } from './black-box-sync.spec-helpers';
import { SupabaseClientService } from './supabase-client.service';

interface BlackBoxSyncStalePushSpecContext {
  getService: () => BlackBoxSyncService;
}

type BlackBoxSyncStalePushSpecTools = {
  service: () => BlackBoxSyncService;
  supabase: () => {
    clientAsync: ReturnType<typeof vi.fn>;
  };
};

type BlackBoxSyncStalePushSpec = readonly [
  name: string,
  run: (tools: BlackBoxSyncStalePushSpecTools) => Promise<void>,
];

const blackBoxSyncStalePushSpecs: readonly BlackBoxSyncStalePushSpec[] = [
  [
    'should skip stale push payloads when a newer local snapshot already exists',
    runBlackBoxSyncStalePushSpec1,
  ],
  [
    'should re-enqueue newer pending local snapshot when stale queued payload is skipped',
    runBlackBoxSyncStalePushSpec2,
  ],
];

export function registerBlackBoxSyncStalePushSpecs(
  context: BlackBoxSyncStalePushSpecContext,
): void {
  const tools: BlackBoxSyncStalePushSpecTools = {
    service: () => context.getService(),
    supabase: () => TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    },
  };

  for (const [name, run] of blackBoxSyncStalePushSpecs) {
    it(name, () => run(tools));
  }
}

async function runBlackBoxSyncStalePushSpec1(
  tools: BlackBoxSyncStalePushSpecTools,
): Promise<void> {
  const entryId = crypto.randomUUID();
  const olderEntry = createEntry({
    id: entryId,
    updatedAt: '2026-03-04T00:00:00.000Z',
    isCompleted: false,
  });
  const newerEntry = createEntry({
    id: entryId,
    updatedAt: '2026-03-04T00:00:05.000Z',
    isCompleted: true,
  });
  const from = vi.fn();

  setBlackBoxEntries([newerEntry]);
  tools.supabase().clientAsync.mockResolvedValue({ from });

  await expect(tools.service().pushToServer(olderEntry)).resolves.toBe(true);
  expect(from).not.toHaveBeenCalled();
}

async function runBlackBoxSyncStalePushSpec2(
  tools: BlackBoxSyncStalePushSpecTools,
): Promise<void> {
  const service = tools.service();
  const entryId = crypto.randomUUID();
  const olderEntry = createEntry({
    id: entryId,
    updatedAt: '2026-03-04T00:00:00.000Z',
    syncStatus: 'pending',
  });
  const newerPendingEntry = createEntry({
    id: entryId,
    content: 'newer pending edit',
    updatedAt: '2026-03-04T00:00:05.000Z',
    syncStatus: 'pending',
  });
  const from = vi.fn();
  const enqueue = vi.fn();
  const saveToLocalSpy = vi
    .spyOn(service, 'saveToLocal')
    .mockResolvedValue(undefined);

  setBlackBoxEntries([newerPendingEntry]);
  (service as unknown as {
    retryQueueHandler: ((entry: BlackBoxEntry) => void) | null;
  }).retryQueueHandler = enqueue;
  tools.supabase().clientAsync.mockResolvedValue({ from });

  await expect(service.pushToServer(olderEntry)).resolves.toBe(true);

  expect(from).not.toHaveBeenCalled();
  expect(saveToLocalSpy).toHaveBeenCalledWith(expect.objectContaining({
    id: entryId,
    content: 'newer pending edit',
    syncStatus: 'pending',
  }));
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
    id: entryId,
    content: 'newer pending edit',
    syncStatus: 'pending',
  }));
}
