import { beforeEach, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';

import { APP_LIFECYCLE_CONFIG } from '../config';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import type { AppLifecycleOrchestratorService } from './app-lifecycle-orchestrator.service';
import { flushResumeWithoutDrainingLongTimers } from './app-lifecycle-orchestrator.test-harness';

type SpecMock = ReturnType<typeof vi.fn>;

interface AppLifecycleHeavyCompensationSpecContext {
  service: () => AppLifecycleOrchestratorService;
  simpleSync: () => {
    recoverAfterResume: SpecMock;
    suspendTransport: SpecMock;
    cancelPendingBackgroundRecovery: SpecMock;
  };
  focusStartupProbe: () => {
    recheckGate: SpecMock;
    hasPendingGateWork: SpecMock;
  };
  syncCoordinator: () => {
    hasPendingLocalChanges: SpecMock;
    flushPendingPersistToCloud: SpecMock;
    refreshBlackBoxWatermarkIfNeeded: SpecMock;
  };
  logger: () => {
    info: SpecMock;
    warn: SpecMock;
    error: SpecMock;
    debug: SpecMock;
  };
}

export function registerAppLifecycleHeavyCompensationSpecs(
  context: AppLifecycleHeavyCompensationSpecContext,
): void {
  let service: AppLifecycleOrchestratorService;
  let mockSimpleSync: ReturnType<AppLifecycleHeavyCompensationSpecContext['simpleSync']>;
  let mockFocusStartupProbe: ReturnType<AppLifecycleHeavyCompensationSpecContext['focusStartupProbe']>;
  let mockSyncCoordinator: ReturnType<AppLifecycleHeavyCompensationSpecContext['syncCoordinator']>;
  let mockLoggerCategory: ReturnType<AppLifecycleHeavyCompensationSpecContext['logger']>;

  beforeEach(() => {
    service = context.service();
    mockSimpleSync = context.simpleSync();
    mockFocusStartupProbe = context.focusStartupProbe();
    mockSyncCoordinator = context.syncCoordinator();
    mockLoggerCategory = context.logger();
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
}
