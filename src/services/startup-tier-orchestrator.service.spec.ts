import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DestroyRef, Injector } from '@angular/core';
import { StartupTierOrchestratorService } from './startup-tier-orchestrator.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { STARTUP_PERF_CONFIG } from '../config/startup-performance.config';

describe('StartupTierOrchestratorService', () => {
  let service: StartupTierOrchestratorService;
  let destroyCallbacks: Array<() => void>;
  const sentry = {
    addBreadcrumb: vi.fn(),
  };
  type StartupTierOrchestratorPrivate = {
    authReady: boolean;
    p1Timer: ReturnType<typeof setTimeout> | null;
    p2Timer: ReturnType<typeof setTimeout> | null;
    p2SafetyTimer: ReturnType<typeof setTimeout> | null;
    minVisibleTimer: ReturnType<typeof setTimeout> | null;
    visibleSince: number;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    destroyCallbacks = [];
    vi.clearAllMocks();

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => false,
    });

    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      get: () => true,
    });

    const injector = Injector.create({
      providers: [
        { provide: StartupTierOrchestratorService, useClass: StartupTierOrchestratorService },
        { provide: SentryLazyLoaderService, useValue: sentry },
        { provide: DestroyRef, useValue: { onDestroy: (cb: () => void) => destroyCallbacks.push(cb) } },
      ],
    });

    service = injector.get(StartupTierOrchestratorService);
  });

  afterEach(() => {
    service.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('initialize 后应立即就绪 p0', () => {
    service.initialize();
    expect(service.isTierReady('p0')).toBe(true);
  });

  it('initialize 记录 breadcrumb 失败时仍应推进 p0 就绪', () => {
    sentry.addBreadcrumb.mockImplementationOnce(() => {
      throw new Error('breadcrumb unavailable');
    });

    expect(() => service.initialize()).not.toThrow();
    expect(service.isTierReady('p0')).toBe(true);
  });

  it('p1 应在 handoff 后立即就绪', async () => {
    service.initialize();
    expect(service.isTierReady('p1')).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    expect(service.isTierReady('p1')).toBe(false);

    service.markHandoffReady();
    await Promise.resolve();

    expect(service.isTierReady('p1')).toBe(true);
  });

  it('p2 需要 handoff 与 auth ready 才能就绪', async () => {
    service.initialize();

    service.markAuthReady();
    await vi.advanceTimersByTimeAsync(2500);
    expect(service.isTierReady('p2')).toBe(false);

    service.markHandoffReady();

    await vi.advanceTimersByTimeAsync(1300);

    expect(service.isTierReady('p2')).toBe(true);
  });

  it('handoff 前的焦点事件不应旁路启动 p2', async () => {
    service.initialize();
    service.markAuthReady();

    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();

    expect(service.isTierReady('p2')).toBe(false);

    service.markHandoffReady();

    await vi.advanceTimersByTimeAsync(
      Math.max(
        STARTUP_PERF_CONFIG.P2_SYNC_HYDRATE_DELAY_MS,
        STARTUP_PERF_CONFIG.P2_SYNC_MIN_VISIBLE_MS,
      ) + 50,
    );

    expect(service.isTierReady('p2')).toBe(true);
  });

  it('destroy 后不再推进 tier', async () => {
    service.initialize();
    service.destroy();

    await vi.advanceTimersByTimeAsync(3000);

    expect(service.isTierReady('p1')).toBe(false);
    expect(service.isTierReady('p2')).toBe(false);
  });

  it('destroy 后即使 p2 safety timer 回调迟到执行也不应推进 tier', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    service.initialize();
    service.markHandoffReady();
    const safetyCallback = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 8000)?.[0];
    expect(safetyCallback).toEqual(expect.any(Function));

    service.destroy();
    (safetyCallback as () => void)();

    expect(service.isTierReady('p2')).toBe(false);
  });

  it('destroy 后迟到的 auth ready 不应改变启动门禁状态', () => {
    service.initialize();
    service.destroy();

    service.markAuthReady();

    expect((service as unknown as StartupTierOrchestratorPrivate).authReady).toBe(false);
    expect(service.isTierReady('p2')).toBe(false);
  });

  it('destroy 应清理数值为 0 的启动分层定时器句柄', () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const privateService = service as unknown as StartupTierOrchestratorPrivate;
    privateService.p1Timer = 0 as unknown as ReturnType<typeof setTimeout>;
    privateService.p2Timer = 0 as unknown as ReturnType<typeof setTimeout>;
    privateService.p2SafetyTimer = 0 as unknown as ReturnType<typeof setTimeout>;
    privateService.minVisibleTimer = 0 as unknown as ReturnType<typeof setTimeout>;

    service.destroy();

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(4);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    expect(privateService.p1Timer).toBeNull();
    expect(privateService.p2Timer).toBeNull();
    expect(privateService.p2SafetyTimer).toBeNull();
    expect(privateService.minVisibleTimer).toBeNull();
  });

  it('destroy 清理监听器时单个 removeEventListener 失败仍继续清理其余监听器', () => {
    service.initialize();

    const removeWindowListener = vi
      .spyOn(window, 'removeEventListener')
      .mockImplementationOnce(((type: string) => {
        if (type === 'online') {
          throw new Error('remove online failed');
        }
      }) as typeof window.removeEventListener);
    const removeDocumentListener = vi.spyOn(document, 'removeEventListener');

    expect(() => service.destroy()).not.toThrow();
    expect(removeWindowListener).toHaveBeenCalledWith('focus', expect.any(Function));
    expect(removeDocumentListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'startup',
        level: 'warning',
        message: 'startup.tier.cleanup_failed',
        data: expect.objectContaining({
          error: 'remove online failed',
          resource: 'window.online',
        }),
      }),
    );
  });

  it('destroy 清理失败且 breadcrumb 记录失败时仍继续清理其余监听器', () => {
    service.initialize();
    sentry.addBreadcrumb.mockImplementationOnce(() => {
      throw new Error('breadcrumb unavailable');
    });

    const removeWindowListener = vi
      .spyOn(window, 'removeEventListener')
      .mockImplementationOnce(((type: string) => {
        if (type === 'online') {
          throw new Error('remove online failed');
        }
      }) as typeof window.removeEventListener);
    const removeDocumentListener = vi.spyOn(document, 'removeEventListener');

    expect(() => service.destroy()).not.toThrow();
    expect(removeWindowListener).toHaveBeenCalledWith('focus', expect.any(Function));
    expect(removeDocumentListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });

  it('triggerNow single-flight: 并发触发应稳定', async () => {
    service.initialize();
    service.markHandoffReady();

    const p1 = service.triggerNow('p1', 'manual');
    const p2 = service.triggerNow('p1', 'manual');
    await Promise.all([p1, p2]);

    expect(service.isTierReady('p1')).toBe(true);
  });

  it('auth ready 不应复用同 tick 内因 auth_not_ready 跳过的 p2 trigger', async () => {
    service.initialize();
    service.markHandoffReady();
    const privateService = service as unknown as StartupTierOrchestratorPrivate;
    privateService.visibleSince = Date.now() - STARTUP_PERF_CONFIG.P2_SYNC_MIN_VISIBLE_MS - 1;

    const skippedWhileAuthMissing = service.triggerNow('p2', 'focus');
    service.markAuthReady();
    await skippedWhileAuthMissing;
    await Promise.resolve();

    expect(service.isTierReady('p2')).toBe(true);
  });

  it('p2 最小可见时间 timer 触发完成后应清理自身句柄', async () => {
    service.initialize();
    service.markHandoffReady();
    const privateService = service as unknown as StartupTierOrchestratorPrivate;

    service.markAuthReady();

    expect(privateService.minVisibleTimer).not.toBeNull();

    await vi.advanceTimersByTimeAsync(STARTUP_PERF_CONFIG.P2_SYNC_MIN_VISIBLE_MS);
    await Promise.resolve();

    expect(service.isTierReady('p2')).toBe(true);
    expect(privateService.minVisibleTimer).toBeNull();
  });
});
