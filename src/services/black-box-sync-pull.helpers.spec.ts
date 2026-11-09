import { describe, expect, it, vi } from 'vitest';
import type { BlackBoxEntry } from '../models/focus';
import {
  applyBlackBoxCursorSafetyLookback,
  canConvergeMonotonicMergeToRemote,
  createBlackBoxPullContext,
  fetchBlackBoxDeltaPageQuery,
  mergeQueuedForcedGateReviewPullGuard,
  mapBlackBoxRowToEntry,
  parseBlackBoxRemoteWatermark,
  readBlackBoxRemoteWatermark,
  resolveBlackBoxCursorWindowProbe,
  resolveBlackBoxInFlightAction,
  resolveBlackBoxMergeDecision,
  resolveBlackBoxPullFreshnessSkip,
  resolveNextBlackBoxDeltaPageCursor,
  mergeRemoteMonotonicFactsIntoPending,
  shouldSkipBlackBoxPullForCooldown,
  shouldUseBlackBoxWatermarkFastPath,
} from './black-box-sync-pull.helpers';
import type { BlackBoxSupabaseClient } from './black-box-sync.types';

function entry(overrides: Partial<BlackBoxEntry> = {}): BlackBoxEntry {
  return {
    id: overrides.id ?? 'entry-1',
    projectId: overrides.projectId ?? 'project-1',
    userId: overrides.userId ?? 'user-1',
    content: overrides.content ?? 'content',
    date: overrides.date ?? '2026-06-09',
    createdAt: overrides.createdAt ?? '2026-06-09T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-06-09T00:00:00.000Z',
    completedAt: overrides.completedAt ?? null,
    isRead: overrides.isRead ?? false,
    isCompleted: overrides.isCompleted ?? false,
    isArchived: overrides.isArchived ?? false,
    snoozeUntil: overrides.snoozeUntil,
    snoozeCount: overrides.snoozeCount,
    deletedAt: overrides.deletedAt ?? null,
    syncStatus: overrides.syncStatus,
    focusMeta: overrides.focusMeta ?? null,
  };
}

describe('black-box-sync-pull.helpers', () => {
  it('pending 本地条目合并远端单调真值并保持 pending', () => {
    const local = entry({ syncStatus: 'pending', isRead: false, isCompleted: false });
    const remote = entry({
      isRead: true,
      isCompleted: true,
      completedAt: '2026-06-09T01:00:00.000Z',
      deletedAt: '2026-06-09T02:00:00.000Z',
    });

    expect(mergeRemoteMonotonicFactsIntoPending(local, remote)).toEqual({
      ...local,
      isRead: true,
      isCompleted: true,
      completedAt: '2026-06-09T01:00:00.000Z',
      deletedAt: '2026-06-09T02:00:00.000Z',
      syncStatus: 'pending',
    });
  });

  it('非 pending 或远端没有额外单调真值时不生成合并条目', () => {
    expect(mergeRemoteMonotonicFactsIntoPending(
      entry({ syncStatus: 'synced' }),
      entry({ isRead: true }),
    )).toBeNull();

    expect(mergeRemoteMonotonicFactsIntoPending(
      entry({ syncStatus: 'pending', isRead: true, isCompleted: true, deletedAt: '2026-06-09T02:00:00.000Z' }),
      entry({ isRead: false, isCompleted: false, deletedAt: null }),
    )).toBeNull();
  });

  it('单调合并条目仅在业务等价且本地不晚于远端时收敛为 synced', () => {
    const merged = entry({ updatedAt: '2026-06-09T00:00:00.000Z' });
    const remote = entry({ updatedAt: '2026-06-09T01:00:00.000Z' });

    expect(canConvergeMonotonicMergeToRemote(merged, remote, {
      hasEquivalentEntryState: () => true,
      isLocalNewer: () => false,
    })).toBe(true);

    expect(canConvergeMonotonicMergeToRemote(merged, remote, {
      hasEquivalentEntryState: () => true,
      isLocalNewer: () => true,
    })).toBe(false);

    expect(canConvergeMonotonicMergeToRemote(merged, remote, {
      hasEquivalentEntryState: () => false,
      isLocalNewer: () => false,
    })).toBe(false);
  });

  it('数据库行映射为 synced 黑匣子条目并填补默认值', () => {
    const mapped = mapBlackBoxRowToEntry({
      id: 'entry-1',
      project_id: null,
      user_id: 'user-1',
      content: null,
      focus_meta: null,
      is_read: true,
      deleted_at: null,
    }, () => new Date('2026-06-09T12:00:00.000Z'));

    expect(mapped).toEqual({
      id: 'entry-1',
      projectId: null,
      userId: 'user-1',
      content: '',
      focusMeta: null,
      date: '2026-06-09',
      createdAt: '2026-06-09T12:00:00.000Z',
      updatedAt: '2026-06-09T12:00:00.000Z',
      completedAt: null,
      isRead: true,
      isCompleted: false,
      isArchived: false,
      snoozeUntil: undefined,
      snoozeCount: undefined,
      deletedAt: null,
      syncStatus: 'synced',
    });
  });

  it('创建拉取上下文时合并显式选项、会话用户和 pending reconcile 标记', () => {
    expect(createBlackBoxPullContext({
      options: undefined,
      resolvedSessionUserId: 'user-session',
      pendingEntriesNeedRemoteReconciliation: true,
    })).toEqual({
      reason: 'manual',
      force: false,
      expectedUserId: 'user-session',
      expectedRealtimeGeneration: undefined,
      pendingEntriesNeedRemoteReconciliation: true,
    });

    expect(createBlackBoxPullContext({
      options: {
        reason: 'gate-review',
        force: true,
        expectedUserId: 'user-explicit',
        expectedRealtimeGeneration: 3,
      },
      resolvedSessionUserId: 'user-session',
      pendingEntriesNeedRemoteReconciliation: false,
    })).toEqual({
      reason: 'gate-review',
      force: true,
      expectedUserId: 'user-explicit',
      expectedRealtimeGeneration: 3,
      pendingEntriesNeedRemoteReconciliation: false,
    });

    expect(createBlackBoxPullContext({
      options: undefined,
      resolvedSessionUserId: null,
      pendingEntriesNeedRemoteReconciliation: false,
    }).expectedUserId).toBeUndefined();
  });

  it('游标安全回看只调整有效的非 epoch 时间', () => {
    expect(applyBlackBoxCursorSafetyLookback(
      '2026-06-09T00:00:30.000Z',
      30_000,
    )).toBe('2026-06-09T00:00:00.000Z');
    expect(applyBlackBoxCursorSafetyLookback('1970-01-01T00:00:00Z', 30_000))
      .toBe('1970-01-01T00:00:00Z');
    expect(applyBlackBoxCursorSafetyLookback('not-a-date', 30_000)).toBe('not-a-date');
  });

  it('分页游标决策使用完整页面的最后一行并暴露坏游标诊断', () => {
    const first = { id: '00000000-0000-4000-8000-000000000001', updated_at: '2026-06-09T00:00:00.000Z' };
    const second = { id: '00000000-0000-4000-8000-000000000002', updated_at: '2026-06-09T00:00:01.000Z' };

    expect(resolveNextBlackBoxDeltaPageCursor([first], 2)).toEqual({ outcome: { status: 'done' } });
    expect(resolveNextBlackBoxDeltaPageCursor([first, second], 2)).toEqual({
      outcome: {
        status: 'continue',
        pageCursor: {
          id: '00000000-0000-4000-8000-000000000002',
          updatedAt: '2026-06-09T00:00:01.000Z',
        },
      },
    });
    expect(resolveNextBlackBoxDeltaPageCursor([first, { updated_at: '2026-06-09T00:00:02.000Z' }], 2)).toEqual({
      outcome: { status: 'done' },
      missingCursorWarning: { hasId: false, hasUpdatedAt: true },
    });
  });

  it('in-flight 拉取决策区分复用、排队与继续', () => {
    const context = {
      reason: 'manual' as const,
      force: false,
      expectedUserId: 'user-1',
      expectedRealtimeGeneration: 1,
      pendingEntriesNeedRemoteReconciliation: false,
    };

    expect(resolveBlackBoxInFlightAction(false, null, context)).toBe('continue');
    expect(resolveBlackBoxInFlightAction(true, {
      reason: 'manual',
      force: false,
      expectedUserId: 'user-1',
      expectedRealtimeGeneration: 1,
    }, context)).toBe('reuse');
    expect(resolveBlackBoxInFlightAction(true, { reason: 'manual', force: false, expectedUserId: 'user-2' }, context))
      .toBe('queue-forced-gate-review');
    expect(resolveBlackBoxInFlightAction(true, { reason: 'startup', force: false }, { ...context, reason: 'gate-review' }))
      .toBe('queue-forced-gate-review');
    expect(resolveBlackBoxInFlightAction(true, {
      reason: 'gate-review',
      force: true,
      expectedUserId: 'user-1',
      expectedRealtimeGeneration: 7,
    }, {
      ...context,
      reason: 'panel-open',
      force: true,
      expectedRealtimeGeneration: undefined,
    })).toBe('queue-forced-gate-review');
  });

  it('排队 gate-review guard 合并保留旧 user 并按显式空 generation 重置', () => {
    expect(mergeQueuedForcedGateReviewPullGuard(
      { expectedUserId: 'user-1', expectedRealtimeGeneration: 3 },
      { expectedRealtimeGeneration: 4 },
    )).toEqual({ expectedUserId: 'user-1', expectedRealtimeGeneration: 4 });

    expect(mergeQueuedForcedGateReviewPullGuard(
      { expectedUserId: 'user-1', expectedRealtimeGeneration: 3 },
      { expectedUserId: 'user-2' },
    )).toEqual({ expectedUserId: 'user-2', expectedRealtimeGeneration: undefined });
  });

  it('cooldown 与 freshness 决策只在无强制且无待 reconcile 时跳过', () => {
    const context = {
      reason: 'resume' as const,
      force: false,
      expectedUserId: 'user-1',
      expectedRealtimeGeneration: 1,
      pendingEntriesNeedRemoteReconciliation: false,
    };

    expect(shouldSkipBlackBoxPullForCooldown(context, {
      enabled: true,
      now: 12_000,
      lastResumePullAt: 10_000,
      cooldownMs: 5_000,
    })).toBe(true);
    expect(shouldSkipBlackBoxPullForCooldown({ ...context, force: true }, {
      enabled: true,
      now: 12_000,
      lastResumePullAt: 10_000,
      cooldownMs: 5_000,
    })).toBe(false);

    expect(resolveBlackBoxPullFreshnessSkip(context, {
      now: 14_000,
      lastPullTime: 10_000,
      freshnessWindowMs: 10_000,
    })).toEqual({ skip: true, elapsedSec: 4, freshnessWindowSec: 10 });
    expect(resolveBlackBoxPullFreshnessSkip({ ...context, reason: 'panel-open' }, {
      now: 14_000,
      lastPullTime: 10_000,
      freshnessWindowMs: 10_000,
    })).toEqual({ skip: false });
  });

  it('watermark 游标窗口检测未来游标并决定快路资格', () => {
    expect(resolveBlackBoxCursorWindowProbe(
      '2026-06-09T00:00:30.000Z',
      '2026-06-09T00:00:00.000Z',
    )).toEqual({
      effectiveLastSync: '1970-01-01T00:00:00Z',
      repairingFutureCursor: true,
      remoteMs: Date.parse('2026-06-09T00:00:00.000Z'),
      localMs: Date.parse('2026-06-09T00:00:30.000Z'),
      futureCursorWarning: {
        localCursor: '2026-06-09T00:00:30.000Z',
        remoteWatermark: '2026-06-09T00:00:00.000Z',
      },
    });

    expect(shouldUseBlackBoxWatermarkFastPath({
      remoteWatermark: '2026-06-09T00:00:30.000Z',
      remoteMs: Date.parse('2026-06-09T00:00:30.000Z'),
      localMs: Date.parse('2026-06-09T00:00:30.000Z'),
      effectiveLastSync: '2026-06-09T00:00:30.000Z',
      lastSyncCursorId: 'entry-1',
      pendingEntriesNeedRemoteReconciliation: false,
    })).toBe(true);
    expect(shouldUseBlackBoxWatermarkFastPath({
      remoteWatermark: '2026-06-09T00:00:31.000Z',
      remoteMs: Date.parse('2026-06-09T00:00:31.000Z'),
      localMs: Date.parse('2026-06-09T00:00:30.000Z'),
      effectiveLastSync: '2026-06-09T00:00:30.000Z',
      lastSyncCursorId: 'entry-1',
      pendingEntriesNeedRemoteReconciliation: false,
    })).toBe(false);
  });

  it('watermark RPC 结果只接受字符串或字符串数组首项', () => {
    expect(parseBlackBoxRemoteWatermark('2026-06-09T00:00:00.000Z')).toBe('2026-06-09T00:00:00.000Z');
    expect(parseBlackBoxRemoteWatermark(['2026-06-09T00:00:00.000Z'])).toBe('2026-06-09T00:00:00.000Z');
    expect(parseBlackBoxRemoteWatermark([null])).toBeNull();
    expect(parseBlackBoxRemoteWatermark({ value: '2026-06-09T00:00:00.000Z' })).toBeNull();
  });

  it('watermark RPC 读取成功时返回解析后的远端游标', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: ['2026-06-09T00:00:00.000Z'], error: null });
    const logger = { debug: vi.fn() };

    await expect(readBlackBoxRemoteWatermark({ rpc } as unknown as BlackBoxSupabaseClient, logger))
      .resolves.toBe('2026-06-09T00:00:00.000Z');
    expect(rpc).toHaveBeenCalledWith('get_black_box_sync_watermark');
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('watermark RPC 失败或抛错时降级为空游标并记录 debug 诊断', async () => {
    const logger = { debug: vi.fn() };
    await expect(readBlackBoxRemoteWatermark({
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'missing function' } }),
    } as unknown as BlackBoxSupabaseClient, logger)).resolves.toBeNull();
    expect(logger.debug).toHaveBeenCalledWith(
      'BlackBox watermark RPC 失败，降级为明细拉取',
      { message: 'missing function' },
    );

    logger.debug.mockClear();
    await expect(readBlackBoxRemoteWatermark({
      rpc: vi.fn().mockRejectedValue(new Error('network suspended')),
    } as unknown as BlackBoxSupabaseClient, logger)).resolves.toBeNull();
    expect(logger.debug).toHaveBeenCalledWith(
      'BlackBox watermark RPC 异常，降级为明细拉取',
      { error: 'network suspended' },
    );
  });

  it('本地/远端合并决策隔离 LWW、强制远端与单调补齐路径', () => {
    const remote = entry({ updatedAt: '2026-06-09T00:00:00.000Z', isRead: true });

    expect(resolveBlackBoxMergeDecision(undefined, remote, {
      preferRemoteForSyncedLocalDuringPull: false,
      repairingFutureCursor: false,
      isLocalNewer: () => false,
    })).toEqual({ action: 'use-remote', local: undefined });

    const syncedLocal = entry({ syncStatus: 'synced', updatedAt: '2026-06-09T00:00:01.000Z' });
    expect(resolveBlackBoxMergeDecision(syncedLocal, remote, {
      preferRemoteForSyncedLocalDuringPull: true,
      repairingFutureCursor: false,
      isLocalNewer: () => true,
    })).toEqual({ action: 'use-remote', local: syncedLocal });

    const pendingLocal = entry({
      syncStatus: 'pending',
      updatedAt: '2026-06-09T00:00:01.000Z',
      isRead: false,
    });
    expect(resolveBlackBoxMergeDecision(pendingLocal, remote, {
      preferRemoteForSyncedLocalDuringPull: true,
      repairingFutureCursor: false,
      isLocalNewer: () => true,
    })).toEqual({
      action: 'merge-monotonic',
      local: pendingLocal,
      merged: { ...pendingLocal, isRead: true, syncStatus: 'pending' },
    });

    expect(resolveBlackBoxMergeDecision(entry({ updatedAt: '2026-06-09T00:00:01.000Z', isRead: true }), remote, {
      preferRemoteForSyncedLocalDuringPull: false,
      repairingFutureCursor: false,
      isLocalNewer: () => true,
    }).action).toBe('keep-local');
  });

  it('delta page 查询缺少 user scope 时返回作用域错误并记录诊断', async () => {
    const scopedError = new Error('blackbox_delta_missing_user_scope_query');
    const warn = vi.fn();

    await expect(fetchBlackBoxDeltaPageQuery({
      client: { from: vi.fn() },
      cursor: { updatedAt: '2026-06-09T00:00:00.000Z', id: '00000000-0000-4000-8000-000000000001' },
      upperWatermark: null,
      expectedUserId: '',
      selectColumns: 'id',
      pageSize: 2,
      scopedQueryUnavailableError: scopedError,
      warn,
      getOptionalQueryMethod: () => undefined,
    })).resolves.toEqual({ data: null, error: scopedError });
    expect(warn).toHaveBeenCalledWith('黑匣子增量拉取缺少用户作用域，跳过远端读取');
  });

  it('client null short-circuits before pageSize validation with no query call', async () => {
    const warn = vi.fn();

    await expect(fetchBlackBoxDeltaPageQuery({
      client: null,
      cursor: { updatedAt: '2026-06-09T00:00:00.000Z', id: '' },
      upperWatermark: null,
      expectedUserId: 'user-1',
      selectColumns: 'id',
      pageSize: 1001,
      scopedQueryUnavailableError: new Error('scoped'),
      warn,
      getOptionalQueryMethod: () => undefined,
    })).resolves.toEqual({ data: null, error: null });
    expect(warn).not.toHaveBeenCalled();
  });

  it('empty expectedUserId short-circuits with scoped error before pageSize validation', async () => {
    const scopedError = new Error('blackbox_delta_missing_user_scope_query');
    const warn = vi.fn();
    const from = vi.fn();

    await expect(fetchBlackBoxDeltaPageQuery({
      client: { from },
      cursor: { updatedAt: '2026-06-09T00:00:00.000Z', id: '' },
      upperWatermark: null,
      expectedUserId: '',
      selectColumns: 'id',
      pageSize: 1001,
      scopedQueryUnavailableError: scopedError,
      warn,
      getOptionalQueryMethod: () => undefined,
    })).resolves.toEqual({ data: null, error: scopedError });
    expect(from).not.toHaveBeenCalled();
  });

  it('missing limit method returns fully ordered query result without throwing', async () => {
    const warn = vi.fn();
    const orderedResult = { data: [], error: null };
    const chain: Record<string, unknown> = {
      select: vi.fn(),
      eq: vi.fn(),
      or: vi.fn(),
      gt: vi.fn(),
      lte: vi.fn(),
      order: vi.fn(),
    };
    for (const method of ['select', 'eq', 'or', 'gt', 'lte', 'order']) {
      (chain[method] as ReturnType<typeof vi.fn>).mockReturnValue(chain);
    }
    (chain.order as ReturnType<typeof vi.fn>).mockImplementation(
      (column: string) => column === 'updated_at' ? chain : orderedResult,
    );
    const client = { from: vi.fn().mockReturnValue(chain) };

    const result = await fetchBlackBoxDeltaPageQuery({
      client,
      cursor: {
        updatedAt: '2026-06-09T00:00:00.000Z',
        id: '00000000-0000-4000-8000-000000000001',
      },
      upperWatermark: null,
      expectedUserId: 'user-1',
      selectColumns: 'id',
      pageSize: 200,
      scopedQueryUnavailableError: new Error('scoped'),
      warn,
      getOptionalQueryMethod: (_target, method) => {
        if (method === 'eq' || method === 'or' || method === 'gt' || method === 'lte') {
          return chain[method] as (...args: unknown[]) => unknown;
        }
        return undefined;
      },
    });

    expect(result).toEqual(orderedResult);
    expect(chain.order).toHaveBeenCalledWith('updated_at', { ascending: true });
    expect(chain.order).toHaveBeenCalledWith('id', { ascending: true });
    expect(chain.or).toHaveBeenCalled();
  });

  it.each([1.5, 0, 1001])('invalid pageSize %s fails closed with stable code', async (pageSize) => {
    const warn = vi.fn();
    const from = vi.fn();

    await expect(fetchBlackBoxDeltaPageQuery({
      client: { from },
     cursor: { updatedAt: '2026-06-09T00:00:00.000Z', id: '' },
      upperWatermark: null,
      expectedUserId: 'user-1',
      selectColumns: 'id',
      pageSize,
      scopedQueryUnavailableError: new Error('scoped'),
      warn,
      getOptionalQueryMethod: () => undefined,
    })).rejects.toThrow('SUPABASE_PAGE_SIZE_INVALID');
    expect(from).not.toHaveBeenCalled();
  });

  it('valid pageSize 200 proceeds through existing keyset/order/limit behavior', async () => {
    const warn = vi.fn();
    const limit = vi.fn().mockResolvedValue({ data: [], error: null });
    const chain: Record<string, unknown> = {
      select: vi.fn(),
      eq: vi.fn(),
      or: vi.fn(),
      gt: vi.fn(),
      lte: vi.fn(),
      order: vi.fn(),
      limit,
    };
    for (const method of ['select', 'eq', 'or', 'gt', 'lte', 'order']) {
      (chain[method] as ReturnType<typeof vi.fn>).mockReturnValue(chain);
    }
    const client = { from: vi.fn().mockReturnValue(chain) };

    const result = await fetchBlackBoxDeltaPageQuery({
      client,
      cursor: {
        updatedAt: '2026-06-09T00:00:00.000Z',
        id: '00000000-0000-4000-8000-000000000001',
      },
      upperWatermark: null,
      expectedUserId: 'user-1',
      selectColumns: 'id',
      pageSize: 200,
      scopedQueryUnavailableError: new Error('scoped'),
      warn,
      getOptionalQueryMethod: (_target, method) => {
        if (
          method === 'eq'
          || method === 'or'
          || method === 'gt'
          || method === 'lte'
          || method === 'limit'
        ) {
          return chain[method] as (...args: unknown[]) => unknown;
        }
        return undefined;
      },
    });

    expect(result).toEqual({ data: [], error: null });
    expect(limit).toHaveBeenCalledWith(200);
    expect(chain.order).toHaveBeenCalledWith('updated_at', { ascending: true });
    expect(chain.order).toHaveBeenCalledWith('id', { ascending: true });
    expect(chain.or).toHaveBeenCalled();
  });
});
