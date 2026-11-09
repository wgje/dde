import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RealtimeStatusController,
  type RealtimeStatusControllerRuntime,
  type RealtimeStatusTransportCircuit,
  type RealtimeSubscribeState,
} from './realtime-status.controller';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../../../../utils/browser-network-suspension';

type RealtimeStatusTelemetry = ConstructorParameters<typeof RealtimeStatusController>[1];
type RealtimeStatusLogger = ConstructorParameters<typeof RealtimeStatusController>[0];

describe('RealtimeStatusController', () => {
  let controller: RealtimeStatusController;
  let runtime: RealtimeStatusControllerRuntime;
  let circuit: RealtimeStatusTransportCircuit;
  let isBrowserNetworkSuspendedWindow: ReturnType<typeof vi.fn<() => boolean>>;
  let logger: {
    info: ReturnType<typeof vi.fn<RealtimeStatusLogger['info']>>;
    debug: ReturnType<typeof vi.fn<RealtimeStatusLogger['debug']>>;
    warn: ReturnType<typeof vi.fn<RealtimeStatusLogger['warn']>>;
  };
  let sentry: {
    addBreadcrumb: ReturnType<typeof vi.fn<RealtimeStatusTelemetry['addBreadcrumb']>>;
    captureMessage: ReturnType<typeof vi.fn<RealtimeStatusTelemetry['captureMessage']>>;
  };
  let state: RealtimeSubscribeState;

  beforeEach(() => {
    resetBrowserNetworkSuspensionTrackingForTests();
    isBrowserNetworkSuspendedWindow = vi.fn(() => false);
    sentry = {
      addBreadcrumb: vi.fn<RealtimeStatusTelemetry['addBreadcrumb']>(),
      captureMessage: vi.fn<RealtimeStatusTelemetry['captureMessage']>(),
    };
    logger = {
      info: vi.fn<RealtimeStatusLogger['info']>(),
      debug: vi.fn<RealtimeStatusLogger['debug']>(),
      warn: vi.fn<RealtimeStatusLogger['warn']>(),
    };
    circuit = {
      armCircuit: vi.fn().mockReturnValue(60_000),
      clearBackoff: vi.fn(),
      clearCircuit: vi.fn(),
    };
    runtime = {
      isStateCurrent: vi.fn().mockReturnValue(true),
      isRealtimeEnabled: vi.fn().mockReturnValue(true),
      fallbackToPolling: vi.fn(),
      triggerRealtimeReconnectChange: vi.fn(),
    };
    state = {
      projectId: 'project-1',
      userId: 'user-1',
      transportGeneration: 1,
      channelName: 'project:project-1:user-1',
      channel: {} as RealtimeSubscribeState['channel'],
      previousStatus: null,
      consecutiveErrors: 0,
    };
    controller = new RealtimeStatusController(
      logger,
      sentry,
      circuit,
      isBrowserNetworkSuspendedWindow,
    );
  });

  it('连续通道错误达到阈值后记录熔断并降级到轮询', () => {
    controller.handleSubscribeStatus('CHANNEL_ERROR', { message: 'first' }, state, runtime);
    controller.handleSubscribeStatus('CHANNEL_ERROR', { message: 'second' }, state, runtime);
    controller.handleSubscribeStatus('TIMED_OUT', { message: 'third' }, state, runtime);

    expect(circuit.armCircuit).toHaveBeenCalledWith('user-1', 'third', 3);
    expect(sentry.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      message: 'realtime_fallback_polling_started',
    }));
    expect(sentry.captureMessage).toHaveBeenCalledWith('Realtime 订阅错误', expect.objectContaining({
      level: 'warning',
    }));
    expect(runtime.fallbackToPolling).toHaveBeenCalledWith('project-1', 'user-1', 1);
  });

  it('降级事件记录 sink 失败时仍降级到轮询', () => {
    vi.mocked(logger.warn).mockImplementation(() => {
      throw new Error('logger failed');
    });
    vi.mocked(sentry.captureMessage).mockImplementation(() => {
      throw new Error('telemetry failed');
    });

    controller.handleSubscribeStatus('CHANNEL_ERROR', { message: 'first' }, state, runtime);
    controller.handleSubscribeStatus('CHANNEL_ERROR', { message: 'second' }, state, runtime);

    expect(() => {
      controller.handleSubscribeStatus('TIMED_OUT', { message: 'third' }, state, runtime);
    }).not.toThrow();

    expect(circuit.armCircuit).toHaveBeenCalledWith('user-1', 'third', 3);
    expect(sentry.captureMessage).toHaveBeenCalledWith('Realtime 订阅错误', expect.objectContaining({
      level: 'warning',
    }));
    expect(logger.warn).toHaveBeenCalledWith('Realtime 连续失败，降级到轮询', expect.objectContaining({
      consecutiveErrors: 3,
      realtimeCircuitMs: 60_000,
    }));
    expect(runtime.fallbackToPolling).toHaveBeenCalledWith('project-1', 'user-1', 1);
    expect(state.previousStatus).toBe('TIMED_OUT');
  });

  it('CLOSED 状态应参与连续通道错误阈值并降级到轮询', () => {
    controller.handleSubscribeStatus('CHANNEL_ERROR', { message: 'first' }, state, runtime);
    controller.handleSubscribeStatus('TIMED_OUT', { message: 'second' }, state, runtime);
    controller.handleSubscribeStatus('CLOSED', { message: 'closed' }, state, runtime);

    expect(circuit.armCircuit).toHaveBeenCalledWith('user-1', 'closed', 3);
    expect(sentry.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      message: 'realtime_fallback_polling_started',
    }));
    expect(runtime.fallbackToPolling).toHaveBeenCalledWith('project-1', 'user-1', 1);
    expect(state.consecutiveErrors).toBe(3);
  });

  it('连续通道错误超过阈值后不会重复降级到轮询', () => {
    controller.handleSubscribeStatus('CHANNEL_ERROR', { message: 'first' }, state, runtime);
    controller.handleSubscribeStatus('CHANNEL_ERROR', { message: 'second' }, state, runtime);
    controller.handleSubscribeStatus('TIMED_OUT', { message: 'third' }, state, runtime);
    controller.handleSubscribeStatus('CHANNEL_ERROR', { message: 'fourth' }, state, runtime);

    expect(circuit.armCircuit).toHaveBeenCalledTimes(1);
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(runtime.fallbackToPolling).toHaveBeenCalledTimes(1);
    expect(state.consecutiveErrors).toBe(4);
  });

  it('降级到轮询失败时隔离 runtime 异常', () => {
    const fallbackError = new Error('fallback failed');
    vi.mocked(runtime.fallbackToPolling).mockImplementation(() => {
      throw fallbackError;
    });

    controller.handleSubscribeStatus('CHANNEL_ERROR', { message: 'first' }, state, runtime);
    controller.handleSubscribeStatus('CHANNEL_ERROR', { message: 'second' }, state, runtime);

    expect(() => {
      controller.handleSubscribeStatus('TIMED_OUT', { message: 'third' }, state, runtime);
    }).not.toThrow();

    expect(circuit.armCircuit).toHaveBeenCalledWith('user-1', 'third', 3);
    expect(runtime.fallbackToPolling).toHaveBeenCalledWith('project-1', 'user-1', 1);
    const fallbackStartedBreadcrumb = sentry.addBreadcrumb.mock.calls.find(
      ([breadcrumb]) => breadcrumb.message === 'realtime_fallback_polling_started',
    );
    const degradedToPollingCapture = sentry.captureMessage.mock.calls.find(
      ([message, context]) => message === 'Realtime 订阅错误'
        && context?.extra?.degradedToPolling === true,
    );
    expect(fallbackStartedBreadcrumb).toBeUndefined();
    expect(degradedToPollingCapture).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith('Realtime 降级到轮询失败', fallbackError);
  });

  it('熔断写入失败时仍应降级到轮询并隔离回调异常', () => {
    const circuitError = new Error('circuit storage failed');
    vi.mocked(circuit.armCircuit).mockImplementation(() => {
      throw circuitError;
    });

    controller.handleSubscribeStatus('CHANNEL_ERROR', { message: 'first' }, state, runtime);
    controller.handleSubscribeStatus('CHANNEL_ERROR', { message: 'second' }, state, runtime);

    expect(() => {
      controller.handleSubscribeStatus('TIMED_OUT', { message: 'third' }, state, runtime);
    }).not.toThrow();

    expect(circuit.armCircuit).toHaveBeenCalledWith('user-1', 'third', 3);
    expect(runtime.fallbackToPolling).toHaveBeenCalledWith('project-1', 'user-1', 1);
    expect(sentry.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      message: 'realtime_fallback_polling_started',
    }));
    expect(logger.warn).toHaveBeenCalledWith('Realtime 熔断状态写入失败', circuitError);
    expect(state.previousStatus).toBe('TIMED_OUT');
  });

  it('降级到轮询失败后下一次通道错误应再次尝试降级', () => {
    const fallbackError = new Error('fallback failed');
    vi.mocked(runtime.fallbackToPolling)
      .mockImplementationOnce(() => {
        throw fallbackError;
      })
      .mockImplementationOnce(() => undefined);

    controller.handleSubscribeStatus('CHANNEL_ERROR', { message: 'first' }, state, runtime);
    controller.handleSubscribeStatus('CHANNEL_ERROR', { message: 'second' }, state, runtime);

    expect(() => {
      controller.handleSubscribeStatus('TIMED_OUT', { message: 'third' }, state, runtime);
    }).not.toThrow();

    controller.handleSubscribeStatus('CHANNEL_ERROR', { message: 'fourth' }, state, runtime);

    expect(runtime.fallbackToPolling).toHaveBeenCalledTimes(2);
    expect(circuit.armCircuit).toHaveBeenCalledTimes(2);
    expect(circuit.armCircuit).toHaveBeenLastCalledWith('user-1', 'fourth', 3);
    expect(state.consecutiveErrors).toBe(3);
  });

  it('降级到轮询失败且告警日志失败时仍隔离 runtime 异常', () => {
    const fallbackError = new Error('fallback failed');
    vi.mocked(runtime.fallbackToPolling).mockImplementation(() => {
      throw fallbackError;
    });
    vi.mocked(logger.warn)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('logger failed');
      });

    controller.handleSubscribeStatus('CHANNEL_ERROR', { message: 'first' }, state, runtime);
    controller.handleSubscribeStatus('CHANNEL_ERROR', { message: 'second' }, state, runtime);

    expect(() => {
      controller.handleSubscribeStatus('TIMED_OUT', { message: 'third' }, state, runtime);
    }).not.toThrow();

    expect(circuit.armCircuit).toHaveBeenCalledWith('user-1', 'third', 3);
    expect(runtime.fallbackToPolling).toHaveBeenCalledWith('project-1', 'user-1', 1);
    expect(logger.warn).toHaveBeenCalledWith('Realtime 降级到轮询失败', fallbackError);
    expect(state.previousStatus).toBe('TIMED_OUT');
  });

  it('浏览器网络挂起期间忽略通道错误', () => {
    isBrowserNetworkSuspendedWindow.mockReturnValue(true);

    controller.handleSubscribeStatus('CHANNEL_ERROR', { message: 'suspended' }, state, runtime);

    expect(circuit.armCircuit).not.toHaveBeenCalled();
    expect(runtime.fallbackToPolling).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      '浏览器网络挂起期间忽略 Realtime 通道中断',
      expect.objectContaining({ error: 'suspended' }),
    );
  });

  it('短暂通道错误后恢复订阅应记录错误状态并触发重连增量同步', () => {
    state.previousStatus = 'SUBSCRIBED';

    controller.handleSubscribeStatus('CHANNEL_ERROR', { message: 'temporary' }, state, runtime);
    expect(state.previousStatus).toBe('CHANNEL_ERROR');

    controller.handleSubscribeStatus('SUBSCRIBED', undefined, state, runtime);

    expect(runtime.triggerRealtimeReconnectChange).toHaveBeenCalledWith('project-1');
    expect(state.previousStatus).toBe('SUBSCRIBED');
    expect(state.consecutiveErrors).toBe(0);
  });

  it('订阅成功后清理熔断状态，并在重连场景触发增量同步', () => {
    state.previousStatus = 'TIMED_OUT';
    state.consecutiveErrors = 2;

    controller.handleSubscribeStatus('SUBSCRIBED', undefined, state, runtime);

    expect(circuit.clearBackoff).toHaveBeenCalledWith('project-1');
    expect(circuit.clearCircuit).toHaveBeenCalled();
    expect(runtime.triggerRealtimeReconnectChange).toHaveBeenCalledWith('project-1');
    expect(state.consecutiveErrors).toBe(0);
    expect(state.previousStatus).toBe('SUBSCRIBED');
  });

  it('订阅状态日志失败时仍完成 SUBSCRIBED 状态处理', () => {
    state.previousStatus = 'TIMED_OUT';
    state.consecutiveErrors = 2;
    vi.mocked(logger.info).mockImplementation(() => {
      throw new Error('logger failed');
    });

    expect(() => {
      controller.handleSubscribeStatus('SUBSCRIBED', undefined, state, runtime);
    }).not.toThrow();

    expect(circuit.clearBackoff).toHaveBeenCalledWith('project-1');
    expect(circuit.clearCircuit).toHaveBeenCalled();
    expect(runtime.triggerRealtimeReconnectChange).toHaveBeenCalledWith('project-1');
    expect(state.consecutiveErrors).toBe(0);
    expect(state.previousStatus).toBe('SUBSCRIBED');
  });

  it('状态归属判定失败时不应打穿订阅状态回调', () => {
    const stateError = new Error('state guard failed');
    vi.mocked(runtime.isStateCurrent).mockImplementation(() => {
      throw stateError;
    });

    expect(() => {
      controller.handleSubscribeStatus('SUBSCRIBED', undefined, state, runtime);
    }).not.toThrow();

    expect(circuit.clearBackoff).not.toHaveBeenCalled();
    expect(runtime.triggerRealtimeReconnectChange).not.toHaveBeenCalled();
    expect(state.previousStatus).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith('Realtime 订阅状态归属判定失败，已忽略本次状态', stateError);
  });

  it('订阅成功时熔断清理失败不应阻断状态更新和重连同步', () => {
    const clearError = new Error('circuit clear failed');
    state.previousStatus = 'TIMED_OUT';
    state.consecutiveErrors = 2;
    vi.mocked(circuit.clearBackoff).mockImplementation(() => {
      throw clearError;
    });
    vi.mocked(circuit.clearCircuit).mockImplementation(() => {
      throw clearError;
    });

    expect(() => {
      controller.handleSubscribeStatus('SUBSCRIBED', undefined, state, runtime);
    }).not.toThrow();

    expect(circuit.clearBackoff).toHaveBeenCalledWith('project-1');
    expect(circuit.clearCircuit).toHaveBeenCalled();
    expect(runtime.triggerRealtimeReconnectChange).toHaveBeenCalledWith('project-1');
    expect(state.consecutiveErrors).toBe(0);
    expect(state.previousStatus).toBe('SUBSCRIBED');
    expect(logger.warn).toHaveBeenCalledWith('Realtime 熔断退避清理失败', clearError);
    expect(logger.warn).toHaveBeenCalledWith('Realtime 熔断状态清理失败', clearError);
  });

  it('重连增量同步触发失败时仍完成订阅状态更新', () => {
    const reconnectError = new Error('reconnect sync failed');
    state.previousStatus = 'TIMED_OUT';
    state.consecutiveErrors = 2;
    vi.mocked(runtime.triggerRealtimeReconnectChange).mockImplementation(() => {
      throw reconnectError;
    });

    expect(() => {
      controller.handleSubscribeStatus('SUBSCRIBED', undefined, state, runtime);
    }).not.toThrow();

    expect(circuit.clearBackoff).toHaveBeenCalledWith('project-1');
    expect(circuit.clearCircuit).toHaveBeenCalled();
    expect(runtime.triggerRealtimeReconnectChange).toHaveBeenCalledWith('project-1');
    expect(logger.warn).toHaveBeenCalledWith('Realtime 重连后增量同步触发失败', reconnectError);
    expect(state.consecutiveErrors).toBe(0);
    expect(state.previousStatus).toBe('SUBSCRIBED');
  });

  it('重连增量同步失败且告警日志失败时仍完成订阅状态更新', () => {
    state.previousStatus = 'TIMED_OUT';
    state.consecutiveErrors = 2;
    vi.mocked(runtime.triggerRealtimeReconnectChange).mockImplementation(() => {
      throw new Error('reconnect sync failed');
    });
    vi.mocked(logger.warn).mockImplementation(() => {
      throw new Error('logger failed');
    });

    expect(() => {
      controller.handleSubscribeStatus('SUBSCRIBED', undefined, state, runtime);
    }).not.toThrow();

    expect(circuit.clearBackoff).toHaveBeenCalledWith('project-1');
    expect(circuit.clearCircuit).toHaveBeenCalled();
    expect(runtime.triggerRealtimeReconnectChange).toHaveBeenCalledWith('project-1');
    expect(logger.warn).toHaveBeenCalledWith(
      'Realtime 重连后增量同步触发失败',
      expect.any(Error),
    );
    expect(state.consecutiveErrors).toBe(0);
    expect(state.previousStatus).toBe('SUBSCRIBED');
  });

  it('Realtime 已禁用时忽略通道错误，不记录降级事件', () => {
    vi.mocked(runtime.isRealtimeEnabled).mockReturnValue(false);

    controller.handleSubscribeStatus('CHANNEL_ERROR', { message: 'disabled' }, state, runtime);

    expect(sentry.addBreadcrumb).not.toHaveBeenCalled();
    expect(circuit.armCircuit).not.toHaveBeenCalled();
    expect(runtime.fallbackToPolling).not.toHaveBeenCalled();
    expect(state.previousStatus).toBe('CHANNEL_ERROR');
  });
});
