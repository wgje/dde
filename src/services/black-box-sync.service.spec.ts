import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { BlackBoxSyncService } from './black-box-sync.service';
import { SupabaseClientService } from './supabase-client.service';
import { NetworkAwarenessService } from './network-awareness.service';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { AuthService } from './auth.service';
import { ClockSyncService } from './clock-sync.service';
import { SessionManagerService } from '../app/core/services/sync/session-manager.service';
import { blackBoxEntriesMap, setBlackBoxEntries } from '../state/focus-stores';
import type { BlackBoxEntry } from '../models/focus';

function createEntry(overrides: Partial<BlackBoxEntry> & Pick<BlackBoxEntry, 'id'>): BlackBoxEntry {
  return {
    id: overrides.id,
    projectId: null,
    userId: 'user-1',
    content: 'entry',
    date: '2026-03-04',
    createdAt: '2026-03-04T00:00:00.000Z',
    updatedAt: '2026-03-04T00:00:00.000Z',
    isRead: false,
    isCompleted: false,
    isArchived: false,
    deletedAt: null,
    ...overrides,
  };
}

async function flushMicrotasks(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

describe('BlackBoxSyncService', () => {
  let service: BlackBoxSyncService;
  let initDbSpy: ReturnType<typeof vi.spyOn>;
  let setupNetworkSpy: ReturnType<typeof vi.spyOn>;
  let mockSentry: { addBreadcrumb: ReturnType<typeof vi.fn>; captureMessage: ReturnType<typeof vi.fn> };
  let authSignals: {
    sessionInitialized: ReturnType<typeof signal<boolean>>;
    runtimeState: ReturnType<typeof signal<'idle' | 'pending' | 'ready' | 'failed'>>;
    authState: ReturnType<typeof signal<{ isCheckingSession: boolean; isLoading: boolean; userId: string | null; email: string | null; error: string | null }>>;
    currentUserId: ReturnType<typeof signal<string | null>>;
  };

  beforeEach(() => {
    initDbSpy = vi.spyOn(
      BlackBoxSyncService.prototype as unknown as { initIndexedDB: () => Promise<void> },
      'initIndexedDB'
    ).mockResolvedValue(undefined);
    setupNetworkSpy = vi.spyOn(
      BlackBoxSyncService.prototype as unknown as { setupNetworkListener: () => void },
      'setupNetworkListener'
    ).mockImplementation(() => {});

    mockSentry = {
      addBreadcrumb: vi.fn(),
      captureMessage: vi.fn(),
    };

    authSignals = {
      sessionInitialized: signal(true),
      runtimeState: signal<'idle' | 'pending' | 'ready' | 'failed'>('ready'),
      authState: signal({
        isCheckingSession: false,
        isLoading: false,
        userId: 'user-1',
        email: null,
        error: null,
      }),
      currentUserId: signal<string | null>('user-1'),
    };

    TestBed.configureTestingModule({
      providers: [
        BlackBoxSyncService,
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            isOfflineMode: vi.fn(() => false),
            clientAsync: vi.fn().mockResolvedValue({}),
          },
        },
        {
          provide: NetworkAwarenessService,
          useValue: {
            isOnline: vi.fn(() => true),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn(() => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            })),
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUserId: authSignals.currentUserId,
            isConfigured: true,
            sessionInitialized: authSignals.sessionInitialized,
            authState: authSignals.authState,
            runtimeState: authSignals.runtimeState,
            peekPersistedSessionIdentity: vi.fn(() => ({ userId: 'user-1' })),
          },
        },
        {
          provide: ClockSyncService,
          useValue: {
            isLocalNewer: vi.fn((left: string, right: string) => new Date(left).getTime() > new Date(right).getTime()),
            recordServerTimestamp: vi.fn(),
            lastSyncResult: vi.fn(() => ({ reliable: true })),
            needsResync: vi.fn(() => false),
            checkClockDrift: vi.fn().mockResolvedValue({ reliable: true }),
            ensureSynced: vi.fn().mockResolvedValue({ reliable: true }),
          },
        },
        {
          provide: SessionManagerService,
          useValue: {
            isSessionExpiredError: vi.fn(() => false),
            tryRefreshSessionWithSession: vi.fn().mockResolvedValue({ refreshed: false }),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: mockSentry,
        },
      ],
    });

    service = TestBed.inject(BlackBoxSyncService);
  });

  afterEach(() => {
    initDbSpy.mockRestore();
    setupNetworkSpy.mockRestore();
    setBlackBoxEntries([]);
  });

  it('should apply resume pull cooldown by default', async () => {
    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<void> },
      'doPullChanges'
    ).mockResolvedValue(true);

    await service.pullChanges({ reason: 'resume' });
    await service.pullChanges({ reason: 'resume' });

    expect(doPullSpy).toHaveBeenCalledTimes(1);
  });

  it('should bypass cooldown when force=true', async () => {
    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<void> },
      'doPullChanges'
    ).mockResolvedValue(true);

    await service.pullChanges({ reason: 'resume' });
    await service.pullChanges({ reason: 'resume', force: true });

    expect(doPullSpy).toHaveBeenCalledTimes(2);
  });

  it('should reuse in-flight pull promise (single-flight)', async () => {
    let resolvePull: (() => void) | null = null;
    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<void> },
      'doPullChanges'
    ).mockReturnValue(new Promise<boolean>(resolve => {
      resolvePull = () => resolve(true);
    }));

    const p1 = service.pullChanges({ reason: 'resume', force: true });
    const p2 = service.pullChanges({ reason: 'resume', force: true });

    expect(doPullSpy).toHaveBeenCalledTimes(1);

    resolvePull!();
    await Promise.all([p1, p2]);
  });

  it('should fall back to local cache when remote transport is marked unavailable', async () => {
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      isOfflineMode: ReturnType<typeof vi.fn>;
    };
    supabase.isOfflineMode.mockReturnValue(true);

    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<void> },
      'doPullChanges'
    ).mockResolvedValue(true);
    const loadLocalSpy = vi.spyOn(
      service as unknown as { loadFromLocal: () => Promise<unknown[]> },
      'loadFromLocal'
    ).mockResolvedValue([]);

    await service.pullChanges({ reason: 'resume', force: true });

    expect(doPullSpy).not.toHaveBeenCalled();
    expect(loadLocalSpy).toHaveBeenCalledTimes(1);
  });

  it('should block duplicate pull by freshness window and report to Sentry', async () => {
    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<void> },
      'doPullChanges'
    ).mockResolvedValue(true);

    // 首次拉取成功
    await service.pullChanges({ reason: 'manual', force: true });
    expect(doPullSpy).toHaveBeenCalledTimes(1);

    // 窗口内第二次调用应被阻断
    await service.pullChanges({ reason: 'manual' });
    expect(doPullSpy).toHaveBeenCalledTimes(1);

    // 验证结构化 Sentry 上报
    expect(mockSentry.captureMessage).toHaveBeenCalledWith(
      'BlackBox duplicate pull blocked',
      expect.objectContaining({
        level: 'info',
        tags: expect.objectContaining({
          classification: 'duplicate_blocked',
        }),
      })
    );
  });

  it('should bypass freshness window when pending entries need authoritative reconcile', async () => {
    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<void> },
      'doPullChanges'
    ).mockResolvedValue(true);
    const pendingEntry = createEntry({
      id: crypto.randomUUID(),
      syncStatus: 'pending',
    });

    setBlackBoxEntries([pendingEntry]);
    (service as unknown as { lastPullTime: number }).lastPullTime = Date.now();

    await service.pullChanges({ reason: 'panel-open' });

    expect(doPullSpy).toHaveBeenCalledTimes(1);
    expect(mockSentry.captureMessage).not.toHaveBeenCalled();
  });

  it('should bypass resume cooldown when pending entries need authoritative reconcile', async () => {
    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<void> },
      'doPullChanges'
    ).mockResolvedValue(true);
    const pendingEntry = createEntry({
      id: crypto.randomUUID(),
      syncStatus: 'pending',
    });

    setBlackBoxEntries([pendingEntry]);
    (service as unknown as { lastResumePullAt: number }).lastResumePullAt = Date.now();

    await service.pullChanges({ reason: 'resume' });

    expect(doPullSpy).toHaveBeenCalledTimes(1);
  });

  it('should not report passive view refresh duplicates to Sentry', async () => {
    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<void> },
      'doPullChanges'
    ).mockResolvedValue(true);

    await service.pullChanges({ reason: 'panel-open', force: true });
    mockSentry.captureMessage.mockClear();

    await service.pullChanges({ reason: 'panel-open' });

    expect(doPullSpy).toHaveBeenCalledTimes(1);
    expect(mockSentry.captureMessage).not.toHaveBeenCalled();
  });

  it('should skip stale push payloads when a newer local snapshot already exists', async () => {
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
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };

    setBlackBoxEntries([newerEntry]);
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(olderEntry)).resolves.toBe(true);
    expect(from).not.toHaveBeenCalled();
  });

  it('should not overwrite a newer local snapshot that arrives while an older push is in flight', async () => {
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
    const from = vi.fn(() => ({
      upsert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn(async () => {
            setBlackBoxEntries([newerEntry]);
            return {
              data: { updated_at: olderEntry.updatedAt },
              error: null,
            };
          }),
        })),
      })),
    }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    const saveToLocalSpy = vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);

    setBlackBoxEntries([olderEntry]);
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(olderEntry)).resolves.toBe(true);
    expect(saveToLocalSpy).not.toHaveBeenCalled();
    expect(blackBoxEntriesMap().get(entryId)).toEqual(expect.objectContaining({
      updatedAt: newerEntry.updatedAt,
      isCompleted: true,
    }));
  });

  it('should not overwrite a newer local pending snapshot when preflight sees a newer server row', async () => {
    const entryId = crypto.randomUUID();
    const olderEntry = createEntry({
      id: entryId,
      updatedAt: '2026-03-04T00:00:00.000Z',
      isCompleted: false,
    });
    const newerLocalEntry = createEntry({
      id: entryId,
      updatedAt: '2026-03-04T00:00:05.000Z',
      isCompleted: true,
      syncStatus: 'pending',
    });
    const serverRow = {
      id: entryId,
      project_id: null,
      user_id: 'user-1',
      content: 'entry',
      focus_meta: null,
      date: '2026-03-04',
      created_at: '2026-03-04T00:00:00.000Z',
      updated_at: '2026-03-04T00:00:03.000Z',
      is_read: false,
      is_completed: false,
      is_archived: false,
      snooze_until: null,
      snooze_count: 0,
      deleted_at: null,
    };
    const maybeSingle = vi.fn(async () => {
      setBlackBoxEntries([newerLocalEntry]);
      return { data: serverRow, error: null };
    });
    const select = vi.fn(() => ({
      eq: vi.fn(() => ({ maybeSingle })),
    }));
    const upsert = vi.fn();
    const from = vi.fn(() => ({ select, upsert }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    const saveToLocalSpy = vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);

    setBlackBoxEntries([olderEntry]);
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(olderEntry)).resolves.toBe(true);

    expect(upsert).not.toHaveBeenCalled();
    expect(saveToLocalSpy).not.toHaveBeenCalledWith(expect.objectContaining({
      updatedAt: serverRow.updated_at,
    }));
    expect(blackBoxEntriesMap().get(entryId)).toEqual(expect.objectContaining({
      updatedAt: newerLocalEntry.updatedAt,
      isCompleted: true,
      syncStatus: 'pending',
    }));
  });
  it('should map focus_meta from database row into focusMeta', () => {
    const mapRowToEntry = (service as unknown as {
      mapRowToEntry: (row: Record<string, unknown>) => { focusMeta?: unknown };
    }).mapRowToEntry.bind(service);

    const mapped = mapRowToEntry({
      id: 'entry-1',
      project_id: null,
      user_id: 'user-1',
      content: 'inline detail',
      focus_meta: {
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
      date: '2026-03-04',
      created_at: '2026-03-04T00:00:00.000Z',
      updated_at: '2026-03-04T00:00:00.000Z',
      is_read: false,
      is_completed: false,
      is_archived: false,
      snooze_until: null,
      snooze_count: 0,
      deleted_at: null,
    });

    expect(mapped.focusMeta).toEqual({
      source: 'focus-console-inline',
      sessionId: 'session-1',
      title: 'Inline task',
      detail: 'inline detail',
      lane: 'backup',
      expectedMinutes: 20,
      waitMinutes: 10,
      cognitiveLoad: 'low',
      dockEntryId: 'dock-entry-1',
    });
  });

  it('should reconcile pending local entries against server rows even when delta pull returns empty', async () => {
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
    const orderQuery = vi.fn().mockResolvedValue({ data: [], error: null });
    const gtQuery = vi.fn(() => ({ order: orderQuery }));
    const selectQuery = vi.fn(() => ({
      gt: gtQuery,
      in: inQuery,
    }));
    const from = vi.fn(() => ({ select: selectQuery }));
    const rpc = vi.fn().mockResolvedValue({ data: '2026-03-05T00:00:00.000Z', error: null });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    (service as unknown as { lastSyncTime: string | null }).lastSyncTime = '2026-03-05T00:00:00.000Z';
    supabase.clientAsync.mockResolvedValue({ from, rpc });
    setBlackBoxEntries([pendingEntry]);

    await service.pullChanges({ reason: 'panel-open', force: true });

    expect(inQuery).toHaveBeenCalledWith('id', [entryId]);
    expect(blackBoxEntriesMap().get(entryId)?.syncStatus).toBe('synced');
  });

  it('should clear pending when server already reflects the same newer-local mutation', async () => {
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
    const orderQuery = vi.fn().mockResolvedValue({ data: [], error: null });
    const gtQuery = vi.fn(() => ({ order: orderQuery }));
    const selectQuery = vi.fn(() => ({
      gt: gtQuery,
      in: inQuery,
    }));
    const from = vi.fn(() => ({ select: selectQuery }));
    const rpc = vi.fn().mockResolvedValue({ data: '2026-03-05T00:00:00.000Z', error: null });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    (service as unknown as { lastSyncTime: string | null }).lastSyncTime = '2026-03-05T00:00:00.000Z';
    supabase.clientAsync.mockResolvedValue({ from, rpc });
    setBlackBoxEntries([pendingEntry]);

    await service.pullChanges({ reason: 'panel-open', force: true });

    expect(inQuery).toHaveBeenCalledWith('id', [entryId]);
    expect(blackBoxEntriesMap().get(entryId)).toEqual(
      expect.objectContaining({
        id: entryId,
        syncStatus: 'synced',
        updatedAt: remoteRow.updated_at,
      })
    );
  });

  it('should reconcile pending entries with equivalent focusMeta even when json key order differs', async () => {
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
    const orderQuery = vi.fn().mockResolvedValue({ data: [], error: null });
    const gtQuery = vi.fn(() => ({ order: orderQuery }));
    const selectQuery = vi.fn(() => ({
      gt: gtQuery,
      in: inQuery,
    }));
    const from = vi.fn(() => ({ select: selectQuery }));
    const rpc = vi.fn().mockResolvedValue({ data: '2026-03-05T00:00:00.000Z', error: null });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    (service as unknown as { lastSyncTime: string | null }).lastSyncTime = '2026-03-05T00:00:00.000Z';
    supabase.clientAsync.mockResolvedValue({ from, rpc });
    setBlackBoxEntries([pendingEntry]);

    await service.pullChanges({ reason: 'panel-open', force: true });

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
  });

  it('should reconcile pending deleted tombstones against server tombstones', async () => {
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
    const orderQuery = vi.fn().mockResolvedValue({ data: [], error: null });
    const gtQuery = vi.fn(() => ({ order: orderQuery }));
    const selectQuery = vi.fn(() => ({
      gt: gtQuery,
      in: inQuery,
    }));
    const from = vi.fn(() => ({ select: selectQuery }));
    const rpc = vi.fn().mockResolvedValue({ data: '2026-03-05T00:00:00.000Z', error: null });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    (service as unknown as { lastSyncTime: string | null }).lastSyncTime = '2026-03-05T00:00:00.000Z';
    supabase.clientAsync.mockResolvedValue({ from, rpc });
    setBlackBoxEntries([pendingEntry]);

    await service.pullChanges({ reason: 'panel-open', force: true });

    expect(blackBoxEntriesMap().get(entryId)).toEqual(
      expect.objectContaining({
        id: entryId,
        syncStatus: 'synced',
        deletedAt: remoteRow.deleted_at,
      })
    );
  });

  it('should skip startup retry recovery when server already has a newer authoritative row', async () => {
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
    const selectQuery = vi.fn(() => ({ in: inQuery }));
    const from = vi.fn(() => ({ select: selectQuery }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service, 'loadFromLocal').mockResolvedValue([pendingEntry]);
    vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    supabase.clientAsync.mockResolvedValue({ from });
    setBlackBoxEntries([pendingEntry]);
    (service as unknown as { retryQueueHandler: ((entry: BlackBoxEntry) => void) | null }).retryQueueHandler = enqueue;

    await (service as unknown as { recoverPendingEntries: () => Promise<void> }).recoverPendingEntries();

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
  });

  it('should keep startup pending recovery local-only when network is offline', async () => {
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
    vi.spyOn(service, 'loadFromLocal').mockResolvedValue([pendingEntry]);
    setBlackBoxEntries([pendingEntry]);
    network.isOnline.mockReturnValue(false);
    (service as unknown as { retryQueueHandler: ((entry: BlackBoxEntry) => void) | null }).retryQueueHandler = enqueue;

    await (service as unknown as { recoverPendingEntries: () => Promise<void> }).recoverPendingEntries();

    expect(supabase.clientAsync).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(pendingEntry);
  });

  it('should rerun pending recovery after auth settles and suppress stale startup pending rows', async () => {
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
    const selectQuery = vi.fn(() => ({ in: inQuery }));
    const from = vi.fn(() => ({ select: selectQuery }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service, 'loadFromLocal').mockResolvedValue([pendingEntry]);
    vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    supabase.clientAsync.mockResolvedValue({ from });
    setBlackBoxEntries([pendingEntry]);

    authSignals.sessionInitialized.set(false);
    authSignals.runtimeState.set('pending');
    authSignals.currentUserId.set(null);

    service.setRetryQueueHandler(enqueue);
    await flushMicrotasks();

    expect(enqueue).not.toHaveBeenCalled();
    expect(supabase.clientAsync).not.toHaveBeenCalled();

    authSignals.currentUserId.set('user-1');
    authSignals.authState.update(state => ({ ...state, userId: 'user-1', isCheckingSession: false }));
    authSignals.sessionInitialized.set(true);
    authSignals.runtimeState.set('ready');

    await flushMicrotasks();

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
  });

  it('loadFromLocal 应只恢复当前用户的黑匣子条目', async () => {
    const foreignEntry = {
      id: 'entry-foreign',
      projectId: null,
      userId: 'user-2',
      content: 'foreign',
      date: '2026-03-04',
      createdAt: '2026-03-04T00:00:00.000Z',
      updatedAt: '2026-03-04T00:00:00.000Z',
      isRead: false,
      isCompleted: false,
      isArchived: false,
      deletedAt: null,
    };
    const ownEntry = {
      ...foreignEntry,
      id: 'entry-own',
      userId: 'user-1',
      content: 'own',
    };
    const getAll = vi.fn();
    const transaction = vi.fn(() => ({
      objectStore: vi.fn(() => ({
        getAll: () => {
          const request = {
            result: [ownEntry, foreignEntry],
            onsuccess: null as ((this: IDBRequest<unknown[]>, ev: Event) => unknown) | null,
            onerror: null as ((this: IDBRequest<unknown[]>, ev: Event) => unknown) | null,
          };
          queueMicrotask(() => request.onsuccess?.call(request as unknown as IDBRequest<unknown[]>, new Event('success')));
          getAll();
          return request;
        },
      })),
    }));
    (service as unknown as { db: unknown }).db = { transaction };

    const entries = await service.loadFromLocal();

    expect(getAll).toHaveBeenCalledTimes(1);
    expect(entries).toEqual([expect.objectContaining({ id: 'entry-own', userId: 'user-1' })]);
  });
});
