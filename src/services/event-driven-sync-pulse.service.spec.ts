import { DestroyRef, Injector, runInInjectionContext, signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventDrivenSyncPulseService } from './event-driven-sync-pulse.service';
import { SyncResumeCoordinatorService } from '../app/core/services/sync/sync-resume-coordinator.service';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { AuthService } from './auth.service';
import { NetworkAwarenessService } from './network-awareness.service';
import { AppLifecycleOrchestratorService } from './app-lifecycle-orchestrator.service';
import { SessionManagerService } from '../app/core/services/sync/session-manager.service';
import { STARTUP_PERF_CONFIG } from '../config/startup-performance.config';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { APP_LIFECYCLE_CONFIG } from '../config/app-lifecycle.config';

describe('EventDrivenSyncPulseService', () => {
  let service: EventDrivenSyncPulseService;
  let recoverAfterResume: ReturnType<typeof vi.fn>;
  let addBreadcrumb: ReturnType<typeof vi.fn>;
  let captureException: ReturnType<typeof vi.fn>;
  let loggerInfo: ReturnType<typeof vi.fn>;
  let loggerWarn: ReturnType<typeof vi.fn>;
  let visibilityStateValue: DocumentVisibilityState;
  let appLifecycleMock: {
    isResuming: ReturnType<typeof vi.fn>;
    isHeavyRecoveryInCooldown: ReturnType<typeof vi.fn>;
    lastHeavyRecoveryAt: ReturnType<typeof vi.fn>;
    getCurrentRecoveryTicket: ReturnType<typeof vi.fn>;
    isRecoveryCompensationInFlight: ReturnType<typeof vi.fn>;
  };
  let sessionManagerMock: {
    getRecentValidationSnapshot: ReturnType<typeof vi.fn>;
  };
  let heartbeatIntervalMs: number;
  let mathRandomSpy: ReturnType<typeof vi.spyOn> | null = null;
  let injector: Injector;
  let injectorDestroyed = false;
  const originalResumeInteractionFirst = FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1;
  const originalPulseDedup = FEATURE_FLAGS.RESUME_PULSE_DEDUP_V1;
  const originalRecoveryTicketDedup = FEATURE_FLAGS.RECOVERY_TICKET_DEDUP_V1;
  const originalHeartbeatInterval = STARTUP_PERF_CONFIG.SYNC_HEARTBEAT_VISIBLE_INTERVAL_MS;

  const destroyCallbacks: Array<() => void> = [];
  const mockDestroyRef: Pick<DestroyRef, 'onDestroy'> = {
    onDestroy: (cb: () => void) => {
      destroyCallbacks.push(cb);
      return () => {};
    },
  };
  function destroyEventDrivenSyncPulseService(): void {
    if (!injectorDestroyed) {
      (injector as { destroy?: () => void }).destroy?.();
      injectorDestroyed = true;
    }
    for (const callback of destroyCallbacks.splice(0)) {
      callback();
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    injectorDestroyed = false;
    destroyCallbacks.length = 0;
    visibilityStateValue = 'visible';
    heartbeatIntervalMs = 20;
    (STARTUP_PERF_CONFIG as unknown as { SYNC_HEARTBEAT_VISIBLE_INTERVAL_MS: number })
      .SYNC_HEARTBEAT_VISIBLE_INTERVAL_MS = heartbeatIntervalMs;
    mathRandomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibilityStateValue,
    });

    recoverAfterResume = vi.fn().mockResolvedValue(undefined);
    addBreadcrumb = vi.fn();
    captureException = vi.fn();
    loggerInfo = vi.fn();
    loggerWarn = vi.fn();
    appLifecycleMock = {
      isResuming: vi.fn(() => false),
      isHeavyRecoveryInCooldown: vi.fn(() => false),
      lastHeavyRecoveryAt: vi.fn(() => null),
      getCurrentRecoveryTicket: vi.fn(() => null),
      isRecoveryCompensationInFlight: vi.fn(() => false),
    };
    sessionManagerMock = {
      getRecentValidationSnapshot: vi.fn().mockReturnValue(null),
    };

    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_INTERACTION_FIRST_V1 = originalResumeInteractionFirst;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_PULSE_DEDUP_V1 = originalPulseDedup;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RECOVERY_TICKET_DEDUP_V1 = originalRecoveryTicketDedup;

    const onlineSignal = signal(true);
    const userIdSignal = signal<string | null>('user-1');

    injector = Injector.create({
      providers: [
        { provide: EventDrivenSyncPulseService, useClass: EventDrivenSyncPulseService },
        { provide: SyncResumeCoordinatorService, useValue: { recoverAfterResume } },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              info: loggerInfo,
              warn: loggerWarn,
              error: vi.fn(),
              debug: vi.fn(),
            }),
          },
        },
        { provide: SentryLazyLoaderService, useValue: { addBreadcrumb, captureException } },
        { provide: AuthService, useValue: { currentUserId: userIdSignal } },
        { provide: NetworkAwarenessService, useValue: { isOnline: onlineSignal } },
        { provide: AppLifecycleOrchestratorService, useValue: appLifecycleMock },
        { provide: SessionManagerService, useValue: sessionManagerMock },
        { provide: DestroyRef, useValue: mockDestroyRef },
      ],
    });

    service = runInInjectionContext(injector, () => injector.get(EventDrivenSyncPulseService));
  });

  afterEach(() => {
    destroyEventDrivenSyncPulseService();
    if (typeof vi.clearAllTimers === 'function') {
      vi.clearAllTimers();
    }
    vi.useRealTimers();
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_INTERACTION_FIRST_V1 = originalResumeInteractionFirst;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_PULSE_DEDUP_V1 = originalPulseDedup;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RECOVERY_TICKET_DEDUP_V1 = originalRecoveryTicketDedup;
    (STARTUP_PERF_CONFIG as unknown as { SYNC_HEARTBEAT_VISIBLE_INTERVAL_MS: number })
      .SYNC_HEARTBEAT_VISIBLE_INTERVAL_MS = originalHeartbeatInterval;
    mathRandomSpy?.mockRestore();
    mathRandomSpy = null;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  it('focus 事件应触发同步脉冲', async () => {
    service.initialize();

    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    await Promise.resolve();

    expect(recoverAfterResume).toHaveBeenCalledTimes(1);
    expect(recoverAfterResume).toHaveBeenCalledWith(
      'pulse:focus',
      expect.objectContaining({
        mode: 'light',
        allowRemoteProbe: false,
      })
    );
  });

  it('initialize 失败时应回滚已注册 listener，避免半初始化事件触发', async () => {
    const addDocumentListenerSpy = vi.spyOn(document, 'addEventListener');
    addDocumentListenerSpy.mockImplementationOnce(() => {
      throw new Error('listener failed');
    });

    expect(() => service.initialize()).toThrow('listener failed');

    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    await Promise.resolve();

    expect(recoverAfterResume).not.toHaveBeenCalled();
  });

  it('初始化成功日志失败不应回滚已注册 listener', async () => {
    loggerInfo.mockImplementationOnce(() => {
      throw new Error('logger failed');
    });

    expect(() => service.initialize()).not.toThrow();

    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    await Promise.resolve();

    expect(recoverAfterResume).toHaveBeenCalledTimes(1);
    expect(recoverAfterResume).toHaveBeenCalledWith(
      'pulse:focus',
      expect.objectContaining({
        mode: 'light',
        allowRemoteProbe: false,
      })
    );
  });

  it('应在 cooldown 窗口内抑制重复触发', async () => {
    await service.triggerNow('manual');
    await service.triggerNow('manual');

    expect(recoverAfterResume).toHaveBeenCalledTimes(1);
    expect(addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      message: 'sync.pulse.skipped.cooldown',
    }));
  });

  it('应支持 single-flight 复用并只发起一次请求', async () => {
    let resolvePull: (() => void) | null = null;
    recoverAfterResume.mockImplementation(() => new Promise<void>((resolve) => {
      resolvePull = resolve;
    }));

    const p1 = service.triggerNow('manual');
    const p2 = service.triggerNow('manual');
    expect(recoverAfterResume).toHaveBeenCalledTimes(1);

    resolvePull!();
    await Promise.all([p1, p2]);
  });

  it('single-flight 合并期间应显式记录后续触发原因', async () => {
    let resolvePull: (() => void) | null = null;
    recoverAfterResume.mockImplementation(() => new Promise<void>((resolve) => {
      resolvePull = resolve;
    }));
    const pulseEvents: Array<{ status?: string; reason?: string; skipReason?: string }> = [];
    const listener = (event: Event) => {
      pulseEvents.push((event as CustomEvent<{ status?: string; reason?: string; skipReason?: string }>).detail);
    };
    window.addEventListener('nanoflow:sync-pulse', listener);

    const firstPulse = service.triggerNow('manual');
    let mergedResult: Awaited<ReturnType<EventDrivenSyncPulseService['triggerNow']>> | undefined;
    void service.triggerNow('online').then((result) => {
      mergedResult = result;
    });
    await Promise.resolve();

    expect(mergedResult).toEqual({ status: 'skipped', skipReason: 'in-flight' });
    resolvePull!();
    await expect(firstPulse).resolves.toEqual({ status: 'success' });
    window.removeEventListener('nanoflow:sync-pulse', listener);

    expect(recoverAfterResume).toHaveBeenCalledTimes(1);
    expect(pulseEvents).toEqual([
      expect.objectContaining({ status: 'triggered', reason: 'manual' }),
      expect.objectContaining({ status: 'skipped', reason: 'online', skipReason: 'in-flight' }),
      expect.objectContaining({ status: 'success', reason: 'manual' }),
    ]);
    expect(addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      message: 'sync.pulse.skipped.in-flight',
      data: expect.objectContaining({
        reason: 'online',
        skipReason: 'in-flight',
      }),
    }));
  });

  it('breadcrumb 记录失败不应阻断同步脉冲执行', async () => {
    addBreadcrumb.mockImplementationOnce(() => {
      throw new Error('breadcrumb failed');
    });

    const result = await service.triggerNow('manual');

    expect(result).toEqual({ status: 'success' });
    expect(recoverAfterResume).toHaveBeenCalledTimes(1);
  });

  it('事件派发失败不应把已完成的同步脉冲标记为失败', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
      .mockImplementationOnce(() => {
        throw new Error('dispatch failed');
      });

    const result = await service.triggerNow('manual');

    expect(result).toEqual({ status: 'success' });
    expect(recoverAfterResume).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalled();
  });

  it('事件派发失败且日志记录失败时仍不应把同步脉冲标记为失败', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
      .mockImplementationOnce(() => {
        throw new Error('dispatch failed');
      });
    loggerWarn.mockImplementationOnce(() => {
      throw new Error('logger failed');
    });

    const result = await service.triggerNow('manual');

    expect(result).toEqual({ status: 'success' });
    expect(recoverAfterResume).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalled();
  });

  it('同步脉冲失败且异常上报失败时仍应返回 failed', async () => {
    const recoverError = new Error('recover failed');
    const captureError = new Error('capture failed');
    recoverAfterResume.mockRejectedValueOnce(recoverError);
    captureException.mockImplementationOnce(() => {
      throw captureError;
    });

    const result = await service.triggerNow('manual');

    expect(result).toEqual({ status: 'failed' });
    expect(loggerWarn).toHaveBeenCalledWith('同步脉冲执行失败', {
      reason: 'manual',
      error: recoverError,
    });
    expect(loggerWarn).toHaveBeenCalledWith('同步脉冲异常上报失败', {
      reason: 'manual',
      error: captureError,
    });
  });

  it('心跳仅在可见窗口触发', async () => {
    service.initialize();

    visibilityStateValue = 'hidden';
    await vi.advanceTimersByTimeAsync(heartbeatIntervalMs);
    expect(recoverAfterResume).not.toHaveBeenCalled();

    visibilityStateValue = 'visible';
    await vi.advanceTimersByTimeAsync(heartbeatIntervalMs);
    expect(recoverAfterResume).toHaveBeenCalledTimes(1);
    expect(recoverAfterResume).toHaveBeenCalledWith(
      'pulse:heartbeat',
      expect.objectContaining({
        mode: 'light',
        allowRemoteProbe: false,
      })
    );
  });

  it('hidden 状态初始化时不应启动 heartbeat timer，恢复可见后再启动', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    visibilityStateValue = 'hidden';
    service.initialize();

    expect(setIntervalSpy).not.toHaveBeenCalled();

    visibilityStateValue = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(heartbeatIntervalMs);

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(recoverAfterResume).toHaveBeenCalledTimes(1);
    expect(recoverAfterResume).toHaveBeenCalledWith(
      'pulse:visible',
      expect.objectContaining({
        mode: 'light',
        allowRemoteProbe: false,
      })
    );
  });

  it('heartbeat interval handle 为 0 时仍视为活跃并可停止', () => {
    const heartbeatTimer = 0 as unknown as ReturnType<typeof setInterval>;
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(() => heartbeatTimer);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    const control = service as unknown as {
      startHeartbeat(): void;
      stopHeartbeat(): void;
    };

    control.startHeartbeat();
    control.startHeartbeat();
    control.stopHeartbeat();

    expect(setIntervalSpy).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledWith(0);
  });

  it('ignores a stale heartbeat interval tick after heartbeat restarts', async () => {
    const queuedIntervals = new Map<number, () => void>();
    let nextIntervalId = 1;
    vi.spyOn(globalThis, 'setInterval').mockImplementation((callback: TimerHandler) => {
      const intervalId = nextIntervalId++;
      queuedIntervals.set(intervalId, callback as () => void);
      return intervalId as unknown as ReturnType<typeof setInterval>;
    });
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    const control = service as unknown as {
      startHeartbeat(): void;
      stopHeartbeat(): void;
    };

    control.startHeartbeat();
    control.stopHeartbeat();
    control.startHeartbeat();
    queuedIntervals.get(1)?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(recoverAfterResume).not.toHaveBeenCalled();

    control.stopHeartbeat();
    expect(clearIntervalSpy).toHaveBeenCalledWith(1);
    expect(clearIntervalSpy).toHaveBeenCalledWith(2);
  });

  it('heavy 恢复后的抑制窗口内应跳过 pulse', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_PULSE_DEDUP_V1 = true;
    appLifecycleMock.isHeavyRecoveryInCooldown.mockReturnValue(true);

    await service.triggerNow('focus');

    expect(appLifecycleMock.isHeavyRecoveryInCooldown).toHaveBeenCalledWith(
      APP_LIFECYCLE_CONFIG.PULSE_SUPPRESS_AFTER_HEAVY_MS
    );
    expect(recoverAfterResume).not.toHaveBeenCalled();
    expect(addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      message: 'sync.pulse.skipped.post-heavy-cooldown',
    }));
  });

  it('heavy 冷却内 visible/focus/online 连续触发仍应全部抑制', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_PULSE_DEDUP_V1 = true;
    appLifecycleMock.isHeavyRecoveryInCooldown.mockReturnValue(true);
    service.initialize();

    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    await Promise.resolve();

    expect(recoverAfterResume).not.toHaveBeenCalled();
    expect(addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      message: 'sync.pulse.skipped.post-heavy-cooldown',
    }));
  });

  it('存在 lifecycle recovery ticket 时应跳过 pulse 恢复', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_INTERACTION_FIRST_V1 = true;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RECOVERY_TICKET_DEDUP_V1 = true;
    appLifecycleMock.getCurrentRecoveryTicket.mockReturnValue({
      id: 'ticket-1',
      startedAt: Date.now(),
      mode: 'heavy',
    });

    await service.triggerNow('manual');

    expect(recoverAfterResume).not.toHaveBeenCalled();
    expect(addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      message: 'sync.pulse.skipped.same-ticket',
    }));
  });

  it('pulse 执行中出现 lifecycle recovery ticket 时应跳过恢复', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_INTERACTION_FIRST_V1 = true;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RECOVERY_TICKET_DEDUP_V1 = true;
    appLifecycleMock.getCurrentRecoveryTicket
      .mockReturnValueOnce(null)
      .mockReturnValue({
        id: 'ticket-mid-flight',
        startedAt: Date.now(),
        mode: 'heavy',
      });
    sessionManagerMock.getRecentValidationSnapshot.mockImplementationOnce(() => ({
      valid: true,
      userId: 'user-1',
    }));

    const result = await service.triggerNow('manual');

    expect(result).toEqual({ status: 'skipped', skipReason: 'same-ticket' });
    expect(recoverAfterResume).not.toHaveBeenCalled();
    expect(addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      message: 'sync.pulse.skipped.same-ticket',
    }));
  });

  it('pulse 执行中因 recovery ticket 跳过时不应污染后续 cooldown', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_INTERACTION_FIRST_V1 = true;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RECOVERY_TICKET_DEDUP_V1 = true;
    vi.setSystemTime(1_000);
    appLifecycleMock.getCurrentRecoveryTicket
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({
        id: 'ticket-mid-flight',
        startedAt: Date.now(),
        mode: 'heavy',
      })
      .mockReturnValue(null);

    const skipped = await service.triggerNow('manual');
    vi.setSystemTime(1_001);
    const recovered = await service.triggerNow('manual');

    expect(skipped).toEqual({ status: 'skipped', skipReason: 'same-ticket' });
    expect(recovered).toEqual({ status: 'success' });
    expect(recoverAfterResume).toHaveBeenCalledTimes(1);
  });

  it('compensation 进行中时应抑制 pulse', async () => {
    appLifecycleMock.isRecoveryCompensationInFlight.mockReturnValue(true);

    await service.triggerNow('manual');

    expect(recoverAfterResume).not.toHaveBeenCalled();
    expect(addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      message: 'sync.pulse.skipped.compensating',
    }));
  });

  it('状态读取失败时应跳过 pulse 而不是让触发 promise reject', async () => {
    const readinessError = new Error('online status unavailable');
    const onlineSignal = () => {
      throw readinessError;
    };
    injector = Injector.create({
      providers: [
        { provide: EventDrivenSyncPulseService, useClass: EventDrivenSyncPulseService },
        { provide: SyncResumeCoordinatorService, useValue: { recoverAfterResume } },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              info: loggerInfo,
              warn: loggerWarn,
              error: vi.fn(),
              debug: vi.fn(),
            }),
          },
        },
        { provide: SentryLazyLoaderService, useValue: { addBreadcrumb, captureException } },
        { provide: AuthService, useValue: { currentUserId: signal<string | null>('user-1') } },
        { provide: NetworkAwarenessService, useValue: { isOnline: onlineSignal } },
        { provide: AppLifecycleOrchestratorService, useValue: appLifecycleMock },
        { provide: SessionManagerService, useValue: sessionManagerMock },
        { provide: DestroyRef, useValue: mockDestroyRef },
      ],
    });
    service = runInInjectionContext(injector, () => injector.get(EventDrivenSyncPulseService));

    await expect(service.triggerNow('manual')).resolves.toEqual({
      status: 'skipped',
      skipReason: 'disabled',
    });

    expect(recoverAfterResume).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledWith('同步脉冲状态检查失败，已跳过本次脉冲', {
      reason: 'manual',
      error: readinessError,
    });
    expect(addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      message: 'sync.pulse.skipped.disabled',
    }));
  });

  it('destroy 应移除事件监听并停止 heartbeat timer', async () => {
    const windowRemoveSpy = vi.spyOn(window, 'removeEventListener');
    const documentRemoveSpy = vi.spyOn(document, 'removeEventListener');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    service.initialize();
    service.destroy();

    expect(windowRemoveSpy).toHaveBeenCalledWith('focus', expect.any(Function));
    expect(windowRemoveSpy).toHaveBeenCalledWith('pageshow', expect.any(Function));
    expect(windowRemoveSpy).toHaveBeenCalledWith('online', expect.any(Function));
    expect(documentRemoveSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(clearIntervalSpy).toHaveBeenCalled();

    const pageshow = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(pageshow, 'persisted', { value: true });

    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(pageshow);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(heartbeatIntervalMs * 3);
    await Promise.resolve();
    await Promise.resolve();

    expect(recoverAfterResume).not.toHaveBeenCalled();
  });

  it('destroy 在单个监听器清理失败时仍应继续清理剩余监听器', async () => {
    service.initialize();

    const originalRemoveEventListener = document.removeEventListener.bind(document);
    let visibilityRemoveCount = 0;
    const documentRemoveSpy = vi.spyOn(document, 'removeEventListener').mockImplementation(
      function(
        this: Document,
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
      ) {
        const result = originalRemoveEventListener(type, listener, options);
        if (type === 'visibilitychange' && visibilityRemoveCount++ === 0) {
          throw new Error('visibility cleanup failed');
        }
        return result;
      }
    );
    const loggerWarnSpy = loggerWarn;

    expect(() => service.destroy()).not.toThrow();

    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    const pageshow = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(pageshow, 'persisted', { value: true });
    window.dispatchEvent(pageshow);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(heartbeatIntervalMs * 3);
    await Promise.resolve();
    await Promise.resolve();

    expect(recoverAfterResume).not.toHaveBeenCalled();
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      '事件驱动同步脉冲监听器清理失败',
      expect.objectContaining({
        listener: 'visibilitychange',
        error: expect.any(Error),
      })
    );

    documentRemoveSpy.mockRestore();
    service.destroy();
  });

  it('destroy 在监听器清理日志失败时仍应继续清理剩余监听器', async () => {
    service.initialize();

    const originalRemoveEventListener = document.removeEventListener.bind(document);
    let visibilityRemoveCount = 0;
    const documentRemoveSpy = vi.spyOn(document, 'removeEventListener').mockImplementation(
      function(
        this: Document,
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions
      ) {
        const result = originalRemoveEventListener(type, listener, options);
        if (type === 'visibilitychange' && visibilityRemoveCount++ === 0) {
          throw new Error('visibility cleanup failed');
        }
        return result;
      }
    );
    loggerWarn.mockImplementationOnce(() => {
      throw new Error('logger failed');
    });

    try {
      expect(() => service.destroy()).not.toThrow();

      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
      const pageshow = new Event('pageshow') as PageTransitionEvent;
      Object.defineProperty(pageshow, 'persisted', { value: true });
      window.dispatchEvent(pageshow);
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(heartbeatIntervalMs * 3);
      await Promise.resolve();
      await Promise.resolve();

      expect(recoverAfterResume).not.toHaveBeenCalled();
      expect(loggerWarn).toHaveBeenCalledWith(
        '事件驱动同步脉冲监听器清理失败',
        expect.objectContaining({
          listener: 'visibilitychange',
          error: expect.any(Error),
        })
      );
    } finally {
      documentRemoveSpy.mockRestore();
    }
  });

  it('destroy 后应清空 cooldown，避免新会话复用旧脉冲时间', async () => {
    await service.triggerNow('manual');

    service.destroy();

    await service.triggerNow('manual');

    expect(recoverAfterResume).toHaveBeenCalledTimes(2);
  });

  it('DestroyRef 销毁后晚到 trigger 不应重新发起同步恢复', async () => {
    destroyEventDrivenSyncPulseService();

    const result = await service.triggerNow('manual');

    expect(result).toEqual({ status: 'skipped', skipReason: 'disabled' });
    expect(recoverAfterResume).not.toHaveBeenCalled();
  });

  it('destroy 期间仍有在途 pulse 时不应并发启动第二次恢复', async () => {
    let resolveRecovery: (() => void) | null = null;
    recoverAfterResume.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveRecovery = resolve;
    }));

    const firstPulse = service.triggerNow('manual');
    await Promise.resolve();

    service.destroy();
    const secondPulse = service.triggerNow('online');
    await Promise.resolve();

    expect(recoverAfterResume).toHaveBeenCalledTimes(1);
    await expect(secondPulse).resolves.toEqual({ status: 'skipped', skipReason: 'in-flight' });

    const resolveRecoveryFn = resolveRecovery as (() => void) | null;
    resolveRecoveryFn?.();
    await expect(firstPulse).resolves.toEqual({ status: 'skipped', skipReason: 'disabled' });
  });

  it('destroy 后应丢弃在途 pulse 的迟到成功副作用', async () => {
    let resolveRecovery: (() => void) | null = null;
    recoverAfterResume.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveRecovery = resolve;
    }));

    const pulseEvents: Array<{ status?: string; reason?: string }> = [];
    const listener = (event: Event) => {
      pulseEvents.push((event as CustomEvent<{ status?: string; reason?: string }>).detail);
    };
    window.addEventListener('nanoflow:sync-pulse', listener);

    const pulsePromise = service.triggerNow('manual');
    await Promise.resolve();
    service.destroy();
    const resolveRecoveryFn = resolveRecovery as (() => void) | null;
    resolveRecoveryFn?.();
    await pulsePromise;
    await Promise.resolve();

    window.removeEventListener('nanoflow:sync-pulse', listener);

    expect(pulseEvents).toEqual([
      expect.objectContaining({ status: 'triggered', reason: 'manual' }),
    ]);
    expect(addBreadcrumb).not.toHaveBeenCalledWith(expect.objectContaining({
      message: 'sync.pulse.success',
    }));
  });
});
