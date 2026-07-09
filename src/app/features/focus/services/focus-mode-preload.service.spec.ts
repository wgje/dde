import { Injector, runInInjectionContext } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IDLE_SCHEDULE_CONFIG } from '../../../../config/timeout.config';
import { LoggerService } from '../../../../services/logger.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { FocusModePreloadService } from './focus-mode-preload.service';

vi.mock('../focus-mode.component', () => ({
  FocusModeComponent: {
    preloadAssets: vi.fn().mockResolvedValue(undefined),
  },
}));

function createLoggerService() {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  return {
    logger,
    service: {
      category: vi.fn(() => logger),
    },
  };
}

function createSentryLazyLoaderService() {
  return {
    addBreadcrumb: vi.fn(),
  };
}

function createService(): {
  injector: Injector & { destroy?: () => void };
  logger: ReturnType<typeof createLoggerService>['logger'];
  service: FocusModePreloadService;
  sentryLazyLoader: ReturnType<typeof createSentryLazyLoaderService>;
} {
  const loggerService = createLoggerService();
  const sentryLazyLoader = createSentryLazyLoaderService();
  const injector = Injector.create({
    providers: [
      { provide: LoggerService, useValue: loggerService.service },
      { provide: SentryLazyLoaderService, useValue: sentryLazyLoader },
    ],
  }) as Injector & { destroy?: () => void };
  const service = runInInjectionContext(
    injector,
    () => new FocusModePreloadService(),
  );

  return {
    injector,
    logger: loggerService.logger,
    service,
    sentryLazyLoader,
  };
}

describe('FocusModePreloadService', () => {
  let originalRequestIdleCallback: PropertyDescriptor | undefined;
  let injector: (Injector & { destroy?: () => void }) | undefined;

  beforeEach(() => {
    originalRequestIdleCallback = Object.getOwnPropertyDescriptor(
      window,
      'requestIdleCallback',
    );
    vi.useFakeTimers();
  });

  afterEach(() => {
    injector?.destroy?.();
    injector = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();

    if (originalRequestIdleCallback) {
      Object.defineProperty(window, 'requestIdleCallback', originalRequestIdleCallback);
    } else {
      Reflect.deleteProperty(window, 'requestIdleCallback');
    }
  });

  it('falls back to one timer when requestIdleCallback scheduling throws', () => {
    const requestIdleCallback = vi.fn(() => {
      throw new Error('idle callback registration failed');
    });
    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true,
      value: requestIdleCallback,
    });
    const created = createService();
    injector = created.injector;
    const preload = vi.spyOn(created.service, 'preload')
      .mockResolvedValue(undefined);

    expect(() => {
      created.service.schedule('startup');
      created.service.schedule('p1');
    }).not.toThrow();
    expect(requestIdleCallback).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(IDLE_SCHEDULE_CONFIG.SHORT_MS);

    expect(preload).toHaveBeenCalledOnce();
    expect(preload).toHaveBeenCalledWith('startup');
  });

  it('resolves failed preload when warning also fails and allows retry', async () => {
    const created = createService();
    injector = created.injector;
    created.sentryLazyLoader.addBreadcrumb.mockImplementationOnce(() => {
      throw new Error('breadcrumb failed');
    });
    created.logger.warn.mockImplementationOnce(() => {
      throw new Error('warn failed');
    });

    await expect(created.service.preload('intent')).resolves.toBeUndefined();

    expect(created.logger.warn).toHaveBeenCalledWith(
      'FocusMode 懒预热失败',
      expect.any(Error)
    );

    await expect(created.service.preload('intent')).resolves.toBeUndefined();

    expect(created.sentryLazyLoader.addBreadcrumb).toHaveBeenCalledTimes(2);
  });
});
