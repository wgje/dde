import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlackBoxEntry } from '../models/focus';
import type { Result, OperationError } from '../utils/result';
import {
  GATE_DEFERRED_MUTATION_STORAGE_KEY,
  GateDeferredMutationController,
  type GateDeferredMutationControllerOptions,
} from './gate-deferred-mutation.controller';

const entry: BlackBoxEntry = {
  id: 'entry-1',
  projectId: null,
  userId: 'user-1',
  content: '待稍后处理',
  date: '2026-06-16',
  createdAt: '2026-06-16T00:00:00.000Z',
  updatedAt: '2026-06-16T00:00:00.000Z',
  isRead: false,
  isCompleted: false,
  isArchived: false,
  deletedAt: null,
  snoozeUntil: '2026-06-17',
  snoozeCount: 1,
};
const ownerUserId = 'user-1';
const ownerStorageKey = `${GATE_DEFERRED_MUTATION_STORAGE_KEY}.${ownerUserId}`;

describe('GateDeferredMutationController', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('决策应持久暂存，flush 成功后清除暂存', async () => {
    // §5.6：动画窗口内 app 被杀不能丢掉用户已确认的决策
    const markAsReadDurably = vi.fn<GateDeferredMutationControllerOptions['blackBoxService']['markAsReadDurably']>()
      .mockResolvedValue({ ok: true, value: entry });
    const controller = new GateDeferredMutationController({
      blackBoxService: {
        markAsReadDurably,
        markAsCompletedDurably: vi.fn(),
        snoozeDurably: vi.fn(),
      },
      logger: { warn: vi.fn() },
      getOwnerUserId: () => ownerUserId,
    });

    controller.setMarkRead('entry-1');
    expect(localStorage.getItem(ownerStorageKey)).toContain('entry-1');

    await controller.flush();
    expect(localStorage.getItem(ownerStorageKey)).toBeNull();
  });

  it('restorePersistedMutation 应补写上一会话动画窗口内未落库的决策', async () => {
    localStorage.setItem(
      ownerStorageKey,
      JSON.stringify({
        kind: 'mark-completed',
        entryId: 'entry-killed-mid-animation',
        ownerUserId,
      }),
    );
    const markAsCompletedDurably = vi.fn<GateDeferredMutationControllerOptions['blackBoxService']['markAsCompletedDurably']>()
      .mockResolvedValue({ ok: true, value: entry });
    const controller = new GateDeferredMutationController({
      blackBoxService: {
        markAsReadDurably: vi.fn(),
        markAsCompletedDurably,
        snoozeDurably: vi.fn(),
      },
      logger: { warn: vi.fn() },
      getOwnerUserId: () => ownerUserId,
    });

    await controller.restorePersistedMutation();

    expect(markAsCompletedDurably).toHaveBeenCalledWith('entry-killed-mid-animation');
    expect(controller.hasPending).toBe(false);
    expect(localStorage.getItem(ownerStorageKey)).toBeNull();
  });

  it('restorePersistedMutation 补写失败时应丢弃暂存并告警，不留毒化状态', async () => {
    localStorage.setItem(
      ownerStorageKey,
      JSON.stringify({ kind: 'mark-read', entryId: 'entry-not-found', ownerUserId }),
    );
    const warn = vi.fn();
    const markAsReadDurably = vi.fn<GateDeferredMutationControllerOptions['blackBoxService']['markAsReadDurably']>()
      .mockResolvedValue({
        ok: false,
        error: { code: 'FOCUS_ENTRY_NOT_FOUND', message: '条目不存在' },
      } as Result<BlackBoxEntry, OperationError>);
    const controller = new GateDeferredMutationController({
      blackBoxService: {
        markAsReadDurably,
        markAsCompletedDurably: vi.fn(),
        snoozeDurably: vi.fn(),
      },
      logger: { warn },
      getOwnerUserId: () => ownerUserId,
    });

    await controller.restorePersistedMutation();

    expect(controller.hasPending).toBe(false);
    expect(localStorage.getItem(ownerStorageKey)).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('无暂存时 restorePersistedMutation 等价于 clear，清掉内存残留', async () => {
    const controller = new GateDeferredMutationController({
      blackBoxService: {
        markAsReadDurably: vi.fn(),
        markAsCompletedDurably: vi.fn(),
        snoozeDurably: vi.fn(),
      },
      logger: { warn: vi.fn() },
      getOwnerUserId: () => ownerUserId,
    });
    controller.setMarkRead('entry-stale-memory');
    localStorage.clear();

    await controller.restorePersistedMutation();

    expect(controller.hasPending).toBe(false);
  });

  it('flush snooze should use durable black-box mutation instead of legacy memory-first snooze', async () => {
    const legacySnooze = vi.fn((): Result<BlackBoxEntry, OperationError> => ({ ok: true, value: entry }));
    const snoozeDurably = vi.fn((): Promise<Result<BlackBoxEntry, OperationError>> =>
      Promise.resolve({ ok: true, value: entry }));
    const blackBoxService = {
      markAsReadDurably: vi.fn(),
      markAsCompletedDurably: vi.fn(),
      snooze: legacySnooze,
      snoozeDurably,
    } satisfies GateDeferredMutationControllerOptions['blackBoxService'] & {
      snooze: typeof legacySnooze;
    };
    const controller = new GateDeferredMutationController({
      blackBoxService,
      logger: { warn: vi.fn() },
      getOwnerUserId: () => ownerUserId,
    });

    controller.setSnooze('entry-1', '2026-06-17', 2);
    await controller.flush();

    expect(snoozeDurably).toHaveBeenCalledWith('entry-1', '2026-06-17', 2);
    expect(legacySnooze).not.toHaveBeenCalled();
  });

  it('keeps the pending mutation when durable persistence fails so callers can retry explicitly', async () => {
    const failureResult: Result<BlackBoxEntry, OperationError> = {
      ok: false,
      error: {
        code: 'OPERATION_FAILED',
        message: '黑匣子本地持久化失败',
      },
    };
    const markAsReadDurably = vi.fn<GateDeferredMutationControllerOptions['blackBoxService']['markAsReadDurably']>()
      .mockResolvedValueOnce(failureResult)
      .mockResolvedValueOnce({ ok: true, value: entry });
    const markAsCompletedDurably = vi.fn<GateDeferredMutationControllerOptions['blackBoxService']['markAsCompletedDurably']>();
    const snoozeDurably = vi.fn<GateDeferredMutationControllerOptions['blackBoxService']['snoozeDurably']>();
    const controller = new GateDeferredMutationController({
      blackBoxService: {
        markAsReadDurably,
        markAsCompletedDurably,
        snoozeDurably,
      },
      logger: { warn: vi.fn() },
      getOwnerUserId: () => ownerUserId,
    });

    controller.setMarkRead('entry-1');

    const failed = await controller.flush();

    expect(failed.ok).toBe(false);
    expect(controller.hasPending).toBe(true);

    const retried = await controller.flush();

    expect(retried.ok).toBe(true);
    expect(controller.hasPending).toBe(false);
    expect(markAsReadDurably).toHaveBeenCalledTimes(2);
  });

  it('persists deferred mutations under the captured owner instead of a global key', () => {
    let currentOwnerUserId: string | null = 'user-a';
    const options = {
      blackBoxService: {
        markAsReadDurably: vi.fn(),
        markAsCompletedDurably: vi.fn(),
        snoozeDurably: vi.fn(),
      },
      logger: { warn: vi.fn() },
      getOwnerUserId: () => currentOwnerUserId,
    } as GateDeferredMutationControllerOptions & { getOwnerUserId: () => string | null };
    const controller = new GateDeferredMutationController(options);

    controller.setMarkRead('entry-owner-a');

    expect(localStorage.getItem(GATE_DEFERRED_MUTATION_STORAGE_KEY)).toBeNull();
    expect(JSON.parse(
      localStorage.getItem(`${GATE_DEFERRED_MUTATION_STORAGE_KEY}.user-a`) ?? 'null',
    )).toEqual({ kind: 'mark-read', entryId: 'entry-owner-a', ownerUserId: 'user-a' });
    currentOwnerUserId = null;
  });

  it('replays a snooze with its fixed count target after an owner switch', async () => {
    let currentOwnerUserId: string | null = 'user-a';
    let persistedSnoozeCount = 1;
    const snoozeDurably = vi.fn(async (
      _entryId: string,
      snoozeUntil: string,
      targetSnoozeCount?: number,
    ) => {
      persistedSnoozeCount = Math.max(
        persistedSnoozeCount,
        targetSnoozeCount ?? persistedSnoozeCount + 1,
      );
      return {
        ok: true as const,
        value: { ...entry, snoozeUntil, snoozeCount: persistedSnoozeCount },
      };
    });
    const controller = new GateDeferredMutationController({
      blackBoxService: {
        markAsReadDurably: vi.fn(),
        markAsCompletedDurably: vi.fn(),
        snoozeDurably,
      },
      logger: { warn: vi.fn() },
      getOwnerUserId: () => currentOwnerUserId,
    });

    controller.setSnooze('entry-snooze-owner-a', '2026-06-17', 2);
    const firstFlush = controller.flush();
    currentOwnerUserId = 'user-b';
    const staleFlush = await firstFlush;

    expect(staleFlush.ok).toBe(false);
    expect(localStorage.getItem(`${GATE_DEFERRED_MUTATION_STORAGE_KEY}.user-a`)).not.toBeNull();

    currentOwnerUserId = 'user-a';
    await controller.restorePersistedMutation();

    expect(snoozeDurably).toHaveBeenCalledTimes(2);
    expect(snoozeDurably.mock.calls.map(call => call[2])).toEqual([2, 2]);
    expect(persistedSnoozeCount).toBe(2);
    expect(localStorage.getItem(`${GATE_DEFERRED_MUTATION_STORAGE_KEY}.user-a`)).toBeNull();
  });

  it('does not flush an in-memory mutation after the active owner changes', async () => {
    let currentOwnerUserId: string | null = 'user-a';
    const markAsReadDurably = vi.fn<GateDeferredMutationControllerOptions['blackBoxService']['markAsReadDurably']>()
      .mockResolvedValue({ ok: true, value: entry });
    const options = {
      blackBoxService: {
        markAsReadDurably,
        markAsCompletedDurably: vi.fn(),
        snoozeDurably: vi.fn(),
      },
      logger: { warn: vi.fn() },
      getOwnerUserId: () => currentOwnerUserId,
    } as GateDeferredMutationControllerOptions & { getOwnerUserId: () => string | null };
    const controller = new GateDeferredMutationController(options);
    controller.setMarkRead('entry-owner-a');

    currentOwnerUserId = 'user-b';
    const result = await controller.flush();

    expect(result.ok).toBe(false);
    expect(markAsReadDurably).not.toHaveBeenCalled();
    expect(controller.hasPending).toBe(false);
    expect(localStorage.getItem(`${GATE_DEFERRED_MUTATION_STORAGE_KEY}.user-a`)).not.toBeNull();
  });

  it('preserves the captured owner intent when the owner changes during an in-flight flush', async () => {
    let currentOwnerUserId: string | null = 'user-a';
    let resolveMutation!: (result: Result<BlackBoxEntry, OperationError>) => void;
    const mutationResult = new Promise<Result<BlackBoxEntry, OperationError>>(resolve => {
      resolveMutation = resolve;
    });
    const markAsReadDurably = vi.fn<GateDeferredMutationControllerOptions['blackBoxService']['markAsReadDurably']>()
      .mockReturnValue(mutationResult);
    const options = {
      blackBoxService: {
        markAsReadDurably,
        markAsCompletedDurably: vi.fn(),
        snoozeDurably: vi.fn(),
      },
      logger: { warn: vi.fn() },
      getOwnerUserId: () => currentOwnerUserId,
    } as GateDeferredMutationControllerOptions & { getOwnerUserId: () => string | null };
    const controller = new GateDeferredMutationController(options);
    controller.setMarkRead('entry-owner-a-in-flight');

    const flushPromise = controller.flush();
    currentOwnerUserId = 'user-b';
    resolveMutation({ ok: true, value: entry });
    const result = await flushPromise;

    expect(result.ok).toBe(false);
    expect(controller.hasPending).toBe(false);
    expect(localStorage.getItem(`${GATE_DEFERRED_MUTATION_STORAGE_KEY}.user-a`)).not.toBeNull();
  });

  it('drops an ownerless legacy global mutation instead of replaying it for the current owner', async () => {
    localStorage.setItem(
      GATE_DEFERRED_MUTATION_STORAGE_KEY,
      JSON.stringify({ kind: 'mark-completed', entryId: 'legacy-ownerless-entry' }),
    );
    const markAsCompletedDurably = vi.fn<GateDeferredMutationControllerOptions['blackBoxService']['markAsCompletedDurably']>()
      .mockResolvedValue({ ok: true, value: entry });
    const options = {
      blackBoxService: {
        markAsReadDurably: vi.fn(),
        markAsCompletedDurably,
        snoozeDurably: vi.fn(),
      },
      logger: { warn: vi.fn() },
      getOwnerUserId: () => 'user-b',
    } as GateDeferredMutationControllerOptions & { getOwnerUserId: () => string | null };
    const controller = new GateDeferredMutationController(options);

    await controller.restorePersistedMutation();

    expect(markAsCompletedDurably).not.toHaveBeenCalled();
    expect(localStorage.getItem(GATE_DEFERRED_MUTATION_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(`${GATE_DEFERRED_MUTATION_STORAGE_KEY}.user-b`)).toBeNull();
  });
});
