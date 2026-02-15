import { DestroyRef, Injector, runInInjectionContext, signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventDrivenSyncPulseService } from './event-driven-sync-pulse.service';
import { SimpleSyncService } from '../app/core/services/simple-sync.service';
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
  let visibilityStateValue: DocumentVisibilityState;
  let appLifecycleMock: {
    isResuming: ReturnType<typeof vi.fn>;
    isHeavyRecoveryInCooldown: ReturnType<typeof vi.fn>;
    getCurrentRecoveryTicket: ReturnType<typeof vi.fn>;
    isRecoveryCompensationInFlight: ReturnType<typeof vi.fn>;
  };
  let sessionManagerMock: {
    getRecentValidationSnapshot: ReturnType<typeof vi.fn>;
  };
  let heartbeatIntervalMs: number;
  let mathRandomSpy: ReturnType<typeof vi.spyOn> | null = null;
  const originalResumeInteractionFirst = FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1;
  const originalPulseDedup = FEATURE_FLAGS.RESUME_PULSE_DEDUP_V1;
  const originalRecoveryTicketDedup = FEATURE_FLAGS.RECOVERY_TICKET_DEDUP_V1;
  const originalHeartbeatInterval = STARTUP_PERF_CONFIG.SYNC_HEARTBEAT_VISIBLE_INTERVAL_MS;

  const destroyCallbacks: Array<() => void> = [];
  const mockDestroyRef: Pick<DestroyRef, 'onDestroy'> = {
    onDestroy: (cb: () => void) => {
      destroyCallbacks.push(cb);
    },
  };

  beforeEach(() => {
    vi.useFakeTimers();
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
    appLifecycleMock = {
      isResuming: vi.fn(() => false),
      isHeavyRecoveryInCooldown: vi.fn(() => false),
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

    const injector = Injector.create({
      providers: [
        { provide: EventDrivenSyncPulseService, useClass: EventDrivenSyncPulseService },
        { provide: SimpleSyncService, useValue: { recoverAfterResume } },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
              debug: vi.fn(),
            }),
          },
        },
        { provide: SentryLazyLoaderService, useValue: { addBreadcrumb, captureException: vi.fn() } },
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
    service?.destroy();
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

    resolvePull?.();
    await Promise.all([p1, p2]);
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

  it('compensation 进行中时应抑制 pulse', async () => {
    appLifecycleMock.isRecoveryCompensationInFlight.mockReturnValue(true);

    await service.triggerNow('manual');

    expect(recoverAfterResume).not.toHaveBeenCalled();
    expect(addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      message: 'sync.pulse.skipped.compensating',
    }));
  });
});
