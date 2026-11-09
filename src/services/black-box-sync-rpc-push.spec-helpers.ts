import { TestBed } from '@angular/core/testing';
import { expect, it, vi } from 'vitest';

import { blackBoxEntriesMap, setBlackBoxEntries } from '../state/focus-stores';
import { BlackBoxSyncService } from './black-box-sync.service';
import { createEntry, createPreflightQuery } from './black-box-sync.spec-helpers';
import { DataSafetyAuditPersistence } from './data-safety-audit-persistence';
import { SupabaseClientService } from './supabase-client.service';

type MockSentry = {
  addBreadcrumb: ReturnType<typeof vi.fn>;
  captureMessage: ReturnType<typeof vi.fn>;
};

type MockSyncRpcClient = {
  isFeatureEnabled: ReturnType<typeof vi.fn>;
  isClientRejected: ReturnType<typeof vi.fn>;
  upsertBlackboxEntry: ReturnType<typeof vi.fn>;
};

interface BlackBoxSyncRpcPushSpecContext {
  getService: () => BlackBoxSyncService;
  getMockSentry: () => MockSentry;
  getMockSyncRpcClient: () => MockSyncRpcClient;
}

export function registerBlackBoxSyncRpcPushSpecs(context: BlackBoxSyncRpcPushSpecContext): void {
  let service: BlackBoxSyncService;
  let mockSentry: MockSentry;
  let mockSyncRpcClient: MockSyncRpcClient;

  beforeEach(() => {
    service = context.getService();
    mockSentry = context.getMockSentry();
    mockSyncRpcClient = context.getMockSyncRpcClient();
    new DataSafetyAuditPersistence().save('user-1', { replayLog: [], lastWriteExplain: null });
  });

  it('should use sync RPC for black box pushes when the feature flag is enabled', async () => {
    const operationId = 'op-blackbox-rpc-push';
    const entry = createEntry({
      id: crypto.randomUUID(),
      updatedAt: '2026-03-04T00:00:00.000Z',
      syncStatus: 'pending',
    });
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.upsertBlackboxEntry.mockResolvedValueOnce({
      status: 'applied',
      serverUpdatedAt: '2026-03-04T00:00:01.000Z',
      raw: {},
    });
    const maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    const preflightQuery = createPreflightQuery(maybeSingle);
    const upsert = vi.fn();
    const from = vi.fn(() => ({
      select: vi.fn(() => preflightQuery),
      upsert,
    }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    const saveToLocalSpy = vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    setBlackBoxEntries([entry]);
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(entry, 'user-1', operationId)).resolves.toBe(true);

    expect(preflightQuery.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(preflightQuery.eq).toHaveBeenCalledWith('id', entry.id);
    expect(mockSyncRpcClient.upsertBlackboxEntry).toHaveBeenCalledWith(expect.objectContaining({
      operationId,
      entry,
      baseUpdatedAt: null,
    }));
    expect(upsert).not.toHaveBeenCalled();
    expect(saveToLocalSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: entry.id,
      updatedAt: '2026-03-04T00:00:01.000Z',
      syncStatus: 'synced',
    }));
  });

  it('should reject sync RPC black box pushes without a stable operationId', async () => {
    const entry = createEntry({
      id: crypto.randomUUID(),
      updatedAt: '2026-03-04T00:00:00.000Z',
      syncStatus: 'pending',
    });
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    const preflightQuery = createPreflightQuery(maybeSingle);
    const upsert = vi.fn();
    const from = vi.fn(() => ({
      select: vi.fn(() => preflightQuery),
      upsert,
    }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    setBlackBoxEntries([entry]);
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(entry, 'user-1')).resolves.toBe(false);

    expect(mockSyncRpcClient.upsertBlackboxEntry).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('should keep operationId black box pushes pending when sync RPC is unavailable', async () => {
    const operationId = 'op-blackbox-rpc-unavailable';
    const entry = createEntry({
      id: crypto.randomUUID(),
      updatedAt: '2026-03-04T00:00:00.000Z',
      syncStatus: 'pending',
    });
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    const maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    const preflightQuery = createPreflightQuery(maybeSingle);
    const insert = vi.fn(() => ({
      select: vi.fn(() => ({
        single: vi.fn(async () => ({
          data: { id: entry.id, updated_at: '2026-03-04T00:00:01.000Z' },
          error: null,
        })),
      })),
    }));
    const update = vi.fn();
    const from = vi.fn(() => ({
      select: vi.fn(() => preflightQuery),
      insert,
      update,
    }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    setBlackBoxEntries([entry]);
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(entry, 'user-1', operationId)).resolves.toBe(false);

    expect(mockSyncRpcClient.upsertBlackboxEntry).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(blackBoxEntriesMap().get(entry.id)).toEqual(expect.objectContaining({
      id: entry.id,
      syncStatus: 'pending',
    }));
  });

  it('should persist last write explain and replay entry after sync RPC applies a black box push', async () => {
    const operationId = 'op-blackbox-rpc-audit';
    const entry = createEntry({
      id: crypto.randomUUID(),
      updatedAt: '2026-03-04T00:00:00.000Z',
      syncStatus: 'pending',
    });
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.upsertBlackboxEntry.mockResolvedValueOnce({
      status: 'applied',
      serverUpdatedAt: '2026-03-04T00:00:01.000Z',
      raw: {},
    });
    const maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    const preflightQuery = createPreflightQuery(maybeSingle);
    const upsert = vi.fn();
    const from = vi.fn(() => ({
      select: vi.fn(() => preflightQuery),
      upsert,
    }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    setBlackBoxEntries([entry]);
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(entry, 'user-1', operationId)).resolves.toBe(true);

    const audit = new DataSafetyAuditPersistence().load('user-1');
    expect(audit.lastWriteExplain).toMatchObject({
      operationId,
      actor: { sourceUserId: 'user-1' },
      entity: { type: 'blackbox', id: entry.id },
      operation: 'upsert',
      updatedAtBaseline: null,
      beforeVersion: entry.updatedAt,
      afterVersion: '2026-03-04T00:00:01.000Z',
      queueResult: { enteredRetryQueue: false, retryCount: 0 },
      rpcResult: { status: 'applied', serverUpdatedAt: '2026-03-04T00:00:01.000Z' },
      lwwDecision: { decision: 'local-applied', reason: 'applied' },
      lastSyncTime: { before: null, after: null, advanced: false },
    });
    expect(audit.replayLog[0]).toMatchObject({
      operationId,
      entityType: 'blackbox',
      entityId: entry.id,
      operation: 'upsert',
      baseUpdatedAt: null,
      queue: { enteredRetryQueue: false, retryCount: 0 },
      rpc: { status: 'applied', serverUpdatedAt: '2026-03-04T00:00:01.000Z' },
      lww: { decision: 'local-applied', reason: 'applied' },
      lastSyncTime: { before: null, after: null, advanced: false },
    });
  });

  it('should hydrate a blank retry payload from the latest local black box content before RPC push', async () => {
    const operationId = 'op-blackbox-rpc-hydrate';
    const entryId = crypto.randomUUID();
    const queuedEntry = createEntry({
      id: entryId,
      content: '',
      updatedAt: '2026-03-04T00:00:00.000Z',
      syncStatus: 'pending',
    });
    const latestLocalEntry = createEntry({
      id: entryId,
      content: 'local full content',
      updatedAt: queuedEntry.updatedAt,
      syncStatus: 'pending',
    });
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.upsertBlackboxEntry.mockResolvedValueOnce({
      status: 'applied',
      serverUpdatedAt: '2026-03-04T00:00:01.000Z',
      raw: {},
    });
    const maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    const preflightQuery = createPreflightQuery(maybeSingle);
    const upsert = vi.fn();
    const from = vi.fn(() => ({
      select: vi.fn(() => preflightQuery),
      upsert,
    }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    const saveToLocalSpy = vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    setBlackBoxEntries([latestLocalEntry]);
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(queuedEntry, 'user-1', operationId)).resolves.toBe(true);

    expect(mockSyncRpcClient.upsertBlackboxEntry).toHaveBeenCalledWith(expect.objectContaining({
      operationId,
      entry: expect.objectContaining({
        id: entryId,
        content: 'local full content',
      }),
    }));
    expect(upsert).not.toHaveBeenCalled();
    expect(saveToLocalSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: entryId,
      content: 'local full content',
      syncStatus: 'synced',
    }));
  });

  it('should preserve existing server black box content when a blank retry payload is replayed', async () => {
    const operationId = 'op-blackbox-rpc-preserve-server-content';
    const entryId = crypto.randomUUID();
    const queuedEntry = createEntry({
      id: entryId,
      content: '',
      updatedAt: '2026-03-04T00:00:05.000Z',
      isCompleted: true,
      syncStatus: 'pending',
    });
    const serverRow = {
      id: entryId,
      project_id: null,
      user_id: 'user-1',
      content: 'server full content',
      focus_meta: null,
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
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.upsertBlackboxEntry.mockResolvedValueOnce({
      status: 'applied',
      serverUpdatedAt: '2026-03-04T00:00:06.000Z',
      raw: {},
    });
    const maybeSingle = vi.fn(async () => ({ data: serverRow, error: null }));
    const preflightQuery = createPreflightQuery(maybeSingle);
    const upsert = vi.fn();
    const from = vi.fn(() => ({
      select: vi.fn(() => preflightQuery),
      upsert,
    }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    const saveToLocalSpy = vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    setBlackBoxEntries([queuedEntry]);
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(queuedEntry, 'user-1', operationId)).resolves.toBe(true);

    expect(mockSyncRpcClient.upsertBlackboxEntry).toHaveBeenCalledWith(expect.objectContaining({
      operationId,
      entry: expect.objectContaining({
        id: entryId,
        content: 'server full content',
        isCompleted: true,
      }),
      baseUpdatedAt: serverRow.updated_at,
    }));
    expect(upsert).not.toHaveBeenCalled();
    expect(saveToLocalSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: entryId,
      content: 'server full content',
      syncStatus: 'synced',
    }));
  });

  it('should reconcile local pending state when sync RPC reports remote-newer', async () => {
    const operationId = 'op-blackbox-rpc-remote-newer';
    const entry = createEntry({
      id: crypto.randomUUID(),
      updatedAt: '2026-03-04T00:00:00.000Z',
      syncStatus: 'pending',
    });
    const remoteRow = {
      id: entry.id,
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
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.upsertBlackboxEntry.mockResolvedValueOnce({
      status: 'remote-newer',
      remoteUpdatedAt: '2026-03-04T00:00:05.000Z',
      raw: {},
    });
    const maybeSingle = vi.fn()
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: remoteRow, error: null });
    const preflightQuery = createPreflightQuery(maybeSingle);
    const upsert = vi.fn();
    const from = vi.fn(() => ({
      select: vi.fn(() => preflightQuery),
      upsert,
    }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    const saveToLocalSpy = vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    setBlackBoxEntries([entry]);
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(entry, 'user-1', operationId)).resolves.toBe(true);

    expect(upsert).not.toHaveBeenCalled();
    expect(saveToLocalSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: entry.id,
      isCompleted: true,
      syncStatus: 'synced',
    }));
    expect(blackBoxEntriesMap().get(entry.id)).toEqual(expect.objectContaining({
      isCompleted: true,
      syncStatus: 'synced',
    }));
    expect(mockSentry.captureMessage).toHaveBeenCalledWith(
      'sync_rpc_blackbox_remote_newer',
      expect.objectContaining({ level: 'warning' }),
    );

    const audit = new DataSafetyAuditPersistence().load('user-1');
    expect(audit.lastWriteExplain).toMatchObject({
      operationId,
      actor: { sourceUserId: 'user-1' },
      entity: { type: 'blackbox', id: entry.id },
      operation: 'upsert',
      updatedAtBaseline: null,
      beforeVersion: entry.updatedAt,
      afterVersion: '2026-03-04T00:00:05.000Z',
      queueResult: { enteredRetryQueue: false, retryCount: 0 },
      rpcResult: { status: 'remote-newer', remoteUpdatedAt: '2026-03-04T00:00:05.000Z' },
      lwwDecision: { decision: 'remote-kept', reason: 'remote-newer' },
      lastSyncTime: { before: null, after: null, advanced: false },
    });
    expect(audit.replayLog[0]).toMatchObject({
      operationId,
      entityType: 'blackbox',
      entityId: entry.id,
      operation: 'upsert',
      baseUpdatedAt: null,
      queue: { enteredRetryQueue: false, retryCount: 0 },
      rpc: { status: 'remote-newer', remoteUpdatedAt: '2026-03-04T00:00:05.000Z' },
      lww: { decision: 'remote-kept', reason: 'remote-newer' },
    });
  });

  it('should reconcile server authority instead of marking stale RPC payload as synced', async () => {
    const operationId = 'op-blackbox-rpc-stale-payload';
    const entry = createEntry({
      id: crypto.randomUUID(),
      updatedAt: '2026-03-04T00:00:00.000Z',
      isCompleted: false,
      syncStatus: 'pending',
    });
    const remoteRow = {
      id: entry.id,
      project_id: null,
      user_id: 'user-1',
      content: 'entry',
      focus_meta: null,
      date: '2026-03-04',
      created_at: '2026-03-04T00:00:00.000Z',
      updated_at: '2026-03-04T00:00:08.000Z',
      is_read: false,
      is_completed: true,
      is_archived: false,
      snooze_until: null,
      snooze_count: 0,
      deleted_at: null,
    };
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.upsertBlackboxEntry.mockResolvedValueOnce({
      status: 'applied',
      serverUpdatedAt: '2026-03-04T00:00:08.000Z',
      stalePayload: true,
      raw: { stale_payload: true },
    });
    const maybeSingle = vi.fn()
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: remoteRow, error: null });
    const preflightQuery = createPreflightQuery(maybeSingle);
    const upsert = vi.fn();
    const from = vi.fn(() => ({
      select: vi.fn(() => preflightQuery),
      upsert,
    }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    const saveToLocalSpy = vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    setBlackBoxEntries([entry]);
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(entry, 'user-1', operationId)).resolves.toBe(true);

    expect(upsert).not.toHaveBeenCalled();
    expect(saveToLocalSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: entry.id,
      isCompleted: true,
      syncStatus: 'synced',
    }));
    expect(saveToLocalSpy).not.toHaveBeenCalledWith(expect.objectContaining({
      id: entry.id,
      isCompleted: false,
      syncStatus: 'synced',
    }));
  });

  it('should defer push when preflight cannot be scoped by user id', async () => {
    const entry = createEntry({
      id: crypto.randomUUID(),
      updatedAt: '2026-03-04T00:00:00.000Z',
      syncStatus: 'pending',
    });
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const select = vi.fn(() => ({
      maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    }));
    const upsert = vi.fn();
    const from = vi.fn(() => ({ select, upsert }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    setBlackBoxEntries([entry]);
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(entry)).resolves.toBe(false);

    expect(mockSyncRpcClient.upsertBlackboxEntry).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(blackBoxEntriesMap().get(entry.id)).toEqual(expect.objectContaining({
      id: entry.id,
      syncStatus: 'pending',
    }));
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
    const preflightQuery = createPreflightQuery(vi.fn(async () => ({ data: null, error: null })));
    const from = vi.fn(() => ({
      select: vi.fn(() => preflightQuery),
      insert: vi.fn(() => ({
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
      update: vi.fn(),
    }));
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    const saveToLocalSpy = vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);

    setBlackBoxEntries([olderEntry]);
    supabase.clientAsync.mockResolvedValue({ from });

    await expect(service.pushToServer(olderEntry)).resolves.toBe(true);
    // 【2026-05-18 根因修复·阶段 2】更晚的内存快照必须被持久化到 IDB，否则新会话冷启动
    // 时仍会看到旧的 olderEntry 并继续把"待同步"标签挂在 UI 上。
    // 但绝对不能用 olderEntry 覆盖 IDB——那才是这个测试要守住的本质不变量。
    expect(saveToLocalSpy).not.toHaveBeenCalledWith(expect.objectContaining({
      updatedAt: olderEntry.updatedAt,
    }));
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
    const preflightQuery = createPreflightQuery(maybeSingle);
    const select = vi.fn(() => preflightQuery);
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
}
