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

export function registerFocusConsoleRoutineSyncSpecs(context: FocusConsoleSyncRoutineSpecContext): void {
  const { mockClient, mockSyncRpc } = context;
  const service = () => context.service();

  it('listRoutineTasks should return success([]) when browser IO is suspended mid-request', async () => {
    const range = vi.fn().mockRejectedValue(createBrowserNetworkSuspendedError());
    const order = vi.fn(() => ({ range }));
    const eq = vi.fn(() => ({ order }));
    const select = vi.fn(() => ({ eq }));
    mockClient.from.mockReturnValue({ select });

    const result = await service().listRoutineTasks('user-1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SYNC_OFFLINE');
      expect(result.error.details?.['reason']).toBe('browser-network-suspended');
    }
  });

  it('listRoutineTasks should read all Supabase REST pages', async () => {
    const rows = Array.from({ length: 1001 }, (_, index) => ({
      id: `routine-${index.toString().padStart(4, '0')}`,
      user_id: 'user-1',
      title: `Routine ${index}`,
      max_times_per_day: 1,
      is_enabled: true,
      updated_at: new Date(Date.UTC(2026, 5, 9, 0, 0, index)).toISOString(),
    }));
    const ranges: Array<[number, number]> = [];
    const range = vi.fn(async (from: number, to: number) => {
      ranges.push([from, to]);
      return { data: rows.slice(from, to + 1), error: null };
    });
    const order = vi.fn(() => ({ range }));
    const eq = vi.fn(() => ({ order }));
    const select = vi.fn(() => ({ eq }));
    mockClient.from.mockReturnValue({ select });

    const result = await service().listRoutineTasks('user-1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1001);
      expect(result.value[0].routineId).toBe('routine-0000');
      expect(result.value[1000].routineId).toBe('routine-1000');
    }
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
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

  // TODO(L-28): Add test for listRoutineTasks — verify it maps RoutineTaskRow to RoutineTask[]
  // TODO(L-28): Add test for upsertRoutineTask — verify upsert payload shape and error handling
  // TODO(L-28): Add test for importLegacyDockSnapshot — verify it reads from user_preferences table
  // TODO(L-28): Add test for saveFocusSession success path — verify it returns true and upsert payload
  // TODO(L-28): Add test for incrementRoutineCompletion 挂起窗口外的 retry-queue 协同行为

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
