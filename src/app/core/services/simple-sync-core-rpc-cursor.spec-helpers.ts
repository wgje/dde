import {
  beforeEach,
  describe,
  expect,
  it,
  setVisibilityState,
  vi,
} from './simple-sync.service.spec-context';
import type { SimpleSyncCoreRpcSpecContext } from './simple-sync-core-rpc.spec-helpers';

export function registerSimpleSyncCoreRpcCursorSpecs(context: SimpleSyncCoreRpcSpecContext): void {
  let service: any;
  let mockSupabase: any;
  let mockClient: any;
  let mockSyncCursorPersistence: any;

  function loadContext(): void {
    service = context.service();
    mockSupabase = context.mockSupabase();
    mockClient = context.mockClient();
    mockSyncCursorPersistence = context.mockSyncCursorPersistence();
  }

  describe('Delta Sync cursor candidates', () => {
    const createOrderedQuery = (data: unknown[], error: unknown = null) => {
      const terminal = {
        data,
        error,
        order: vi.fn(),
      };
      const query = {
        eq: vi.fn(() => query),
        gt: vi.fn(() => query),
        // keyset 续页下界过滤（fetchAllSupabaseKeysetPages cursor 非 null 分支）
        or: vi.fn(() => query),
        order: vi.fn((column: string, options: unknown) => {
          terminal.order(column, options);
          return query;
        }),
        range: vi.fn(async (from: number, to: number) => ({
          data: data.slice(from, to + 1),
          error,
        })),
        // keyset 翻页终结符：默认页大小(1000)远大于测试数据量，单页即完成
        limit: vi.fn(async (count: number) => ({
          data: data.slice(0, count),
          error,
        })),
      };
      return { query, terminal };
    };

    beforeEach(loadContext);

    it('checkForDrift should return a server cursor candidate without committing it', async () => {
      const taskRows = [{
        id: 'task-a',
        title: 'Task A',
        content: 'remote',
        stage: 1,
        parent_id: null,
        order: 0,
        rank: 1000,
        status: 'active',
        x: 0,
        y: 0,
        updated_at: '2026-04-29T08:00:00.000Z',
        deleted_at: null,
        short_id: 'aaaa',
        attachments: [],
        tags: [],
      }];
      const connectionRows = [{
        id: 'conn-z',
        source_id: 'task-a',
        target_id: 'task-b',
        title: '',
        description: '',
        deleted_at: null,
        updated_at: '2026-04-29T08:00:00.000Z',
      }];
      const taskQuery = createOrderedQuery(taskRows);
      const connectionQuery = createOrderedQuery(connectionRows);
      mockClient.from = vi.fn().mockImplementation((table: string) => {
        if (table === 'tasks') return { select: vi.fn(() => taskQuery.query) };
        if (table === 'connections') return { select: vi.fn(() => connectionQuery.query) };
        return { select: vi.fn(() => createOrderedQuery([]).query) };
      });
      mockSupabase.isConfigured = true;
      mockSupabase.clientAsync.mockResolvedValue(mockClient);
      service.setLastSyncTime('project-1', '2026-04-29T07:59:59.000Z');

      const drift = await service.checkForDrift('project-1');

      expect(service.getLastSyncTime('project-1')).toBe('2026-04-29T07:59:59.000Z');
      expect(drift.nextCursor).toEqual({
        updatedAt: '2026-04-29T08:00:00.000Z',
        entityType: 'connection',
        id: 'conn-z',
      });
      expect(taskQuery.terminal.order).toHaveBeenCalledWith('id', { ascending: true });
      expect(connectionQuery.terminal.order).toHaveBeenCalledWith('id', { ascending: true });
    });

    it('checkForDrift should defer during browser network suspension without touching Supabase', async () => {
      mockSupabase.isConfigured = true;
      mockSupabase.clientAsync.mockResolvedValue(mockClient);
      service.setLastSyncTime('project-1', '2026-04-29T07:59:59.000Z');
      setVisibilityState('hidden');

      const drift = await service.checkForDrift('project-1');

      expect(drift).toEqual({ tasks: [], connections: [], nextCursor: null });
      expect(mockSupabase.clientAsync).not.toHaveBeenCalled();
    });

    it('checkForDrift should resume from the persisted combination cursor with a safety lookback', async () => {
      const taskQuery = createOrderedQuery([]);
      const connectionQuery = createOrderedQuery([]);
      mockClient.from = vi.fn().mockImplementation((table: string) => {
        if (table === 'tasks') return { select: vi.fn(() => taskQuery.query) };
        if (table === 'connections') return { select: vi.fn(() => connectionQuery.query) };
        return { select: vi.fn(() => createOrderedQuery([]).query) };
      });
      mockSupabase.isConfigured = true;
      mockSupabase.clientAsync.mockResolvedValue(mockClient);
      mockSyncCursorPersistence.loadProjectCursor.mockResolvedValueOnce({
        updatedAt: '2026-04-29T08:00:30.000Z',
        entityType: 'task',
        id: 'task-a',
      });

      const drift = await service.checkForDrift('project-1');

      expect(drift).toEqual({ tasks: [], connections: [], nextCursor: null });
      expect(mockSyncCursorPersistence.loadProjectCursor).toHaveBeenCalledWith('project-1', null);
      expect(taskQuery.query.gt).toHaveBeenCalledWith('updated_at', '2026-04-29T08:00:00.000Z');
      expect(connectionQuery.query.gt).toHaveBeenCalledWith('updated_at', '2026-04-29T08:00:00.000Z');
      expect(service.getLastSyncTime('project-1')).toBe('2026-04-29T08:00:30.000Z');
    });

    it('checkForDrift should ignore already-processed rows returned by the safety lookback window', async () => {
      const taskRows = [{
        id: 'task-a',
        title: 'Task A',
        content: 'old',
        stage: 1,
        parent_id: null,
        order: 0,
        rank: 1000,
        status: 'active',
        x: 0,
        y: 0,
        updated_at: '2026-04-29T08:00:30.000Z',
        deleted_at: null,
        short_id: 'aaaa',
        attachments: [],
        tags: [],
      }];
      const connectionRows = [{
        id: 'conn-z',
        source_id: 'task-a',
        target_id: 'task-b',
        title: '',
        description: '',
        deleted_at: null,
        updated_at: '2026-04-29T08:00:30.000Z',
      }];
      const taskQuery = createOrderedQuery(taskRows);
      const connectionQuery = createOrderedQuery(connectionRows);
      mockClient.from = vi.fn().mockImplementation((table: string) => {
        if (table === 'tasks') return { select: vi.fn(() => taskQuery.query) };
        if (table === 'connections') return { select: vi.fn(() => connectionQuery.query) };
        return { select: vi.fn(() => createOrderedQuery([]).query) };
      });
      mockSupabase.isConfigured = true;
      mockSupabase.clientAsync.mockResolvedValue(mockClient);
      mockSyncCursorPersistence.loadProjectCursor.mockResolvedValueOnce({
        updatedAt: '2026-04-29T08:00:30.000Z',
        entityType: 'connection',
        id: 'conn-z',
      });

      const drift = await service.checkForDrift('project-1');

      expect(drift).toEqual({ tasks: [], connections: [], nextCursor: null });
    });

    it('checkForDrift should keep same-timestamp rows that sort after the persisted combination cursor', async () => {
      const taskRows = [{
        id: 'task-b',
        title: 'Task B',
        content: 'same timestamp',
        stage: 1,
        parent_id: null,
        order: 0,
        rank: 1000,
        status: 'active',
        x: 0,
        y: 0,
        updated_at: '2026-04-29T08:00:30.000Z',
        deleted_at: null,
        short_id: 'bbbb',
        attachments: [],
        tags: [],
      }];
      const taskQuery = createOrderedQuery(taskRows);
      const connectionQuery = createOrderedQuery([]);
      mockClient.from = vi.fn().mockImplementation((table: string) => {
        if (table === 'tasks') return { select: vi.fn(() => taskQuery.query) };
        if (table === 'connections') return { select: vi.fn(() => connectionQuery.query) };
        return { select: vi.fn(() => createOrderedQuery([]).query) };
      });
      mockSupabase.isConfigured = true;
      mockSupabase.clientAsync.mockResolvedValue(mockClient);
      mockSyncCursorPersistence.loadProjectCursor.mockResolvedValueOnce({
        updatedAt: '2026-04-29T08:00:30.000Z',
        entityType: 'task',
        id: 'task-a',
      });

      const drift = await service.checkForDrift('project-1');

      expect(drift.tasks.map((task: { id: string }) => task.id)).toEqual(['task-b']);
      expect(drift.nextCursor).toEqual({
        updatedAt: '2026-04-29T08:00:30.000Z',
        entityType: 'task',
        id: 'task-b',
      });
    });

    it('commitProjectSyncCursor should not advance memory if IndexedDB persistence fails', async () => {
      mockSyncCursorPersistence.commitProjectCursor.mockRejectedValueOnce(new Error('idb failed'));

      await expect(service.commitProjectSyncCursor('project-1', {
        updatedAt: '2026-04-29T08:00:00.000Z',
        entityType: 'task',
        id: 'task-a',
      })).rejects.toThrow('idb failed');

      expect(service.getProjectSyncCursor('project-1')).toBeNull();
      expect(service.getLastSyncTime('project-1')).toBeNull();
    });
  });
}
