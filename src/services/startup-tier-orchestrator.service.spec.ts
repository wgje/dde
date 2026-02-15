import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DestroyRef, Injector } from '@angular/core';
import { StartupTierOrchestratorService } from './startup-tier-orchestrator.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';

describe('StartupTierOrchestratorService', () => {
  let service: StartupTierOrchestratorService;
  let destroyCallbacks: Array<() => void>;
  const sentry = {
    addBreadcrumb: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    destroyCallbacks = [];
    vi.clearAllMocks();

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => false,
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
    vi.useRealTimers();
  });

  it('initialize 后应立即就绪 p0', () => {
    service.initialize();
    expect(service.isTierReady('p0')).toBe(true);
  });

  it('p1 应按延时自动就绪', async () => {
    service.initialize();
    expect(service.isTierReady('p1')).toBe(false);

    await vi.advanceTimersByTimeAsync(500);

    expect(service.isTierReady('p1')).toBe(true);
  });

  it('p2 需要 auth ready 才能就绪', async () => {
    service.initialize();

    await vi.advanceTimersByTimeAsync(2500);
    expect(service.isTierReady('p2')).toBe(false);

    service.markAuthReady();
    await vi.advanceTimersByTimeAsync(1300);

    expect(service.isTierReady('p2')).toBe(true);
  });

  it('destroy 后不再推进 tier', async () => {
    service.initialize();
    service.destroy();

    await vi.advanceTimersByTimeAsync(3000);

    expect(service.isTierReady('p1')).toBe(false);
    expect(service.isTierReady('p2')).toBe(false);
  });

  it('triggerNow single-flight: 并发触发应稳定', async () => {
    service.initialize();

    const p1 = service.triggerNow('p1', 'manual');
    const p2 = service.triggerNow('p1', 'manual');
    await Promise.all([p1, p2]);

    expect(service.isTierReady('p1')).toBe(true);
  });
});
