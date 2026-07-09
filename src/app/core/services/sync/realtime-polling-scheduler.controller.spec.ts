import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYNC_CONFIG } from '../../../../config';
import {
  RealtimePollingSchedulerController,
  type RealtimePollingSchedulerRuntime,
} from './realtime-polling-scheduler.controller';

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
};

describe('RealtimePollingSchedulerController', () => {
  let controller: RealtimePollingSchedulerController;
  let runtime: RealtimePollingSchedulerRuntime;
  let onRemoteChange: ReturnType<typeof vi.fn<RealtimePollingSchedulerRuntime['onRemoteChange']>>;
  let info: ReturnType<typeof vi.fn<(message: string, data?: unknown) => void>>;
  let debug: ReturnType<typeof vi.fn<(message: string, data?: unknown) => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    onRemoteChange = vi.fn<RealtimePollingSchedulerRuntime['onRemoteChange']>().mockResolvedValue(undefined);
    runtime = {
      isTransportContextCurrent: vi.fn().mockReturnValue(true),
      canActivateRemoteTransport: vi.fn().mockReturnValue(true),
      isOnline: vi.fn().mockReturnValue(true),
      isRealtimePaused: vi.fn().mockReturnValue(false),
      hasRealtimeChannel: vi.fn().mockReturnValue(false),
      maybeReenterRealtimeFromPolling: vi.fn().mockResolvedValue(false),
      onRemoteChange,
    };
    info = vi.fn<(message: string, data?: unknown) => void>();
    debug = vi.fn<(message: string, data?: unknown) => void>();
    controller = new RealtimePollingSchedulerController({
      info,
      debug,
    });
  });

  afterEach(() => {
    controller.cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('启动轮询时立即执行一次，并按用户活跃间隔调度下一次', async () => {
    controller.startPolling('project-1', 'user-1', 1, runtime);
    await flushMicrotasks();

    expect(onRemoteChange).toHaveBeenCalledTimes(1);
    expect(onRemoteChange).toHaveBeenCalledWith({
      eventType: 'polling',
      projectId: 'project-1',
    });

    await vi.advanceTimersByTimeAsync(SYNC_CONFIG.POLLING_ACTIVE_INTERVAL - 1);
    expect(onRemoteChange).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(onRemoteChange).toHaveBeenCalledTimes(2);
  });

  it('启动轮询日志失败时仍应启动 polling 兜底', async () => {
    info.mockImplementationOnce(() => {
      throw new Error('logger unavailable');
    });

    expect(() => controller.startPolling('project-1', 'user-1', 1, runtime)).not.toThrow();
    await flushMicrotasks();

    expect(onRemoteChange).toHaveBeenCalledTimes(1);
    expect(controller.hasActivePolling()).toBe(true);
  });

  it('realtime channel 已存在时不应启动 polling 兜底，避免重复远程变更触发', async () => {
    vi.mocked(runtime.hasRealtimeChannel).mockReturnValue(true);

    controller.startPolling('project-1', 'user-1', 1, runtime);
    await flushMicrotasks();

    expect(onRemoteChange).not.toHaveBeenCalled();
    expect(controller.hasActivePolling()).toBe(false);
  });

  it('stopPolling 会清除已调度的下一次轮询', async () => {
    controller.startPolling('project-1', 'user-1', 1, runtime);
    await flushMicrotasks();

    controller.stopPolling();
    await vi.advanceTimersByTimeAsync(SYNC_CONFIG.POLLING_ACTIVE_INTERVAL);

    expect(onRemoteChange).toHaveBeenCalledTimes(1);
    expect(controller.hasActivePolling()).toBe(false);
  });

  it('stopPolling 会清除 timer handle 为 0 的已调度轮询', async () => {
    const pollingTimer = 0 as unknown as ReturnType<typeof globalThis.setTimeout>;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => pollingTimer);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);

    controller.startPolling('project-1', 'user-1', 1, runtime);
    await flushMicrotasks();

    expect(setTimeoutSpy).toHaveBeenCalledOnce();

    controller.stopPolling();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    expect(controller.hasActivePolling()).toBe(false);
  });

  it('stopPolling 清理 polling timer 失败时仍应关闭轮询状态', async () => {
    const pollingTimer = 1 as unknown as ReturnType<typeof globalThis.setTimeout>;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => pollingTimer);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {
      throw new Error('polling timer cleanup failed');
    });

    controller.startPolling('project-1', 'user-1', 1, runtime);
    await flushMicrotasks();

    expect(() => controller.stopPolling()).not.toThrow();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(pollingTimer);
    expect(controller.hasActivePolling()).toBe(false);
  });

  it('过期轮询 timer 回调不应清空新 run 的 timer handle', async () => {
    const scheduledCallbacks = new Map<number, () => unknown>();
    let nextTimerId = 1;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      .mockImplementation((callback: () => unknown) => {
        const timerId = nextTimerId++;
        scheduledCallbacks.set(timerId, callback);
        return timerId as unknown as ReturnType<typeof globalThis.setTimeout>;
      });
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);

    controller.startPolling('project-1', 'user-1', 1, runtime);
    await flushMicrotasks();
    controller.startPolling('project-2', 'user-1', 2, runtime);
    await flushMicrotasks();

    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(1);

    await scheduledCallbacks.get(1)?.();
    controller.stopPolling();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(2);
  });

  it('已调度的轮询触发时 context 过期应清空活跃轮询状态', async () => {
    controller.startPolling('project-1', 'user-1', 1, runtime);
    await flushMicrotasks();
    expect(onRemoteChange).toHaveBeenCalledTimes(1);
    expect(controller.hasActivePolling()).toBe(true);

    vi.mocked(runtime.isTransportContextCurrent).mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(SYNC_CONFIG.POLLING_ACTIVE_INTERVAL);

    expect(onRemoteChange).toHaveBeenCalledTimes(1);
    expect(controller.hasActivePolling()).toBe(false);
  });

  it('已调度的轮询触发时离线应停止后续调度', async () => {
    controller.startPolling('project-1', 'user-1', 1, runtime);
    await flushMicrotasks();

    vi.mocked(runtime.isOnline).mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(SYNC_CONFIG.POLLING_ACTIVE_INTERVAL);

    expect(onRemoteChange).toHaveBeenCalledTimes(1);
    expect(controller.hasActivePolling()).toBe(false);
  });

  it('已调度的轮询触发时 realtime 暂停应停止后续调度', async () => {
    controller.startPolling('project-1', 'user-1', 1, runtime);
    await flushMicrotasks();

    vi.mocked(runtime.isRealtimePaused).mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(SYNC_CONFIG.POLLING_ACTIVE_INTERVAL);

    expect(onRemoteChange).toHaveBeenCalledTimes(1);
    expect(controller.hasActivePolling()).toBe(false);
  });

  it('cleanup 会移除用户活跃监听并清除活跃计时器', () => {
    const addListenerSpy = vi.spyOn(window, 'addEventListener');
    const removeListenerSpy = vi.spyOn(window, 'removeEventListener');

    controller.startUserActivityTracking();
    controller.cleanup();

    for (const event of ['mousedown', 'keydown', 'touchstart', 'scroll']) {
      expect(addListenerSpy).toHaveBeenCalledWith(event, expect.any(Function), { passive: true });
      expect(removeListenerSpy).toHaveBeenCalledWith(event, expect.any(Function));
    }
    expect(controller.hasActivePolling()).toBe(false);
  });

  it('cleanup 会清除 timer handle 为 0 的用户活跃计时器', () => {
    const userActiveTimer = 0 as unknown as ReturnType<typeof globalThis.setTimeout>;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => userActiveTimer);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);

    controller.startUserActivityTracking();
    controller.cleanup();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
  });

  it('cleanup 清理用户活跃计时器失败时仍应移除监听并关闭活跃计时器状态', () => {
    const userActiveTimer = 1 as unknown as ReturnType<typeof globalThis.setTimeout>;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => userActiveTimer);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {
      throw new Error('user active timer cleanup failed');
    });
    const removeListenerSpy = vi.spyOn(window, 'removeEventListener');

    controller.startUserActivityTracking();

    expect(() => controller.cleanup()).not.toThrow();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(userActiveTimer);
    expect(removeListenerSpy).toHaveBeenCalledTimes(4);
    expect((controller as unknown as { userActiveTimer: unknown }).userActiveTimer).toBeNull();
  });

  it('用户活跃事件重置会清除 timer handle 为 0 的旧计时器', () => {
    const userActiveTimer = 0 as unknown as ReturnType<typeof globalThis.setTimeout>;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => userActiveTimer);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);

    controller.startUserActivityTracking();
    clearTimeoutSpy.mockClear();
    window.dispatchEvent(new Event('mousedown'));

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
  });

  it('用户活跃事件重置旧计时器失败时仍应安装新的活跃计时器', () => {
    const timers = [
      1 as unknown as ReturnType<typeof globalThis.setTimeout>,
      2 as unknown as ReturnType<typeof globalThis.setTimeout>,
    ];
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      .mockImplementation(() => timers.shift() ?? (3 as unknown as ReturnType<typeof globalThis.setTimeout>));
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {
      throw new Error('user active timer cleanup failed');
    });

    controller.startUserActivityTracking();
    setTimeoutSpy.mockClear();

    expect(() => window.dispatchEvent(new Event('mousedown'))).not.toThrow();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(1);
    expect(setTimeoutSpy).toHaveBeenCalledOnce();
    expect((controller as unknown as { userActiveTimer: unknown }).userActiveTimer).toBe(2);
  });

  it('被新用户活跃计时器替换的旧回调不应把状态改为 inactive', () => {
    const userActiveCallbacks = new Map<number, () => void>();
    let nextTimerId = 1;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: () => void) => {
      const timerId = nextTimerId++;
      userActiveCallbacks.set(timerId, callback);
      return timerId as unknown as ReturnType<typeof globalThis.setTimeout>;
    });
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);

    controller.startUserActivityTracking();
    window.dispatchEvent(new Event('mousedown'));

    userActiveCallbacks.get(1)?.();

    expect((controller as unknown as { isUserActive: boolean }).isUserActive).toBe(true);
  });

  it('cleanup 隔离单个用户活跃监听清理失败并继续移除其他监听', () => {
    const addListenerSpy = vi.spyOn(window, 'addEventListener');
    const removeEventListener = window.removeEventListener.bind(window);
    const removeListenerSpy = vi.spyOn(window, 'removeEventListener')
      .mockImplementationOnce((...args: Parameters<typeof window.removeEventListener>) => {
        removeEventListener(...args);
        throw new Error('listener cleanup failed');
      });

    controller.startUserActivityTracking();
    controller.cleanup();

    expect(addListenerSpy).toHaveBeenCalledTimes(4);
    expect(removeListenerSpy).toHaveBeenCalledTimes(4);
    expect(debug).toHaveBeenCalledWith(
      '用户活跃监听清理失败，继续清理其他监听',
      expect.any(Error),
    );
  });

  it('cleanup 记录监听清理失败时应隔离 logger 失败并继续移除其他监听', () => {
    const addListenerSpy = vi.spyOn(window, 'addEventListener');
    const removeEventListener = window.removeEventListener.bind(window);
    const removeListenerSpy = vi.spyOn(window, 'removeEventListener')
      .mockImplementationOnce((...args: Parameters<typeof window.removeEventListener>) => {
        removeEventListener(...args);
        throw new Error('listener cleanup failed');
      });
    debug.mockImplementationOnce(() => {
      throw new Error('logger unavailable');
    });

    controller.startUserActivityTracking();

    expect(() => controller.cleanup()).not.toThrow();

    expect(addListenerSpy).toHaveBeenCalledTimes(4);
    expect(removeListenerSpy).toHaveBeenCalledTimes(4);
    expect(debug).toHaveBeenCalledWith(
      '用户活跃监听清理失败，继续清理其他监听',
      expect.any(Error),
    );
  });

  it('cleanup 后未移除成功的旧用户活跃监听不应重新调度活跃计时器', () => {
    const staleActivityListeners: Array<(event: Event) => void> = [];
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    vi.spyOn(window, 'addEventListener')
      .mockImplementation((eventName, listener) => {
        if (eventName === 'mousedown') {
          staleActivityListeners.push(listener as (event: Event) => void);
        }
      });
    vi.spyOn(window, 'removeEventListener')
      .mockImplementation((eventName) => {
        if (eventName === 'mousedown') {
          throw new Error('listener cleanup failed');
        }
      });

    controller.startUserActivityTracking();
    controller.cleanup();
    setTimeoutSpy.mockClear();

    expect(staleActivityListeners).toHaveLength(1);
    staleActivityListeners[0]?.(new Event('mousedown'));

    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it('用户活跃监听注册失败时应回滚已注册监听并允许后续重新启动', () => {
    const originalAddEventListener = window.addEventListener.bind(window);
    const addListenerSpy = vi.spyOn(window, 'addEventListener')
      .mockImplementation((eventName, listener, options) => {
        if (eventName === 'keydown') {
          throw new Error('bind keydown failed');
        }
        return originalAddEventListener(eventName, listener, options);
      });
    const removeListenerSpy = vi.spyOn(window, 'removeEventListener');

    expect(() => controller.startUserActivityTracking()).toThrow('bind keydown failed');
    expect(removeListenerSpy).toHaveBeenCalledWith('mousedown', expect.any(Function));

    addListenerSpy.mockRestore();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    window.dispatchEvent(new Event('mousedown'));
    expect(setTimeoutSpy).not.toHaveBeenCalled();

    controller.startUserActivityTracking();
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    setTimeoutSpy.mockClear();

    window.dispatchEvent(new Event('mousedown'));

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });


  it('上一次轮询未完成时跳过并发轮询', async () => {
    let resolveRemoteChange = (): void => {
      throw new Error('onRemoteChange promise resolver was not captured');
    };
    onRemoteChange.mockReturnValue(new Promise<void>(resolve => {
      resolveRemoteChange = resolve;
    }));

    void controller.runPollingTick('project-1', 'user-1', 1, runtime);
    await flushMicrotasks();

    await controller.runPollingTick('project-1', 'user-1', 1, runtime);

    expect(onRemoteChange).toHaveBeenCalledTimes(1);

    resolveRemoteChange();
    await flushMicrotasks();

    await controller.runPollingTick('project-1', 'user-1', 1, runtime);
    expect(onRemoteChange).toHaveBeenCalledTimes(2);
  });

  it('直接 runPollingTick 时隔离运行条件异常并跳过本次 tick', async () => {
    const tickError = new Error('sync state unavailable');
    vi.mocked(runtime.isOnline).mockImplementationOnce(() => {
      throw tickError;
    });

    await expect(controller.runPollingTick('project-1', 'user-1', 1, runtime)).resolves.toBeUndefined();

    expect(onRemoteChange).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith('轮询 tick 执行失败，已跳过本次 tick', tickError);
    expect(controller.hasActivePolling()).toBe(false);
  });

  it('重复启动同一轮询上下文时不应并发执行第二个即时 tick', async () => {
    let resolveRemoteChange = (): void => {
      throw new Error('onRemoteChange promise resolver was not captured');
    };
    onRemoteChange.mockReturnValue(new Promise<void>(resolve => {
      resolveRemoteChange = resolve;
    }));

    controller.startPolling('project-1', 'user-1', 1, runtime);
    await flushMicrotasks();

    controller.startPolling('project-1', 'user-1', 1, runtime);
    await flushMicrotasks();

    expect(onRemoteChange).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith('轮询跳过：上一次 poll 仍在执行');

    resolveRemoteChange();
    await flushMicrotasks();
  });

  it('上一次 realtime 重入探测未完成时跳过并发轮询探测', async () => {
    let resolveReenterProbe = (value: boolean): void => {
      void value;
      throw new Error('maybeReenter promise resolver was not captured');
    };
    vi.mocked(runtime.maybeReenterRealtimeFromPolling)
      .mockReturnValue(new Promise<boolean>(resolve => {
        resolveReenterProbe = resolve;
      }));

    void controller.runPollingTick('project-1', 'user-1', 1, runtime);
    await flushMicrotasks();

    void controller.runPollingTick('project-1', 'user-1', 1, runtime);
    await flushMicrotasks();

    expect(runtime.maybeReenterRealtimeFromPolling).toHaveBeenCalledTimes(1);
    expect(onRemoteChange).not.toHaveBeenCalled();

    resolveReenterProbe(false);
    await flushMicrotasks();

    expect(onRemoteChange).toHaveBeenCalledTimes(1);
  });

  it('realtime 重入探测等待期间 context 失效时不应触发旧项目轮询', async () => {
    let resolveReenterProbe = (value: boolean): void => {
      void value;
      throw new Error('maybeReenter promise resolver was not captured');
    };
    vi.mocked(runtime.maybeReenterRealtimeFromPolling)
      .mockReturnValue(new Promise<boolean>(resolve => {
        resolveReenterProbe = resolve;
      }));

    const tick = controller.runPollingTick('project-stale', 'user-1', 1, runtime);
    await flushMicrotasks();

    expect(runtime.maybeReenterRealtimeFromPolling).toHaveBeenCalledTimes(1);

    vi.mocked(runtime.isTransportContextCurrent).mockReturnValue(false);
    resolveReenterProbe(false);
    await tick;

    expect(onRemoteChange).not.toHaveBeenCalled();
    expect(controller.hasActivePolling()).toBe(false);
  });

  it('realtime 暂停发生在重入探测等待期间时不应触发轮询回调', async () => {
    let resolveReenterProbe = (value: boolean): void => {
      void value;
      throw new Error('maybeReenter promise resolver was not captured');
    };
    vi.mocked(runtime.maybeReenterRealtimeFromPolling)
      .mockReturnValue(new Promise<boolean>(resolve => {
        resolveReenterProbe = resolve;
      }));

    const tick = controller.runPollingTick('project-1', 'user-1', 1, runtime);
    await flushMicrotasks();

    vi.mocked(runtime.isRealtimePaused).mockReturnValue(true);
    resolveReenterProbe(false);
    await tick;

    expect(onRemoteChange).not.toHaveBeenCalled();
    expect(controller.hasActivePolling()).toBe(false);
  });

  it('realtime 重入成功后应释放活跃轮询状态并允许后续轮询', async () => {
    vi.mocked(runtime.maybeReenterRealtimeFromPolling)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);

    await controller.runPollingTick('project-1', 'user-1', 1, runtime);

    expect(onRemoteChange).not.toHaveBeenCalled();
    expect(controller.hasActivePolling()).toBe(false);

    await controller.runPollingTick('project-1', 'user-1', 1, runtime);

    expect(runtime.maybeReenterRealtimeFromPolling).toHaveBeenCalledTimes(2);
    expect(onRemoteChange).toHaveBeenCalledTimes(1);
  });

  it('新的轮询 run 不应被旧 run 的未完成 tick 阻塞', async () => {
    let resolveRemoteChange = (): void => {
      throw new Error('onRemoteChange promise resolver was not captured');
    };
    onRemoteChange.mockReturnValueOnce(new Promise<void>(resolve => {
      resolveRemoteChange = resolve;
    }));

    controller.startPolling('project-1', 'user-1', 1, runtime);
    await flushMicrotasks();

    controller.startPolling('project-2', 'user-1', 2, runtime);
    await flushMicrotasks();

    expect(onRemoteChange).toHaveBeenCalledTimes(2);
    expect(onRemoteChange).toHaveBeenNthCalledWith(2, {
      eventType: 'polling',
      projectId: 'project-2',
    });

    resolveRemoteChange();
    await flushMicrotasks();
  });

  it('重新启动同一轮询上下文不应被已停止 run 的未完成 tick 阻塞', async () => {
    let resolveRemoteChange = (): void => {
      throw new Error('onRemoteChange promise resolver was not captured');
    };
    onRemoteChange.mockReturnValueOnce(new Promise<void>(resolve => {
      resolveRemoteChange = resolve;
    }));

    controller.startPolling('project-1', 'user-1', 1, runtime);
    await flushMicrotasks();
    controller.stopPolling();

    controller.startPolling('project-1', 'user-1', 1, runtime);
    await flushMicrotasks();

    expect(onRemoteChange).toHaveBeenCalledTimes(2);
    expect(onRemoteChange).toHaveBeenNthCalledWith(2, {
      eventType: 'polling',
      projectId: 'project-1',
    });

    resolveRemoteChange();
    await flushMicrotasks();
  });

  it('stopPolling 后未完成的启动 tick 不应继续触发旧轮询回调', async () => {
    let resolveReenterProbe = (value: boolean): void => {
      void value;
      throw new Error('maybeReenter promise resolver was not captured');
    };
    vi.mocked(runtime.maybeReenterRealtimeFromPolling)
      .mockReturnValue(new Promise<boolean>(resolve => {
        resolveReenterProbe = resolve;
      }));

    controller.startPolling('project-1', 'user-1', 1, runtime);
    await flushMicrotasks();

    expect(runtime.maybeReenterRealtimeFromPolling).toHaveBeenCalledTimes(1);

    controller.stopPolling();
    resolveReenterProbe(false);
    await flushMicrotasks();

    expect(onRemoteChange).not.toHaveBeenCalled();
    expect(controller.hasActivePolling()).toBe(false);
  });

  it('旧 run 的未完成 tick 结束时不应清除新 run 的同 key 活跃状态', async () => {
    let resolveOldRemoteChange = (): void => {
      throw new Error('old onRemoteChange resolver was not captured');
    };
    let resolveNewRemoteChange = (): void => {
      throw new Error('new onRemoteChange resolver was not captured');
    };
    onRemoteChange
      .mockReturnValueOnce(new Promise<void>(resolve => {
        resolveOldRemoteChange = resolve;
      }))
      .mockReturnValueOnce(new Promise<void>(resolve => {
        resolveNewRemoteChange = resolve;
      }));

    controller.startPolling('project-1', 'user-1', 1, runtime);
    await flushMicrotasks();
    controller.stopPolling();
    controller.startPolling('project-1', 'user-1', 1, runtime);
    await flushMicrotasks();

    resolveOldRemoteChange();
    await flushMicrotasks();

    await controller.runPollingTick('project-1', 'user-1', 1, runtime);

    expect(onRemoteChange).toHaveBeenCalledTimes(2);

    resolveNewRemoteChange();
    await flushMicrotasks();
  });

  it('realtime 重入探测失败时继续执行轮询并保留下次调度', async () => {
    vi.mocked(runtime.maybeReenterRealtimeFromPolling).mockRejectedValue(new Error('reenter failed'));

    controller.startPolling('project-1', 'user-1', 1, runtime);
    await flushMicrotasks();

    expect(onRemoteChange).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(SYNC_CONFIG.POLLING_ACTIVE_INTERVAL);

    expect(onRemoteChange).toHaveBeenCalledTimes(2);
  });

  it('隔离轮询 tick 运行时异常并继续调度下一次轮询', async () => {
    const tickError = new Error('online state unavailable');
    vi.mocked(runtime.isOnline)
      .mockImplementationOnce(() => {
        throw tickError;
      })
      .mockReturnValue(true);

    controller.startPolling('project-1', 'user-1', 1, runtime);
    await flushMicrotasks();

    expect(onRemoteChange).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith('轮询 tick 执行失败，保留下次调度', tickError);

    await vi.advanceTimersByTimeAsync(SYNC_CONFIG.POLLING_ACTIVE_INTERVAL);

    expect(onRemoteChange).toHaveBeenCalledTimes(1);
  });

  it('隔离轮询调度条件异常并停止当前轮询 run', async () => {
    const scheduleError = new Error('schedule state unavailable');
    vi.mocked(runtime.isOnline)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockImplementationOnce(() => {
        throw scheduleError;
      });

    expect(() => controller.startPolling('project-1', 'user-1', 1, runtime)).not.toThrow();
    await flushMicrotasks();

    expect(onRemoteChange).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith('轮询调度条件检查失败，停止当前轮询', scheduleError);
    expect(controller.hasActivePolling()).toBe(false);
  });

  it('调度下一次轮询的二次条件检查异常时应隔离错误并停止当前轮询 run', async () => {
    const scheduleError = new Error('second schedule state unavailable');
    let onlineCheckCount = 0;
    vi.mocked(runtime.isOnline).mockImplementation(() => {
      onlineCheckCount += 1;
      if (onlineCheckCount === 4) {
        throw scheduleError;
      }
      return true;
    });

    controller.startPolling('project-1', 'user-1', 1, runtime);
    await flushMicrotasks();

    expect(onRemoteChange).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith('轮询调度条件检查失败，停止当前轮询', scheduleError);
    expect(controller.hasActivePolling()).toBe(false);
  });

  it('启动前置条件异常时应隔离错误并保持轮询关闭', () => {
    const preflightError = new Error('transport context unavailable');
    vi.mocked(runtime.isTransportContextCurrent).mockImplementationOnce(() => {
      throw preflightError;
    });

    expect(() => controller.startPolling('project-1', 'user-1', 1, runtime)).not.toThrow();

    expect(onRemoteChange).not.toHaveBeenCalled();
    expect(controller.hasActivePolling()).toBe(false);
    expect(debug).toHaveBeenCalledWith('轮询启动条件检查失败，跳过本次启动', preflightError);
  });

  it('启动前置条件异常时清除旧活跃轮询状态，避免悬挂 tick 阻塞后续启动', async () => {
    onRemoteChange.mockReturnValueOnce(new Promise<void>(() => undefined));

    controller.startPolling('project-1', 'user-1', 1, runtime);
    await flushMicrotasks();

    expect(onRemoteChange).toHaveBeenCalledTimes(1);
    expect(controller.hasActivePolling()).toBe(true);

    const preflightError = new Error('transport context unavailable');
    vi.mocked(runtime.isTransportContextCurrent).mockImplementationOnce(() => {
      throw preflightError;
    });

    controller.startPolling('project-1', 'user-1', 1, runtime);

    expect(controller.hasActivePolling()).toBe(false);
    expect(debug).toHaveBeenCalledWith('轮询启动条件检查失败，跳过本次启动', preflightError);

    vi.mocked(runtime.isTransportContextCurrent).mockReturnValue(true);
    onRemoteChange.mockResolvedValue(undefined);

    controller.startPolling('project-1', 'user-1', 1, runtime);
    await flushMicrotasks();

    expect(onRemoteChange).toHaveBeenCalledTimes(2);
  });
});
