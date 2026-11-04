import { describe, expect, it, vi } from 'vitest';
import { DockDirectWidgetNotifyController } from './dock-direct-widget-notify.controller';
import type { DockSnapshot } from '../models/parking-dock';

function createSnapshot(): DockSnapshot {
  return {
    version: 1,
    entries: [],
    focusMode: true,
    isDockExpanded: false,
    muteWaitTone: false,
    session: {
      firstDragIntervened: false,
      focusBlurOn: false,
      focusScrimOn: false,
      mainTaskId: null,
      comboSelectIds: [],
      backupIds: [],
      focusSessionId: 'focus-session-1',
      focusSessionStartedAt: Date.now(),
    },
    dailySlots: [],
    suspendChainRootTaskId: null,
    suspendRecommendationLocked: false,
    pendingDecision: null,
    dailyResetDate: '2026-06-17',
    savedAt: '2026-06-17T00:00:00.000Z',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('DockDirectWidgetNotifyController', () => {
  it('同一 focus 状态在同一秒内重复直推时不应重复调用 widget-notify', async () => {
    vi.setSystemTime(new Date('2026-06-17T00:00:00.500Z'));
    const invoke = vi.fn().mockResolvedValue({ error: null });
    const clientAsync = vi.fn().mockResolvedValue({
      functions: { invoke },
    });
    const getSession = vi.fn().mockResolvedValue({
      data: { session: { access_token: 'token' } },
      error: null,
    });
    const controller = new DockDirectWidgetNotifyController({
      isDestroyed: () => false,
      logger: { debug: vi.fn() },
      supabase: {
        getSession,
        clientAsync,
      } as never,
    });

    await controller.notifyFocusChange('user-1', createSnapshot(), true);
    await controller.notifyFocusChange('user-1', createSnapshot(), true);

    expect(getSession).toHaveBeenCalledTimes(1);
    expect(clientAsync).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      'widget-notify',
      expect.objectContaining({
        body: expect.objectContaining({
          webhookId: 'pwa-direct-focus-session-1-on-1781654400',
          focusActive: true,
          focusSessionId: 'focus-session-1',
        }),
      }),
    );
  });

  it('较旧的 focus 直推晚于较新状态完成时不应再发送过期 widget-notify', async () => {
    const firstSession = deferred<{ data: { session: { access_token: string } }; error: null }>();
    const secondSession = deferred<{ data: { session: { access_token: string } }; error: null }>();
    const invoke = vi.fn().mockResolvedValue({ error: null });
    const clientAsync = vi.fn().mockResolvedValue({
      functions: { invoke },
    });
    const controller = new DockDirectWidgetNotifyController({
      isDestroyed: () => false,
      logger: { debug: vi.fn() },
      supabase: {
        getSession: vi.fn()
          .mockReturnValueOnce(firstSession.promise)
          .mockReturnValueOnce(secondSession.promise),
        clientAsync,
      } as never,
    });

    const firstNotify = controller.notifyFocusChange('user-1', createSnapshot(), true);
    const secondNotify = controller.notifyFocusChange('user-1', createSnapshot(), false);
    secondSession.resolve({ data: { session: { access_token: 'token' } }, error: null });
    await secondNotify;

    firstSession.resolve({ data: { session: { access_token: 'token' } }, error: null });
    await firstNotify;

    expect(clientAsync).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      'widget-notify',
      expect.objectContaining({
        body: expect.objectContaining({
          focusActive: false,
        }),
      }),
    );
  });

  it('有 outbox 时先持久化直推通知，远端成功后才删除 pending', async () => {
    const events: string[] = [];
    const record = {
      operationId: 'operation-1',
      webhookId: 'pwa-direct-operation-1',
      focusSessionId: 'focus-session-1',
      focusActive: true,
      updatedAt: '2026-06-17T00:00:00.000Z',
      createdAt: '2026-06-17T00:00:00.000Z',
      queuedAt: '2026-06-17T00:00:00.000Z',
      attemptCount: 0,
    };
    const outbox = {
      enqueueLatest: vi.fn(async () => {
        events.push('enqueue');
        return record;
      }),
      removeRecord: vi.fn(async () => {
        events.push('remove-pending');
      }),
      buildInvokeBody: vi.fn(() => ({
        directNotify: true,
        webhookId: record.webhookId,
        focusActive: record.focusActive,
        focusSessionId: record.focusSessionId,
        updatedAt: record.updatedAt,
      })),
    };
    const invoke = vi.fn(async () => {
      events.push('invoke');
      return { error: null };
    });
    const controller = new DockDirectWidgetNotifyController({
      isDestroyed: () => false,
      logger: { debug: vi.fn() },
      outbox,
      supabase: {
        getSession: vi.fn().mockResolvedValue({
          data: { session: { access_token: 'token' } },
          error: null,
        }),
        clientAsync: vi.fn().mockResolvedValue({
          functions: { invoke },
        }),
      },
    } as never);

    await controller.notifyFocusChange('user-1', createSnapshot(), true);

    expect(events).toEqual(['enqueue', 'invoke', 'remove-pending']);
    expect(outbox.enqueueLatest).toHaveBeenCalledWith({
      focusSessionId: 'focus-session-1',
      focusActive: true,
      updatedAt: '2026-06-17T00:00:00.000Z',
      ownerUserId: 'user-1',
    });
    expect(invoke).toHaveBeenCalledWith(
      'widget-notify',
      expect.objectContaining({
        body: expect.objectContaining({
          webhookId: 'pwa-direct-operation-1',
          focusActive: true,
          focusSessionId: 'focus-session-1',
        }),
      }),
    );
    expect(outbox.removeRecord).toHaveBeenCalledWith(expect.objectContaining({
      focusSessionId: 'focus-session-1',
    }));
  });

  it('较旧直推晚于新状态完成时不得删除新 pending 或留下旧状态去重', async () => {
    const firstInvoke = deferred<{ error: null }>();
    const records = [
      {
        kind: 'focus' as const,
        operationId: 'operation-old-on',
        webhookId: 'pwa-direct-operation-old-on',
        focusSessionId: 'focus-session-1',
        focusActive: true,
        updatedAt: '2026-06-17T00:00:00.000Z',
        createdAt: '2026-06-17T00:00:00.000Z',
        queuedAt: '2026-06-17T00:00:00.000Z',
        attemptCount: 0,
        ownerUserId: 'user-1',
      },
      {
        kind: 'focus' as const,
        operationId: 'operation-new-off',
        webhookId: 'pwa-direct-operation-new-off',
        focusSessionId: 'focus-session-1',
        focusActive: false,
        updatedAt: '2026-06-17T00:00:01.000Z',
        createdAt: '2026-06-17T00:00:00.000Z',
        queuedAt: '2026-06-17T00:00:01.000Z',
        attemptCount: 0,
        ownerUserId: 'user-1',
      },
      {
        kind: 'focus' as const,
        operationId: 'operation-retry-on',
        webhookId: 'pwa-direct-operation-retry-on',
        focusSessionId: 'focus-session-1',
        focusActive: true,
        updatedAt: '2026-06-17T00:00:02.000Z',
        createdAt: '2026-06-17T00:00:00.000Z',
        queuedAt: '2026-06-17T00:00:02.000Z',
        attemptCount: 0,
        ownerUserId: 'user-1',
      },
    ];
    const outbox = {
      enqueueLatest: vi.fn()
        .mockResolvedValueOnce(records[0])
        .mockResolvedValueOnce(records[1])
        .mockResolvedValueOnce(records[2]),
      removeRecord: vi.fn().mockResolvedValue(undefined),
      buildInvokeBody: vi.fn(record => ({
        directNotify: true,
        webhookId: record.webhookId,
        focusActive: record.focusActive,
        focusSessionId: record.focusSessionId,
        updatedAt: record.updatedAt,
      })),
    };
    const invoke = vi.fn()
      .mockReturnValueOnce(firstInvoke.promise)
      .mockResolvedValueOnce({ error: { message: 'offline' } })
      .mockResolvedValueOnce({ error: { message: 'offline' } });
    const controller = new DockDirectWidgetNotifyController({
      isDestroyed: () => false,
      logger: { debug: vi.fn() },
      outbox,
      supabase: {
        getSession: vi.fn().mockResolvedValue({
          data: { session: { access_token: 'token' } },
          error: null,
        }),
        clientAsync: vi.fn().mockResolvedValue({ functions: { invoke } }),
      },
    } as never);

    const oldNotify = controller.notifyFocusChange('user-1', createSnapshot(), true);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    await controller.notifyFocusChange('user-1', createSnapshot(), false);
    firstInvoke.resolve({ error: null });
    await oldNotify;

    expect(outbox.removeRecord).not.toHaveBeenCalled();

    await controller.notifyFocusChange('user-1', createSnapshot(), true);

    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('dispose 期间完成的直推不得删除 pending 或重新写入去重状态', async () => {
    const pendingInvoke = deferred<{ error: null }>();
    const outbox = {
      enqueueLatest: vi.fn()
        .mockResolvedValueOnce({
          kind: 'focus' as const,
          operationId: 'operation-before-dispose',
          webhookId: 'pwa-direct-operation-before-dispose',
          focusSessionId: 'focus-session-1',
          focusActive: true,
          updatedAt: '2026-06-17T00:00:00.000Z',
          createdAt: '2026-06-17T00:00:00.000Z',
          queuedAt: '2026-06-17T00:00:00.000Z',
          attemptCount: 0,
          ownerUserId: 'user-1',
        })
        .mockResolvedValueOnce({
          kind: 'focus' as const,
          operationId: 'operation-after-dispose',
          webhookId: 'pwa-direct-operation-after-dispose',
          focusSessionId: 'focus-session-1',
          focusActive: true,
          updatedAt: '2026-06-17T00:00:01.000Z',
          createdAt: '2026-06-17T00:00:00.000Z',
          queuedAt: '2026-06-17T00:00:01.000Z',
          attemptCount: 0,
          ownerUserId: 'user-1',
        }),
      removeRecord: vi.fn().mockResolvedValue(undefined),
      buildInvokeBody: vi.fn(record => ({
        directNotify: true,
        webhookId: record.webhookId,
        focusActive: record.focusActive,
        focusSessionId: record.focusSessionId,
        updatedAt: record.updatedAt,
      })),
    };
    const invoke = vi.fn()
      .mockReturnValueOnce(pendingInvoke.promise)
      .mockResolvedValueOnce({ error: { message: 'offline' } });
    const controller = new DockDirectWidgetNotifyController({
      isDestroyed: () => false,
      logger: { debug: vi.fn() },
      outbox,
      supabase: {
        getSession: vi.fn().mockResolvedValue({
          data: { session: { access_token: 'token' } },
          error: null,
        }),
        clientAsync: vi.fn().mockResolvedValue({ functions: { invoke } }),
      },
    } as never);

    const notify = controller.notifyFocusChange('user-1', createSnapshot(), true);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    controller.dispose();
    pendingInvoke.resolve({ error: null });
    await notify;

    expect(outbox.removeRecord).not.toHaveBeenCalled();

    await controller.notifyFocusChange('user-1', createSnapshot(), true);

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('dispose 后旧请求 finally 不得释放新同 key 请求的去重状态', async () => {
    const staleInvoke = deferred<{ error: null }>();
    const currentInvoke = deferred<{ error: null }>();
    const invoke = vi.fn()
      .mockReturnValueOnce(staleInvoke.promise)
      .mockReturnValueOnce(currentInvoke.promise)
      .mockResolvedValue({ error: { message: 'unexpected duplicate invoke' } });
    const controller = new DockDirectWidgetNotifyController({
      isDestroyed: () => false,
      logger: { debug: vi.fn() },
      supabase: {
        getSession: vi.fn().mockResolvedValue({
          data: { session: { access_token: 'token' } },
          error: null,
        }),
        clientAsync: vi.fn().mockResolvedValue({ functions: { invoke } }),
      } as never,
    });

    const staleNotify = controller.notifyFocusChange('user-1', createSnapshot(), true);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    controller.dispose();
    const currentNotify = controller.notifyFocusChange('user-1', createSnapshot(), true);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));

    staleInvoke.resolve({ error: null });
    await staleNotify;
    await controller.notifyFocusChange('user-1', createSnapshot(), true);

    expect(invoke).toHaveBeenCalledTimes(2);

    currentInvoke.resolve({ error: null });
    await currentNotify;
    await controller.notifyFocusChange('user-1', createSnapshot(), true);

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('dispose 应清理直推去重 timer 并释放去重状态', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-17T00:00:00.500Z'));
      const invoke = vi.fn().mockResolvedValue({ error: null });
      const clientAsync = vi.fn().mockResolvedValue({
        functions: { invoke },
      });
      const getSession = vi.fn().mockResolvedValue({
        data: { session: { access_token: 'token' } },
        error: null,
      });
      const controller = new DockDirectWidgetNotifyController({
        isDestroyed: () => false,
        logger: { debug: vi.fn() },
        supabase: {
          getSession,
          clientAsync,
        } as never,
      });

      await controller.notifyFocusChange('user-1', createSnapshot(), true);
      expect(vi.getTimerCount()).toBe(1);

      (controller as unknown as { dispose: () => void }).dispose();

      expect(vi.getTimerCount()).toBe(0);

      await controller.notifyFocusChange('user-1', createSnapshot(), true);

      expect(invoke).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
