import { TestBed } from '@angular/core/testing';
import { expect, it, vi } from 'vitest';

import { blackBoxEntriesMap, setBlackBoxEntries } from '../state/focus-stores';
import { SupabaseClientService } from './supabase-client.service';
import { BlackBoxSyncService } from './black-box-sync.service';
import { blackBoxSyncRemoteReconcileStartupSpecs } from './black-box-sync-remote-reconcile-startup.spec-helpers';
import {
  createEntry,
  createLegacyEntryWithUndefinedDeletedAt,
  createScopedQuery,
} from './black-box-sync.spec-helpers';

export interface BlackBoxSyncRemoteReconcileSpecContext {
  getService: () => BlackBoxSyncService;
  getAuthSignals: () => {
    sessionInitialized: { set(value: boolean): void };
    runtimeState: { set(value: 'idle' | 'pending' | 'ready' | 'failed'): void };
    authState: { update(updater: (state: { userId: string | null; isCheckingSession: boolean }) => { userId: string | null; isCheckingSession: boolean }): void };
    currentUserId: { set(value: string | null): void };
  };
}

export type BlackBoxSyncRemoteReconcileSpecTools = {
  service: () => BlackBoxSyncService;
  authSignals: () => ReturnType<BlackBoxSyncRemoteReconcileSpecContext['getAuthSignals']>;
};

export type BlackBoxSyncRemoteReconcileSpec = readonly [
  name: string,
  run: (tools: BlackBoxSyncRemoteReconcileSpecTools) => Promise<void>,
];

const blackBoxSyncRemoteReconcileSpecs: readonly BlackBoxSyncRemoteReconcileSpec[] = [
  ['should reconcile pending local entries against server rows even when delta pull returns empty', runBlackBoxSyncRemoteReconcileSpec1],
  ['should preserve local black box content when pulling a newer blank remote row', runBlackBoxSyncRemoteReconcileSpec2],
  ['should pull black box deltas with a safety lookback and stable id ordering', runBlackBoxSyncRemoteReconcileSpec3],
  ['should scope delta pull with resolved session user when caller has no expected user', runBlackBoxSyncRemoteReconcileSpec4],
  ['should not mark pull fresh when delta query cannot be user scoped', runBlackBoxSyncRemoteReconcileSpec5],
  ['should page black box delta pulls to avoid unbounded Supabase reads', runBlackBoxSyncRemoteReconcileSpec6],
  ['should not advance the black box cursor in memory when cursor persistence fails', runBlackBoxSyncRemoteReconcileSpec7],
  ['should clear pending when server already reflects the same newer-local mutation', runBlackBoxSyncRemoteReconcileSpec8],
  ['should reconcile pending entries with equivalent focusMeta even when json key order differs', runBlackBoxSyncRemoteReconcileSpec9],
  ['should clear stale pending when server row only differs by timestamp/null formatting', runBlackBoxSyncRemoteReconcileSpec10],
  ['should reconcile pending deleted tombstones against server tombstones', runBlackBoxSyncRemoteReconcileSpec11],
  ...blackBoxSyncRemoteReconcileStartupSpecs,
];

export function registerBlackBoxSyncRemoteReconcileSpecs(context: BlackBoxSyncRemoteReconcileSpecContext): void {
  const tools: BlackBoxSyncRemoteReconcileSpecTools = {
    service: () => context.getService(),
    authSignals: () => context.getAuthSignals(),
  };

  for (const [name, run] of blackBoxSyncRemoteReconcileSpecs) {
    it(name, () => run(tools));
  }
}

async function runBlackBoxSyncRemoteReconcileSpec1(tools: BlackBoxSyncRemoteReconcileSpecTools): Promise<void> {
  const { service } = tools;

    const entryId = crypto.randomUUID();
    const pendingEntry = createEntry({
      id: entryId,
      updatedAt: '2026-03-04T00:00:00.000Z',
      isRead: true,
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
      updated_at: '2026-03-04T00:00:00.000Z',
      is_read: true,
      is_completed: false,
      is_archived: false,
      snooze_until: null,
      snooze_count: 0,
      deleted_at: null,
    };
    const inQuery = vi.fn().mockResolvedValue({ data: [remoteRow], error: null });
    const orderedResult = {
      data: [],
      error: null,
      order: vi.fn(() => orderedResult),
    };
    const gtQuery = vi.fn(() => orderedResult);
    const scopedQuery = createScopedQuery({
      gt: gtQuery,
      in: inQuery,
    });
    const selectQuery = vi.fn(() => scopedQuery);
    const from = vi.fn(() => ({ select: selectQuery }));
    const rpc = vi.fn().mockResolvedValue({ data: '2026-03-05T00:00:00.000Z', error: null });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service(), 'saveToLocal').mockResolvedValue(undefined);
    (service() as unknown as { lastSyncTime: string | null }).lastSyncTime = '2026-03-05T00:00:00.000Z';
    supabase.clientAsync.mockResolvedValue({ from, rpc });
    setBlackBoxEntries([pendingEntry]);

    await service().pullChanges({ reason: 'panel-open', force: true });

    expect(scopedQuery.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(inQuery).toHaveBeenCalledWith('id', [entryId]);
    expect(blackBoxEntriesMap().get(entryId)?.syncStatus).toBe('synced');
}

async function runBlackBoxSyncRemoteReconcileSpec2(tools: BlackBoxSyncRemoteReconcileSpecTools): Promise<void> {
  const { service } = tools;

    const entryId = crypto.randomUUID();
    const localEntry = createEntry({
      id: entryId,
      content: 'local full content',
      updatedAt: '2026-03-04T00:00:00.000Z',
      syncStatus: 'synced',
    });
    const remoteRow = {
      id: entryId,
      project_id: null,
      user_id: 'user-1',
      content: '',
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
    const orderedResult = {
      data: [remoteRow],
      error: null,
      order: vi.fn(() => orderedResult),
    };
    const gtQuery = vi.fn(() => orderedResult);
    const selectQuery = vi.fn(() => createScopedQuery({
      gt: gtQuery,
    }));
    const from = vi.fn(() => ({ select: selectQuery }));
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    const saveToLocalSpy = vi.spyOn(service(), 'saveToLocal').mockResolvedValue(undefined);
    setBlackBoxEntries([localEntry]);
    supabase.clientAsync.mockResolvedValue({ from, rpc });

    await service().pullChanges({ reason: 'panel-open', force: true });

    expect(saveToLocalSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: entryId,
      content: 'local full content',
      isCompleted: true,
      syncStatus: 'synced',
    }));
    expect(blackBoxEntriesMap().get(entryId)).toEqual(expect.objectContaining({
      content: 'local full content',
      isCompleted: true,
      syncStatus: 'synced',
    }));
}

async function runBlackBoxSyncRemoteReconcileSpec3(tools: BlackBoxSyncRemoteReconcileSpecTools): Promise<void> {
  const { service } = tools;

    const orderedResult = {
      data: [],
      error: null,
      order: vi.fn(() => orderedResult),
    };
    const gtQuery = vi.fn(() => orderedResult);
    const scopedQuery = createScopedQuery({
      gt: gtQuery,
    });
    const selectQuery = vi.fn(() => scopedQuery);
    const from = vi.fn(() => ({ select: selectQuery }));
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service(), 'saveToLocal').mockResolvedValue(undefined);
    (service() as unknown as { currentSyncUserId: string | null }).currentSyncUserId = 'user-1';
    (service() as unknown as { lastSyncTime: string | null }).lastSyncTime = '2026-03-05T00:00:30.000Z';
    supabase.clientAsync.mockResolvedValue({ from, rpc });

    await service().pullChanges({ reason: 'panel-open', force: true });

    expect(scopedQuery.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(gtQuery).toHaveBeenCalledWith('updated_at', '2026-03-05T00:00:00.000Z');
    expect(orderedResult.order).toHaveBeenCalledWith('updated_at', { ascending: true });
    expect(orderedResult.order).toHaveBeenCalledWith('id', { ascending: true });
}

async function runBlackBoxSyncRemoteReconcileSpec4(tools: BlackBoxSyncRemoteReconcileSpecTools): Promise<void> {
  const { service } = tools;

    const orderedResult = {
      data: [],
      error: null,
      order: vi.fn(() => orderedResult),
    };
    const gtQuery = vi.fn(() => orderedResult);
    const scopedQuery = createScopedQuery({
      gt: gtQuery,
    });
    const selectQuery = vi.fn(() => scopedQuery);
    const from = vi.fn(() => ({ select: selectQuery }));
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service(), 'saveToLocal').mockResolvedValue(undefined);
    supabase.clientAsync.mockResolvedValue({ from, rpc });

    await (service() as unknown as {
      doPullChanges: (preferRemoteForSyncedLocalDuringPull: boolean, expectedUserId?: string) => Promise<boolean>;
    }).doPullChanges(false, undefined);

    expect(scopedQuery.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(gtQuery).toHaveBeenCalledWith('updated_at', '1970-01-01T00:00:00Z');
}

async function runBlackBoxSyncRemoteReconcileSpec5(tools: BlackBoxSyncRemoteReconcileSpecTools): Promise<void> {
  const { service } = tools;

    const gtQuery = vi.fn(() => ({
      data: [],
      error: null,
      order: vi.fn(),
    }));
    const selectQuery = vi.fn(() => ({
      gt: gtQuery,
    }));
    const from = vi.fn(() => ({ select: selectQuery }));
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service(), 'loadFromLocal').mockResolvedValue([]);
    supabase.clientAsync.mockResolvedValue({ from, rpc });

    await service().pullChanges({ reason: 'panel-open', force: true });

    expect(gtQuery).not.toHaveBeenCalled();
    expect((service() as unknown as { lastPullTime: number }).lastPullTime).toBe(0);
}

async function runBlackBoxSyncRemoteReconcileSpec6(tools: BlackBoxSyncRemoteReconcileSpecTools): Promise<void> {
  const { service } = tools;

    const rows = [0, 1, 2].map(index => ({
      id: crypto.randomUUID(),
      project_id: null,
      user_id: 'user-1',
      content: `entry ${index}`,
      focus_meta: null,
      date: '2026-03-04',
      created_at: '2026-03-04T00:00:00.000Z',
      updated_at: `2026-03-05T00:00:0${index}.000Z`,
      is_read: false,
      is_completed: false,
      is_archived: false,
      snooze_until: null,
      snooze_count: 0,
      deleted_at: null,
    }));
    let page = 0;
    const limit = vi.fn(() => Promise.resolve({
      data: page++ === 0 ? rows.slice(0, 2) : rows.slice(2),
      error: null,
    }));
    const orderedResult = {
      limit,
      order: vi.fn(() => orderedResult),
    };
    const gtQuery = vi.fn(() => orderedResult);
    const orQuery = vi.fn(() => orderedResult);
    const selectQuery = vi.fn(() => createScopedQuery({
      gt: gtQuery,
      or: orQuery,
    }));
    const from = vi.fn(() => ({ select: selectQuery }));
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service(), 'saveToLocal').mockResolvedValue(undefined);
    (service() as unknown as { currentSyncUserId: string | null }).currentSyncUserId = 'user-1';
    (service() as unknown as { BLACKBOX_PULL_PAGE_SIZE: number }).BLACKBOX_PULL_PAGE_SIZE = 2;
    supabase.clientAsync.mockResolvedValue({ from, rpc });

    await service().pullChanges({ reason: 'panel-open', force: true });

    expect(limit).toHaveBeenCalledWith(2);
    expect(limit).toHaveBeenCalledTimes(2);
    expect(gtQuery).toHaveBeenCalledWith('updated_at', '1970-01-01T00:00:00Z');
    expect(orQuery).toHaveBeenCalledWith(expect.stringContaining(`id.gt.${rows[1].id}`));
    expect(blackBoxEntriesMap().size).toBe(3);
}

async function runBlackBoxSyncRemoteReconcileSpec7(tools: BlackBoxSyncRemoteReconcileSpecTools): Promise<void> {
  const { service } = tools;

    const entryId = crypto.randomUUID();
    const remoteRow = {
      id: entryId,
      project_id: null,
      user_id: 'user-1',
      content: 'entry',
      focus_meta: null,
      date: '2026-03-04',
      created_at: '2026-03-04T00:00:00.000Z',
      updated_at: '2026-03-05T00:00:30.000Z',
      is_read: false,
      is_completed: false,
      is_archived: false,
      snooze_until: null,
      snooze_count: 0,
      deleted_at: null,
    };
    const orderedResult = {
      data: [remoteRow],
      error: null,
      order: vi.fn(() => orderedResult),
    };
    const gtQuery = vi.fn(() => orderedResult);
    const selectQuery = vi.fn(() => createScopedQuery({
      gt: gtQuery,
    }));
    const from = vi.fn(() => ({ select: selectQuery }));
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    const tx = {
      objectStore: vi.fn(() => ({
        get: vi.fn(() => {
          const request = {
            result: null,
            onsuccess: null as ((ev: Event) => void) | null,
            onerror: null as ((ev: Event) => void) | null,
          };
          queueMicrotask(() => request.onsuccess?.(new Event('success')));
          return request;
        }),
        put: vi.fn(() => queueMicrotask(() => tx.onerror?.(new Event('error')))),
      })),
      oncomplete: null as ((ev: Event) => void) | null,
      onerror: null as ((ev: Event) => void) | null,
      onabort: null as ((ev: Event) => void) | null,
      error: new Error('cursor write failed'),
    };

    vi.spyOn(service(), 'saveToLocal').mockResolvedValue(undefined);
    (service() as unknown as { currentSyncUserId: string | null }).currentSyncUserId = 'user-1';
    (service() as unknown as { db: unknown }).db = {
      transaction: vi.fn(() => tx),
    };
    supabase.clientAsync.mockResolvedValue({ from, rpc });

    await service().pullChanges({ reason: 'panel-open', force: true });

    expect((service() as unknown as { lastSyncCursor: unknown }).lastSyncCursor).toBeNull();
    expect((service() as unknown as { lastSyncTime: unknown }).lastSyncTime).toBeNull();
}

async function runBlackBoxSyncRemoteReconcileSpec8(tools: BlackBoxSyncRemoteReconcileSpecTools): Promise<void> {
  const { service } = tools;

    const entryId = crypto.randomUUID();
    const pendingEntry = createEntry({
      id: entryId,
      updatedAt: '2026-03-05T00:00:00.000Z',
      isRead: true,
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
      updated_at: '2026-03-04T00:00:00.000Z',
      is_read: true,
      is_completed: false,
      is_archived: false,
      snooze_until: null,
      snooze_count: 0,
      deleted_at: null,
    };
    const inQuery = vi.fn().mockResolvedValue({ data: [remoteRow], error: null });
    const orderedResult = {
      data: [],
      error: null,
      order: vi.fn(() => orderedResult),
    };
    const gtQuery = vi.fn(() => orderedResult);
    const selectQuery = vi.fn(() => createScopedQuery({
      gt: gtQuery,
      in: inQuery,
    }));
    const from = vi.fn(() => ({ select: selectQuery }));
    const rpc = vi.fn().mockResolvedValue({ data: '2026-03-05T00:00:00.000Z', error: null });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service(), 'saveToLocal').mockResolvedValue(undefined);
    (service() as unknown as { lastSyncTime: string | null }).lastSyncTime = '2026-03-05T00:00:00.000Z';
    supabase.clientAsync.mockResolvedValue({ from, rpc });
    setBlackBoxEntries([pendingEntry]);

    await service().pullChanges({ reason: 'panel-open', force: true });

    expect(inQuery).toHaveBeenCalledWith('id', [entryId]);
    expect(blackBoxEntriesMap().get(entryId)).toEqual(
      expect.objectContaining({
        id: entryId,
        syncStatus: 'synced',
        updatedAt: remoteRow.updated_at,
      })
    );
}

async function runBlackBoxSyncRemoteReconcileSpec9(tools: BlackBoxSyncRemoteReconcileSpecTools): Promise<void> {
  const { service } = tools;

    const entryId = crypto.randomUUID();
    const pendingEntry = createEntry({
      id: entryId,
      updatedAt: '2026-03-05T00:00:00.000Z',
      syncStatus: 'pending',
      focusMeta: {
        source: 'focus-console-inline',
        sessionId: 'session-1',
        title: 'Inline task',
        detail: 'inline detail',
        lane: 'backup',
        expectedMinutes: 20,
        waitMinutes: 10,
        cognitiveLoad: 'low',
        dockEntryId: 'dock-entry-1',
      },
    });
    const remoteRow = {
      id: entryId,
      project_id: null,
      user_id: 'user-1',
      content: 'entry',
      focus_meta: {
        dockEntryId: 'dock-entry-1',
        cognitiveLoad: 'low',
        waitMinutes: 10,
        expectedMinutes: 20,
        lane: 'backup',
        detail: 'inline detail',
        title: 'Inline task',
        sessionId: 'session-1',
        source: 'focus-console-inline',
      },
      date: '2026-03-04',
      created_at: '2026-03-04T00:00:00.000Z',
      updated_at: '2026-03-04T00:00:00.000Z',
      is_read: false,
      is_completed: false,
      is_archived: false,
      snooze_until: null,
      snooze_count: 0,
      deleted_at: null,
    };
    const inQuery = vi.fn().mockResolvedValue({ data: [remoteRow], error: null });
    const orderedResult = {
      data: [],
      error: null,
      order: vi.fn(() => orderedResult),
    };
    const gtQuery = vi.fn(() => orderedResult);
    const selectQuery = vi.fn(() => createScopedQuery({
      gt: gtQuery,
      in: inQuery,
    }));
    const from = vi.fn(() => ({ select: selectQuery }));
    const rpc = vi.fn().mockResolvedValue({ data: '2026-03-05T00:00:00.000Z', error: null });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service(), 'saveToLocal').mockResolvedValue(undefined);
    (service() as unknown as { lastSyncTime: string | null }).lastSyncTime = '2026-03-05T00:00:00.000Z';
    supabase.clientAsync.mockResolvedValue({ from, rpc });
    setBlackBoxEntries([pendingEntry]);

    await service().pullChanges({ reason: 'panel-open', force: true });

    expect(blackBoxEntriesMap().get(entryId)).toEqual(
      expect.objectContaining({
        id: entryId,
        syncStatus: 'synced',
        focusMeta: expect.objectContaining({
          sessionId: 'session-1',
          dockEntryId: 'dock-entry-1',
        }),
      })
    );
}

async function runBlackBoxSyncRemoteReconcileSpec10(tools: BlackBoxSyncRemoteReconcileSpecTools): Promise<void> {
  const { service } = tools;

    const entryId = crypto.randomUUID();
    const pendingEntry = createLegacyEntryWithUndefinedDeletedAt(
      createEntry({
        id: entryId,
        createdAt: '2026-04-23T22:46:00.000Z',
        updatedAt: '2026-04-23T22:46:30.000Z',
        isRead: true,
        syncStatus: 'pending',
      })
    );
    const remoteRow = {
      id: entryId,
      project_id: null,
      user_id: 'user-1',
      content: 'entry',
      focus_meta: null,
      date: '2026-03-04',
      created_at: '2026-04-23T22:46:00+00:00',
      updated_at: '2026-04-23T22:46:30+00:00',
      is_read: true,
      is_completed: false,
      is_archived: false,
      snooze_until: null,
      snooze_count: null,
      deleted_at: null,
    };
    const inQuery = vi.fn().mockResolvedValue({ data: [remoteRow], error: null });
    const orderedResult = {
      data: [],
      error: null,
      order: vi.fn(() => orderedResult),
    };
    const gtQuery = vi.fn(() => orderedResult);
    const selectQuery = vi.fn(() => createScopedQuery({
      gt: gtQuery,
      in: inQuery,
    }));
    const from = vi.fn(() => ({ select: selectQuery }));
    const rpc = vi.fn().mockResolvedValue({ data: '2026-04-24T00:00:00.000Z', error: null });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service(), 'saveToLocal').mockResolvedValue(undefined);
    (service() as unknown as { lastSyncTime: string | null }).lastSyncTime = '2026-04-24T00:00:00.000Z';
    supabase.clientAsync.mockResolvedValue({ from, rpc });
    setBlackBoxEntries([pendingEntry]);

    await service().pullChanges({ reason: 'panel-open', force: true });

    expect(inQuery).toHaveBeenCalledWith('id', [entryId]);
    expect(blackBoxEntriesMap().get(entryId)).toEqual(
      expect.objectContaining({
        id: entryId,
        syncStatus: 'synced',
        createdAt: remoteRow.created_at,
        deletedAt: null,
      })
    );
}

async function runBlackBoxSyncRemoteReconcileSpec11(tools: BlackBoxSyncRemoteReconcileSpecTools): Promise<void> {
  const { service } = tools;

    const entryId = crypto.randomUUID();
    const pendingEntry = createEntry({
      id: entryId,
      updatedAt: '2026-03-05T00:00:00.000Z',
      syncStatus: 'pending',
      deletedAt: '2026-03-05T00:00:00.000Z',
    });
    const remoteRow = {
      id: entryId,
      project_id: null,
      user_id: 'user-1',
      content: 'entry',
      focus_meta: null,
      date: '2026-03-04',
      created_at: '2026-03-04T00:00:00.000Z',
      updated_at: '2026-03-04T00:00:00.000Z',
      is_read: false,
      is_completed: false,
      is_archived: false,
      snooze_until: null,
      snooze_count: 0,
      deleted_at: '2026-03-05T00:00:00.000Z',
    };
    const inQuery = vi.fn().mockResolvedValue({ data: [remoteRow], error: null });
    const orderedResult = {
      data: [],
      error: null,
      order: vi.fn(() => orderedResult),
    };
    const gtQuery = vi.fn(() => orderedResult);
    const selectQuery = vi.fn(() => createScopedQuery({
      gt: gtQuery,
      in: inQuery,
    }));
    const from = vi.fn(() => ({ select: selectQuery }));
    const rpc = vi.fn().mockResolvedValue({ data: '2026-03-05T00:00:00.000Z', error: null });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service(), 'saveToLocal').mockResolvedValue(undefined);
    (service() as unknown as { lastSyncTime: string | null }).lastSyncTime = '2026-03-05T00:00:00.000Z';
    supabase.clientAsync.mockResolvedValue({ from, rpc });
    setBlackBoxEntries([pendingEntry]);

    await service().pullChanges({ reason: 'panel-open', force: true });

    expect(blackBoxEntriesMap().get(entryId)).toEqual(
      expect.objectContaining({
        id: entryId,
        syncStatus: 'synced',
        deletedAt: remoteRow.deleted_at,
      })
    );
}
