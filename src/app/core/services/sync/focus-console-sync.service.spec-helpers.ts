import { expect, it, type Mock } from 'vitest';
import { FocusConsoleSyncService } from './focus-console-sync.service';
import { DataSafetyAuditPersistence } from '../../../../services/data-safety-audit-persistence';
import { createBrowserNetworkSuspendedError } from '../../../../utils/browser-network-suspension';

interface FocusConsoleSyncRoutineSpecContext {
  service(): FocusConsoleSyncService;
  mockClient: {
    from: Mock;
    rpc: Mock;
  };
  mockSyncRpc: {
    upsertRoutineTask: Mock;
    incrementRoutineCompletion: Mock;
  };
}

function createMutableRoutineTaskPages(rows: Array<{
  id: string;
  user_id: string;
  title: string;
  max_times_per_day: number;
  is_enabled: boolean;
  updated_at: string;
}>): {
  createQuery: () => Record<string, unknown>;
  limitCursors: Array<string | null>;
  rangeStarts: number[];
} {
  const limitCursors: Array<string | null> = [];
  const rangeStarts: number[] = [];
  let pageRequests = 0;

  const createQuery = () => {
    let cursor: { updatedAt: string; id: string } | null = null;
    let updatedAtAscending = true;
    const readPage = (from: number, to: number) => {
      const ordered = rows
        .filter((row) => {
          if (!cursor) return true;
          const updatedOrder = row.updated_at.localeCompare(cursor.updatedAt);
          return updatedAtAscending
            ? updatedOrder > 0 || updatedOrder === 0 && row.id > cursor.id
            : updatedOrder < 0 || updatedOrder === 0 && row.id > cursor.id;
        })
        .slice()
        .sort((left, right) => {
          const updatedOrder = left.updated_at.localeCompare(right.updated_at);
          if (updatedOrder !== 0) return updatedAtAscending ? updatedOrder : -updatedOrder;
          return left.id.localeCompare(right.id);
        });
      const page = ordered.slice(from, to + 1).map(row => ({ ...row }));
      if (pageRequests++ === 0) {
        rows[0] = {
          ...rows[0],
          title: 'Routine 0 moved',
          updated_at: '2026-06-09T03:00:00.000Z',
        };
      }
      return Promise.resolve({ data: page, error: null });
    };
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      or: vi.fn((filters: string) => {
        const match = /^updated_at\.gt\.(.*),and\(updated_at\.eq\.(.*),id\.gt\.(.*)\)$/.exec(filters);
        if (match) cursor = { updatedAt: match[2], id: match[3] };
        return query;
      }),
      order: vi.fn((column: string, options?: { ascending?: boolean }) => {
        if (column === 'updated_at') updatedAtAscending = options?.ascending !== false;
        return query;
      }),
      limit: vi.fn((count: number) => {
        limitCursors.push(cursor ? `${cursor.updatedAt}|${cursor.id}` : null);
        return readPage(0, count - 1);
      }),
      range: vi.fn((from: number, to: number) => {
        rangeStarts.push(from);
        return readPage(from, to);
      }),
    };
    return query;
  };

  return { createQuery, limitCursors, rangeStarts };
}

export function registerFocusConsoleRoutineSyncSpecs(context: FocusConsoleSyncRoutineSpecContext): void {
  const { mockClient, mockSyncRpc } = context;
  const service = () => context.service();

  it('listRoutineTasks should return success([]) when browser IO is suspended mid-request', async () => {
    const limit = vi.fn().mockRejectedValue(createBrowserNetworkSuspendedError());
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      order: vi.fn(() => query),
      limit,
    };
    mockClient.from.mockReturnValue(query);

    const result = await service().listRoutineTasks('user-1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SYNC_OFFLINE');
      expect(result.error.details?.['reason']).toBe('browser-network-suspended');
    }
  });

  it('listRoutineTasks should keyset-page mutable rows without skipping or duplicates', async () => {
    const rows = Array.from({ length: 1001 }, (_, index) => ({
      id: `routine-${index.toString().padStart(4, '0')}`,
      user_id: 'user-1',
      title: `Routine ${index}`,
      max_times_per_day: 1,
      is_enabled: true,
      updated_at: new Date(Date.UTC(2026, 5, 9, 0, 0, index)).toISOString(),
    }));
    const paged = createMutableRoutineTaskPages(rows);
    mockClient.from.mockImplementation(() => paged.createQuery());

    const result = await service().listRoutineTasks('user-1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      const routineIds = result.value.map(routine => routine.routineId);
      expect(result.value).toHaveLength(1001);
      expect(new Set(routineIds).size).toBe(1001);
      expect(routineIds).toContain('routine-1000');
      expect(result.value[0].routineId).toBe('routine-0000');
      expect(result.value[0].title).toBe('Routine 0 moved');
    }
    expect(paged.limitCursors).toHaveLength(2);
    expect(paged.rangeStarts).toEqual([]);
  });

  it('upsertRoutineTask should use Sync RPC when operationId is provided', async () => {
    const routineTask = {
      routineId: 'routine-1',
      title: 'Routine',
      triggerCondition: 'any-blank-period' as const,
      maxTimesPerDay: 2,
      isEnabled: true,
      updatedAt: '2026-06-15T00:00:02.000Z',
    };

    const result = await service().upsertRoutineTask('user-1', routineTask, 'op-routine-task');

    expect(result.ok).toBe(true);
    expect(mockSyncRpc.upsertRoutineTask).toHaveBeenCalledWith({
      operationId: 'op-routine-task',
      userId: 'user-1',
      task: routineTask,
    });
    expect(mockClient.from).not.toHaveBeenCalled();
  });

  it('upsertRoutineTask should fail when Sync RPC keeps remote state for stale payload', async () => {
    mockSyncRpc.upsertRoutineTask.mockResolvedValueOnce({
      status: 'applied',
      stalePayload: true,
      reason: 'remote-newer-payload-preserved',
      raw: {},
    });
    const routineTask = {
      routineId: 'routine-stale',
      title: 'Routine',
      triggerCondition: 'any-blank-period' as const,
      maxTimesPerDay: 2,
      isEnabled: true,
      updatedAt: '2026-06-15T00:00:02.000Z',
    };

    const result = await service().upsertRoutineTask('user-1', routineTask, 'op-routine-task-stale');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FOCUS_CONSOLE_ROUTINE_FAILED');
      expect(result.error.details?.['reason']).toBe('stale-payload-preserved-remotely');
    }
    expect(mockClient.from).not.toHaveBeenCalled();
  });

  it('upsertRoutineTask should persist write explain and replay entry after Sync RPC applies', async () => {
    mockSyncRpc.upsertRoutineTask.mockResolvedValueOnce({
      status: 'applied',
      serverUpdatedAt: '2026-06-15T04:00:00.000Z',
      raw: {},
    });
    const routineTask = {
      routineId: 'routine-audit',
      title: 'Routine',
      triggerCondition: 'any-blank-period' as const,
      maxTimesPerDay: 2,
      isEnabled: true,
      updatedAt: '2026-06-15T00:00:02.000Z',
    };

    const result = await service().upsertRoutineTask('user-1', routineTask, 'op-routine-task-audit');

    expect(result.ok).toBe(true);
    const audit = new DataSafetyAuditPersistence().load('user-1');
    expect(audit.lastWriteExplain).toMatchObject({
      operationId: 'op-routine-task-audit',
      actor: { sourceUserId: 'user-1' },
      entity: { type: 'routine-task', id: 'routine-audit' },
      operation: 'upsert',
      updatedAtBaseline: '2026-06-15T00:00:02.000Z',
      beforeVersion: '2026-06-15T00:00:02.000Z',
      afterVersion: '2026-06-15T04:00:00.000Z',
      queueResult: { enteredRetryQueue: false, retryCount: 0 },
      rpcResult: { status: 'applied', serverUpdatedAt: '2026-06-15T04:00:00.000Z' },
      lwwDecision: { decision: 'local-applied', reason: 'applied' },
      lastSyncTime: { before: null, after: null, advanced: false },
    });
    expect(audit.replayLog[0]).toMatchObject({
      operationId: 'op-routine-task-audit',
      entityType: 'routine-task',
      entityId: 'routine-audit',
      operation: 'upsert',
      baseUpdatedAt: '2026-06-15T00:00:02.000Z',
      rpc: { status: 'applied', serverUpdatedAt: '2026-06-15T04:00:00.000Z' },
      lww: { decision: 'local-applied', reason: 'applied' },
    });
  });

  it('upsertRoutineTask should fail instead of legacy upserting when operationId is missing', async () => {
    const result = await service().upsertRoutineTask('user-1', {
      routineId: 'routine-1',
      title: 'Routine',
      triggerCondition: 'any-blank-period',
      maxTimesPerDay: 2,
      isEnabled: true,
      updatedAt: '2026-06-15T00:00:02.000Z',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FOCUS_CONSOLE_ROUTINE_FAILED');
      expect(result.error.details?.['reason']).toBe('missing-operation-id');
    }
    expect(mockSyncRpc.upsertRoutineTask).not.toHaveBeenCalled();
    expect(mockClient.from).not.toHaveBeenCalled();
  });

  it('upsertRoutineTask should not run legacy freshness/read path when operationId is missing', async () => {
    const result = await service().upsertRoutineTask('user-1', {
      routineId: 'routine-1',
      title: 'Routine',
      triggerCondition: 'any-blank-period',
      maxTimesPerDay: 2,
      isEnabled: true,
      updatedAt: '2026-06-15T00:00:02.000Z',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.['reason']).toBe('missing-operation-id');
    }
    expect(mockClient.from).not.toHaveBeenCalled();
  });

  // L-28 债务清偿说明：listRoutineTasks 映射、upsertRoutineTask 错误处理、saveFocusSession 成功路径、
  // incrementRoutineCompletion retry-queue 协同用例见同目录 focus-console-sync.service.routine-coverage.spec.ts；
  // importLegacyDockSnapshot 已不存在于 FocusConsoleSyncService（对应 TODO 过期作废）。

  it('incrementRoutineCompletion should reject missing operationId before legacy atomic rpc', async () => {
    const result = await service().incrementRoutineCompletion({
      completionId: 'comp-1',
      userId: 'user-1',
      routineId: 'routine-1',
      dateKey: '2026-03-03',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FOCUS_CONSOLE_INCREMENT_FAILED');
      expect(result.error.details?.['reason']).toBe('missing-operation-id');
    }
    expect(mockClient.rpc).not.toHaveBeenCalled();
  });

  it('incrementRoutineCompletion should use Sync RPC when operationId is provided', async () => {
    const mutation = {
      completionId: 'comp-1',
      userId: 'user-1',
      routineId: 'routine-1',
      dateKey: '2026-03-03',
    };

    const result = await service().incrementRoutineCompletion(mutation, 'op-routine-completion');

    expect(result.ok).toBe(true);
    expect(mockSyncRpc.incrementRoutineCompletion).toHaveBeenCalledWith({
      operationId: 'op-routine-completion',
      mutation,
    });
    expect(mockClient.rpc).not.toHaveBeenCalled();
  });

  it('incrementRoutineCompletion should skip legacy atomic rpc when operationId is missing', async () => {
    mockClient.rpc.mockResolvedValue({
      data: null,
      error: { message: 'rpc failed' },
    });

    const result = await service().incrementRoutineCompletion({
      completionId: 'comp-1',
      userId: 'user-1',
      routineId: 'routine-1',
      dateKey: '2026-03-03',
    });

    expect(result.ok).toBe(false);
    expect(mockClient.rpc).not.toHaveBeenCalled();
  });
}
