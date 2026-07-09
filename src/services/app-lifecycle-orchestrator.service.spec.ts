import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { AppLifecycleOrchestratorService } from './app-lifecycle-orchestrator.service';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { ToastService } from './toast.service';
import { NetworkAwarenessService } from './network-awareness.service';
import { RealtimePollingService } from '../app/core/services/sync/realtime-polling.service';
import { SyncResumeCoordinatorService } from '../app/core/services/sync/sync-resume-coordinator.service';
import { SessionManagerService } from '../app/core/services/sync/session-manager.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { APP_LIFECYCLE_CONFIG } from '../config';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { FocusStartupProbeService } from './focus-startup-probe.service';
import { SwUpdate } from '@angular/service-worker';
import { SyncStateService } from '../app/core/services/sync/sync-state.service';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../utils/browser-network-suspension';
import { flushResumeWithoutDrainingLongTimers, installRequestIdleCallbackMock, restoreWindowProperty, setVisibilityState } from './app-lifecycle-orchestrator.test-harness';
import { registerAppLifecycleOrchestratorExtraSpecs } from './app-lifecycle-orchestrator-extra-specs.spec-helpers';
import { registerAppLifecyclePendingPersistSpecs } from './app-lifecycle-orchestrator-pending-persist.spec-helpers';
import { registerAppLifecycleResumeQueueSpecs } from './app-lifecycle-orchestrator-resume-queue.spec-helpers';

const reloadViaForceClearCacheMock = vi.fn();
vi.mock('../utils/force-clear-cache', () => ({
  reloadViaForceClearCache: (fallback?: () => void) => reloadViaForceClearCacheMock(fallback),
}));

describe('AppLifecycleOrchestratorService', () => {
  let service: AppLifecycleOrchestratorService;
  let mockNetwork: { refresh: ReturnType<typeof vi.fn> };
  let mockSessionManager: {
    validateOrRefreshOnResume: ReturnType<typeof vi.fn>;
    getRecentValidationSnapshot: ReturnType<typeof vi.fn>;
  };
  let mockSimpleSync: {
    recoverAfterResume: ReturnType<typeof vi.fn>;
    suspendTransport: ReturnType<typeof vi.fn>;
    cancelPendingBackgroundRecovery: ReturnType<typeof vi.fn>;
  };
  let mockFocusStartupProbe: {
    recheckGate: ReturnType<typeof vi.fn>;
    hasPendingGateWork: ReturnType<typeof vi.fn>;
  };
  let mockSyncCoordinator: {
    hasPendingLocalChanges: ReturnType<typeof vi.fn>;
    flushPendingPersistToCloud: ReturnType<typeof vi.fn>;
    refreshBlackBoxWatermarkIfNeeded: ReturnType<typeof vi.fn>;
  };
  let mockSyncState: {
    setCloudSyncPausedReason: ReturnType<typeof vi.fn>;
    clearCloudSyncPausedReason: ReturnType<typeof vi.fn>;
  };
  let mockToast: {
    info: ReturnType<typeof vi.fn>;
    warning: ReturnType<typeof vi.fn>;
  };
  let mockSentry: {
    addBreadcrumb: ReturnType<typeof vi.fn>;
    setMeasurement: ReturnType<typeof vi.fn>;
    captureException: ReturnType<typeof vi.fn>;
    captureMessage: ReturnType<typeof vi.fn>;
  };
  let mockLoggerCategory: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
  let originalRequestIdleCallbackDescriptor: PropertyDescriptor | undefined;
  let originalMatchMediaDescriptor: PropertyDescriptor | undefined;
  const originalResumeInteractionFirst = FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1;
  const originalPulseDedup = FEATURE_FLAGS.RESUME_PULSE_DEDUP_V1;

  beforeEach(() => {
    resetBrowserNetworkSuspensionTrackingForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-14T00:00:00.000Z'));
    setVisibilityState('visible');
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('nanoflow.lifecycle.auto-reload');
    }
    originalRequestIdleCallbackDescriptor = Object.getOwnPropertyDescriptor(window, 'requestIdleCallback');
    originalMatchMediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    installRequestIdleCallbackMock();
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_INTERACTION_FIRST_V1 = originalResumeInteractionFirst;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_PULSE_DEDUP_V1 = originalPulseDedup;

    mockNetwork = {
      refresh: vi.fn(),
    };

    mockSessionManager = {
      getRecentValidationSnapshot: vi.fn().mockReturnValue(null),
      validateOrRefreshOnResume: vi.fn().mockResolvedValue({
        ok: true,
        refreshed: false,
        deferred: false,
      }),
    };

    mockSimpleSync = {
      recoverAfterResume: vi.fn().mockResolvedValue(undefined),
      suspendTransport: vi.fn().mockResolvedValue(undefined),
      cancelPendingBackgroundRecovery: vi.fn(),
    };

    mockFocusStartupProbe = {
      recheckGate: vi.fn().mockResolvedValue(undefined),
      hasPendingGateWork: vi.fn().mockReturnValue(false),
    };

    mockSyncCoordinator = {
      hasPendingLocalChanges: vi.fn().mockReturnValue(false),
      flushPendingPersistToCloud: vi.fn().mockResolvedValue(false),
      refreshBlackBoxWatermarkIfNeeded: vi.fn().mockResolvedValue({ skipped: true }),
    };

    mockSyncState = {
      setCloudSyncPausedReason: vi.fn(),
      clearCloudSyncPausedReason: vi.fn(),
    };

    mockToast = {
      info: vi.fn(),
      warning: vi.fn(),
    };

    mockSentry = {
      addBreadcrumb: vi.fn(),
      setMeasurement: vi.fn(),
      captureException: vi.fn(),
      captureMessage: vi.fn(),
    };

    reloadViaForceClearCacheMock.mockClear();

    mockLoggerCategory = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        AppLifecycleOrchestratorService,
        { provide: NetworkAwarenessService, useValue: mockNetwork },
        { provide: SessionManagerService, useValue: mockSessionManager },
        { provide: RealtimePollingService, useValue: mockSimpleSync },
        { provide: SyncResumeCoordinatorService, useValue: mockSimpleSync },
        { provide: FocusStartupProbeService, useValue: mockFocusStartupProbe },
        { provide: SyncCoordinatorService, useValue: mockSyncCoordinator },
        { provide: SyncStateService, useValue: mockSyncState },
        { provide: ToastService, useValue: mockToast },
        // SwUpdate 由 angular/service-worker 提供；测试中默认 disabled，
        // 行为接近本地开发（即 activateUpdate 不会被调用）。
        { provide: SwUpdate, useValue: { isEnabled: false, activateUpdate: vi.fn() } },
        {
          provide: SentryLazyLoaderService,
          useValue: mockSentry,
        },
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn().mockReturnValue(mockLoggerCategory),
          },
        },
      ],
    });

    service = TestBed.inject(AppLifecycleOrchestratorService);
  });

  afterEach(() => {
    resetBrowserNetworkSuspensionTrackingForTests();
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_INTERACTION_FIRST_V1 = originalResumeInteractionFirst;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_PULSE_DEDUP_V1 = originalPulseDedup;
    TestBed.resetTestingModule();
    restoreWindowProperty('requestIdleCallback', originalRequestIdleCallbackDescriptor);
    restoreWindowProperty('matchMedia', originalMatchMediaDescriptor);
    setVisibilityState('visible');
    vi.useRealTimers();
  });

  registerAppLifecycleResumeQueueSpecs({
    service: () => service,
    simpleSync: () => mockSimpleSync,
  });

  it('should run heavy recovery when hidden duration exceeds threshold', async () => {
    service.initialize();

    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(mockSimpleSync.suspendTransport).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(Date.now() + APP_LIFECYCLE_CONFIG.RESUME_THRESHOLD_MS + 1));

    setVisibilityState('visible');
    document.dispatchEvent(new Event('visibilitychange'));

    await flushResumeWithoutDrainingLongTimers();

    expect(mockSessionManager.validateOrRefreshOnResume).toHaveBeenCalled();
    expect(mockSimpleSync.recoverAfterResume).toHaveBeenCalledTimes(2);
    const heavyCalls = mockSimpleSync.recoverAfterResume.mock.calls.filter(
      ([, options]) => options?.mode === 'heavy'
    );
    expect(heavyCalls).toHaveLength(1);
    expect(mockSyncCoordinator.refreshBlackBoxWatermarkIfNeeded).toHaveBeenCalledTimes(1);
  });

  it('hidden transition should contain suspendTransport rejection', async () => {
    const error = new Error('transport closed');
    mockSimpleSync.suspendTransport.mockRejectedValueOnce(error);

    try {
      service.initialize();
      setVisibilityState('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      await flushResumeWithoutDrainingLongTimers();
    } finally {
      setVisibilityState('visible');
      expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
        'Lifecycle transport suspension failed',
        expect.objectContaining({
          error,
        })
      );
    }
  });

  it('destroy cleanup 后应忽略已在途的 suspendTransport 失败', async () => {
    const error = new Error('late transport suspension failure');
    let rejectSuspend: ((error: unknown) => void) | null = null;
    mockSimpleSync.suspendTransport.mockReturnValueOnce(
      new Promise<void>((_, reject) => {
        rejectSuspend = reject;
      })
    );

    service.initialize();
    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(mockSimpleSync.suspendTransport).toHaveBeenCalledTimes(1);
    expect(rejectSuspend).toBeTypeOf('function');

    TestBed.resetTestingModule();

    rejectSuspend!(error);
    await flushResumeWithoutDrainingLongTimers();

    expect(mockLoggerCategory.warn).not.toHaveBeenCalled();
  });

  it('should only do lightweight checks for quick resume', async () => {
    await service.triggerResume('visibility-quick');

    expect(mockSessionManager.validateOrRefreshOnResume).toHaveBeenCalledTimes(1);
    expect(mockSimpleSync.recoverAfterResume).toHaveBeenCalledTimes(1);
    expect(mockSimpleSync.recoverAfterResume).toHaveBeenCalledWith('visibility-quick', expect.objectContaining({
      mode: 'light',
      allowRemoteProbe: false,
      sessionValidated: true,
      retryProcessing: 'background',
    }));
    expect(mockSyncCoordinator.refreshBlackBoxWatermarkIfNeeded).not.toHaveBeenCalled();
    expect(mockFocusStartupProbe.recheckGate).not.toHaveBeenCalled();
  });

  registerAppLifecyclePendingPersistSpecs({
    service: () => service,
    sessionManager: () => mockSessionManager,
    syncCoordinator: () => mockSyncCoordinator,
    sentry: () => mockSentry,
    logger: () => mockLoggerCategory,
  });

  it('应为恢复流程生成 ticket 并传递给 recoverAfterResume', async () => {
    const before = service.getCurrentRecoveryTicket();
    expect(before).toBeNull();

    await service.triggerResume('visibility-threshold');

    const calls = mockSimpleSync.recoverAfterResume.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [, options] of calls) {
      expect(options?.recoveryTicketId).toBeTypeOf('string');
    }
    expect(service.getCurrentRecoveryTicket()).toBeNull();
  });

  it('已有后台 heavy compensation 未完成时不应为新 ticket 再排一个 heavy compensation', async () => {
    let resolveFirstCompensation: (() => void) | null = null;
    mockSimpleSync.recoverAfterResume
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise<void>(resolve => {
        resolveFirstCompensation = resolve;
      }))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    await service.triggerResume('visibility-threshold');
    await flushResumeWithoutDrainingLongTimers();

    expect(resolveFirstCompensation).toBeTypeOf('function');
    expect(service.isRecoveryCompensationInFlight()).toBe(true);

    vi.setSystemTime(new Date(Date.now() + APP_LIFECYCLE_CONFIG.RESUME_HEAVY_COOLDOWN_MS + 1));

    await service.triggerResume('online');
    await flushResumeWithoutDrainingLongTimers();

    const heavyCompensationCalls = mockSimpleSync.recoverAfterResume.mock.calls.filter(
      ([, options]) => options?.mode === 'heavy' && options?.stage === 'compensation',
    );
    expect(heavyCompensationCalls).toHaveLength(1);

    resolveFirstCompensation!();
    await flushResumeWithoutDrainingLongTimers();
    expect(service.isRecoveryCompensationInFlight()).toBe(false);
  });

  it('destroy cleanup 后已排队的 heavy compensation 不应继续执行', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_INTERACTION_FIRST_V1 = true;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_PULSE_DEDUP_V1 = false;
    const idleCallbacks: IdleRequestCallback[] = [];
    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true,
      writable: true,
      value: vi.fn((callback: IdleRequestCallback) => {
        idleCallbacks.push(callback);
        return idleCallbacks.length;
      }),
    });

    await service.triggerResume('visibility-threshold');
    await Promise.resolve();
    expect(service.isRecoveryCompensationInFlight()).toBe(true);
    expect(idleCallbacks).toHaveLength(1);

    TestBed.resetTestingModule();
    idleCallbacks[0]?.({
      didTimeout: false,
      timeRemaining: () => 50,
    } as IdleDeadline);
    await flushResumeWithoutDrainingLongTimers();

    const heavyCompensationCalls = mockSimpleSync.recoverAfterResume.mock.calls.filter(
      ([, options]) => options?.mode === 'heavy' && options?.stage === 'compensation',
    );
    expect(heavyCompensationCalls).toHaveLength(0);
    expect(mockSyncCoordinator.refreshBlackBoxWatermarkIfNeeded).not.toHaveBeenCalled();
    expect(mockFocusStartupProbe.recheckGate).not.toHaveBeenCalledWith({
      source: 'resume-remote',
      reloadLocal: false,
    });
    expect(service.isRecoveryCompensationInFlight()).toBe(false);
  });

  it('heavy compensation 调度失败时应清理 in-flight 状态并记录异常', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_INTERACTION_FIRST_V1 = true;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_PULSE_DEDUP_V1 = false;
    const scheduleError = new Error('requestIdleCallback unavailable');
    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true,
      writable: true,
      value: vi.fn(() => {
        throw scheduleError;
      }),
    });

    await service.triggerResume('visibility-threshold');
    await flushResumeWithoutDrainingLongTimers();

    expect(service.isRecoveryCompensationInFlight()).toBe(false);
    expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
      'Resume background compensation scheduling failed',
      expect.objectContaining({
        reason: 'visibility-threshold',
        error: scheduleError,
      }),
    );
  });

  it('queueMicrotask 调度 heavy compensation 失败时应清理 in-flight 状态并记录异常', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_INTERACTION_FIRST_V1 = true;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_PULSE_DEDUP_V1 = false;
    const scheduleError = new Error('queueMicrotask unavailable');
    const originalQueueMicrotask = globalThis.queueMicrotask;
    globalThis.queueMicrotask = vi.fn(() => {
      throw scheduleError;
    }) as unknown as typeof queueMicrotask;

    try {
      await service.triggerResume('visibility-threshold');
      await flushResumeWithoutDrainingLongTimers();

      expect(service.isRecoveryCompensationInFlight()).toBe(false);
      expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
        'Resume background compensation scheduling failed',
        expect.objectContaining({
          reason: 'visibility-threshold',
          error: scheduleError,
        }),
      );
      const heavyCompensationCalls = mockSimpleSync.recoverAfterResume.mock.calls.filter(
        ([, options]) => options?.mode === 'heavy' && options?.stage === 'compensation',
      );
      expect(heavyCompensationCalls).toHaveLength(0);
    } finally {
      globalThis.queueMicrotask = originalQueueMicrotask;
    }
  });

  it('destroy cleanup 后迟到的 heavy compensation 调度失败不应记录 stale 异常', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_INTERACTION_FIRST_V1 = true;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_PULSE_DEDUP_V1 = false;
    const scheduleError = new Error('late requestIdleCallback failure after destroy');
    const queuedMicrotasks: Array<() => void> = [];
    const originalQueueMicrotask = globalThis.queueMicrotask;
    globalThis.queueMicrotask = vi.fn((callback: VoidFunction) => {
      queuedMicrotasks.push(callback);
    }) as unknown as typeof queueMicrotask;
    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true,
      writable: true,
      value: vi.fn(() => {
        throw scheduleError;
      }),
    });

    try {
      await service.triggerResume('visibility-threshold');

      expect(queuedMicrotasks).toHaveLength(1);
      expect(service.isRecoveryCompensationInFlight()).toBe(true);

      TestBed.resetTestingModule();
      queuedMicrotasks[0]?.();
      await flushResumeWithoutDrainingLongTimers();

      const staleSchedulingWarnings = mockLoggerCategory.warn.mock.calls.filter(
        ([message]) => message === 'Resume background compensation scheduling failed',
      );
      expect(staleSchedulingWarnings).toHaveLength(0);
      expect(service.isRecoveryCompensationInFlight()).toBe(false);
      const heavyCompensationCalls = mockSimpleSync.recoverAfterResume.mock.calls.filter(
        ([, options]) => options?.mode === 'heavy' && options?.stage === 'compensation',
      );
      expect(heavyCompensationCalls).toHaveLength(0);
    } finally {
      globalThis.queueMicrotask = originalQueueMicrotask;
    }
  });

  it('destroy cleanup 后已启动的 heavy compensation 不应继续执行后续副作用', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_INTERACTION_FIRST_V1 = true;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_PULSE_DEDUP_V1 = false;
    let resolveCompensation: (() => void) | null = null;
    mockSimpleSync.recoverAfterResume
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise<void>(resolve => {
        resolveCompensation = resolve;
      }));
    const lifecycleResumed = vi.fn();
    window.addEventListener('nanoflow:lifecycle-resumed', lifecycleResumed);

    try {
      await service.triggerResume('visibility-threshold');
      await flushResumeWithoutDrainingLongTimers();

      expect(resolveCompensation).toBeTypeOf('function');
      expect(service.isRecoveryCompensationInFlight()).toBe(true);

      TestBed.resetTestingModule();
      resolveCompensation!();
      await flushResumeWithoutDrainingLongTimers();

      expect(mockSyncCoordinator.refreshBlackBoxWatermarkIfNeeded).not.toHaveBeenCalled();
      expect(mockFocusStartupProbe.recheckGate).not.toHaveBeenCalledWith({
        source: 'resume-remote',
        reloadLocal: false,
      });
      expect(lifecycleResumed).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('nanoflow:lifecycle-resumed', lifecycleResumed);
    }
  });

  it('旧 heavy compensation 迟到完成时不应覆盖更新 resume 的恢复指标', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_INTERACTION_FIRST_V1 = true;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_PULSE_DEDUP_V1 = false;
    let resolveFirstCompensation: (() => void) | null = null;
    mockSimpleSync.recoverAfterResume
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise<void>(resolve => {
        resolveFirstCompensation = resolve;
      }))
      .mockResolvedValue(undefined);

    await service.triggerResume('visibility-threshold');
    await flushResumeWithoutDrainingLongTimers();

    expect(resolveFirstCompensation).toBeTypeOf('function');
    expect(service.isRecoveryCompensationInFlight()).toBe(true);
    const firstMetrics = service.getLastRecoveryMetrics();
    expect(firstMetrics?.reason).toBe('visibility-threshold');

    await service.triggerResume('online');
    await flushResumeWithoutDrainingLongTimers();

    const newerMetrics = service.getLastRecoveryMetrics();
    expect(newerMetrics?.reason).toBe('online');
    expect(newerMetrics?.ticketId).not.toBe(firstMetrics?.ticketId);

    resolveFirstCompensation!();
    await flushResumeWithoutDrainingLongTimers();

    expect(service.getLastRecoveryMetrics()?.ticketId).toBe(newerMetrics?.ticketId);
    expect(service.getLastRecoveryMetrics()?.reason).toBe('online');
    expect(service.isRecoveryCompensationInFlight()).toBe(false);
  });

  it('snapshot 命中时应跳过 validateOrRefreshOnResume', async () => {
    mockSessionManager.getRecentValidationSnapshot.mockReturnValue({
      valid: true,
      userId: 'user-1',
      at: Date.now(),
    });

    await service.triggerResume('visibility-threshold');
    await flushResumeWithoutDrainingLongTimers();

    expect(mockSessionManager.validateOrRefreshOnResume).not.toHaveBeenCalled();
  });

  it('应产出恢复指标快照（interaction + background）', async () => {
    await service.triggerResume('visibility-threshold');
    await flushResumeWithoutDrainingLongTimers();

    const metrics = service.getLastRecoveryMetrics();
    expect(metrics).toBeTruthy();
    expect(metrics?.ticketId).toBeTypeOf('string');
    expect(metrics?.interactionReadyMs).toBeGreaterThanOrEqual(0);
    expect(metrics?.backgroundRefreshMs).toBeGreaterThanOrEqual(0);
  });

  it('应优先使用高精度时钟计算 interactionReadyMs（避免同毫秒 0ms 抖动）', async () => {
    let clock = 1000;
    const perfNowSpy = vi.spyOn(performance, 'now').mockImplementation(() => {
      clock += 0.35;
      return clock;
    });

    try {
      await service.triggerResume('visibility-quick');
      await flushResumeWithoutDrainingLongTimers();

      const metrics = service.getLastRecoveryMetrics();
      expect(metrics).toBeTruthy();
      expect(metrics?.interactionReadyMs ?? 0).toBeGreaterThan(0);
    } finally {
      perfNowSpy.mockRestore();
    }
  });

  it('should ignore non-persisted pageshow events on cold startup', async () => {
    service.initialize();

    const pageshow = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(pageshow, 'persisted', { value: false });
    window.dispatchEvent(pageshow);
    await flushResumeWithoutDrainingLongTimers();

    expect(mockSessionManager.validateOrRefreshOnResume).not.toHaveBeenCalled();
    expect(mockSimpleSync.recoverAfterResume).not.toHaveBeenCalled();
  });

  it('should stop recovery without failure when session validation is deferred', async () => {
    mockSessionManager.validateOrRefreshOnResume.mockResolvedValueOnce({
      ok: false,
      refreshed: false,
      deferred: true,
      reason: 'client-unready',
    });
    mockSessionManager.validateOrRefreshOnResume.mockResolvedValueOnce({
      ok: true,
      refreshed: false,
      deferred: false,
    });

    await service.triggerResume('visibility-threshold');

    expect(mockSimpleSync.recoverAfterResume).not.toHaveBeenCalled();
    expect(mockSyncCoordinator.refreshBlackBoxWatermarkIfNeeded).not.toHaveBeenCalled();
    expect(mockToast.warning).not.toHaveBeenCalled();
    expect(service.isResuming()).toBe(false);

    await vi.runOnlyPendingTimersAsync();

    expect(mockSessionManager.validateOrRefreshOnResume).toHaveBeenCalledTimes(2);
    expect(mockSimpleSync.recoverAfterResume).toHaveBeenCalled();
  });

  it('no-session 恢复失败时应标记云同步暂停但保留本地可用状态，并在后续成功恢复后清空', async () => {
    mockSessionManager.validateOrRefreshOnResume.mockResolvedValueOnce({
      ok: false,
      refreshed: false,
      deferred: false,
      reason: 'no-session',
    });

    await service.triggerResume('online');

    expect(mockSyncState.setCloudSyncPausedReason).toHaveBeenCalledWith('no-session');
    expect(mockSimpleSync.recoverAfterResume).not.toHaveBeenCalled();

    mockSessionManager.validateOrRefreshOnResume.mockResolvedValueOnce({
      ok: true,
      refreshed: false,
      deferred: false,
    });

    await service.triggerResume('online');

    expect(mockSyncState.clearCloudSyncPausedReason).toHaveBeenCalled();
    expect(mockSimpleSync.recoverAfterResume).toHaveBeenCalled();
  });

  it('destroy cleanup 应移除全局监听并取消 deferred retry timer', async () => {
    mockSessionManager.validateOrRefreshOnResume.mockResolvedValue({
      ok: false,
      refreshed: false,
      deferred: true,
      reason: 'client-unready',
    });
    const documentRemoveSpy = vi.spyOn(document, 'removeEventListener');
    const windowRemoveSpy = vi.spyOn(window, 'removeEventListener');

    service.initialize();
    await service.triggerResume('visibility-threshold');

    expect(mockSessionManager.validateOrRefreshOnResume).toHaveBeenCalledTimes(1);

    TestBed.resetTestingModule();

    expect(documentRemoveSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(windowRemoveSpy).toHaveBeenCalledWith('blur', expect.any(Function));
    expect(windowRemoveSpy).toHaveBeenCalledWith('focus', expect.any(Function));
    expect(windowRemoveSpy).toHaveBeenCalledWith('pageshow', expect.any(Function));
    expect(windowRemoveSpy).toHaveBeenCalledWith('online', expect.any(Function));

    await vi.runOnlyPendingTimersAsync();
    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    setVisibilityState('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
    await flushResumeWithoutDrainingLongTimers();

    expect(mockSessionManager.validateOrRefreshOnResume).toHaveBeenCalledTimes(1);
    expect(mockSimpleSync.recoverAfterResume).not.toHaveBeenCalled();
  });

  it('hidden 状态下 online 不应抢跑 foreground 恢复', async () => {
    service.initialize();

    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1000);
    expect(mockSessionManager.validateOrRefreshOnResume).not.toHaveBeenCalled();

    setVisibilityState('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushResumeWithoutDrainingLongTimers();

    expect(mockSessionManager.validateOrRefreshOnResume).toHaveBeenCalledTimes(1);
    expect(mockSimpleSync.recoverAfterResume).toHaveBeenCalled();
  });

  it('hidden 状态下 pageshow persisted 不应抢跑 foreground 恢复', async () => {
    service.initialize();

    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    const pageshow = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(pageshow, 'persisted', { value: true });
    window.dispatchEvent(pageshow);
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1000);
    expect(mockSessionManager.validateOrRefreshOnResume).not.toHaveBeenCalled();

    setVisibilityState('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushResumeWithoutDrainingLongTimers();

    expect(mockSessionManager.validateOrRefreshOnResume).toHaveBeenCalledTimes(1);
    expect(mockSimpleSync.recoverAfterResume).toHaveBeenCalled();
  });

  it('should stop resume pipeline after timeout without blocking UI state', async () => {
    mockSimpleSync.recoverAfterResume.mockReturnValue(new Promise<void>(() => {
      // hold forever to trigger timeout
    }));

    const promise = service.triggerResume('visibility-threshold');

    await vi.advanceTimersByTimeAsync(APP_LIFECYCLE_CONFIG.RESUME_TIMEOUT_MS + 10);
    await promise;

    expect(service.isResuming()).toBe(false);
  });

  it('resume pipeline 超时后应取消协调器的后台恢复任务，避免 stale 后台探测继续运行', async () => {
    mockSimpleSync.recoverAfterResume.mockReturnValue(new Promise<void>(() => {
      // hold forever to trigger timeout
    }));

    const promise = service.triggerResume('visibility-threshold');

    await vi.advanceTimersByTimeAsync(APP_LIFECYCLE_CONFIG.RESUME_TIMEOUT_MS + 10);
    await promise;

    expect(mockSimpleSync.cancelPendingBackgroundRecovery).toHaveBeenCalled();
  });

  it('超时后的迟到 resume pipeline 不应再排 heavy compensation', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_INTERACTION_FIRST_V1 = true;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_PULSE_DEDUP_V1 = false;
    let resolveLightRecovery: (() => void) | null = null;
    mockSimpleSync.recoverAfterResume.mockImplementationOnce(
      () => new Promise<void>(resolve => {
        resolveLightRecovery = resolve;
      }),
    );

    const resumePromise = service.triggerResume('visibility-threshold');
    await flushResumeWithoutDrainingLongTimers();
    expect(resolveLightRecovery).toBeTypeOf('function');

    await vi.advanceTimersByTimeAsync(APP_LIFECYCLE_CONFIG.RESUME_TIMEOUT_MS + 10);
    await resumePromise;
    expect(service.isResuming()).toBe(false);

    resolveLightRecovery!();
    await flushResumeWithoutDrainingLongTimers();

    const heavyCompensationCalls = mockSimpleSync.recoverAfterResume.mock.calls.filter(
      ([, options]) => options?.mode === 'heavy' && options?.stage === 'compensation',
    );
    expect(heavyCompensationCalls).toHaveLength(0);
    expect(service.isRecoveryCompensationInFlight()).toBe(false);
  });

  it('超时后的迟到 pageshow 恢复不应再执行 focus gate recheck', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_INTERACTION_FIRST_V1 = true;
    let resolveLightRecovery: (() => void) | null = null;
    mockSimpleSync.recoverAfterResume.mockImplementationOnce(
      () => new Promise<void>(resolve => {
        resolveLightRecovery = resolve;
      }),
    );

    const resumePromise = service.triggerResume('pageshow');
    await flushResumeWithoutDrainingLongTimers();
    expect(resolveLightRecovery).toBeTypeOf('function');

    await vi.advanceTimersByTimeAsync(APP_LIFECYCLE_CONFIG.RESUME_TIMEOUT_MS + 10);
    await resumePromise;
    expect(service.isResuming()).toBe(false);
    expect(mockFocusStartupProbe.recheckGate).not.toHaveBeenCalled();

    resolveLightRecovery!();
    await flushResumeWithoutDrainingLongTimers();

    expect(mockFocusStartupProbe.recheckGate).not.toHaveBeenCalled();
  });

  it('heavy 恢复冷却窗口内应只执行一次 heavy 恢复', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_INTERACTION_FIRST_V1 = true;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_PULSE_DEDUP_V1 = true;

    await service.triggerResume('visibility-threshold');
    await flushResumeWithoutDrainingLongTimers();
    await service.triggerResume('visibility-threshold');
    await flushResumeWithoutDrainingLongTimers();

    const heavyCalls = mockSimpleSync.recoverAfterResume.mock.calls.filter(
      ([, options]) => options?.mode === 'heavy'
    );
    expect(heavyCalls).toHaveLength(1);
  });

  registerAppLifecycleOrchestratorExtraSpecs({
    service: () => service,
    sessionManager: () => mockSessionManager,
    simpleSync: () => mockSimpleSync,
    sentry: () => mockSentry,
    toast: () => mockToast,
    focusStartupProbe: () => mockFocusStartupProbe,
    syncCoordinator: () => mockSyncCoordinator,
    reloadViaForceClearCache: reloadViaForceClearCacheMock,
  });
});
