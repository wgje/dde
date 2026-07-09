import { SwUpdate } from '@angular/service-worker';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_LIFECYCLE_CONFIG } from '../config/app-lifecycle.config';
import { AppLifecycleReloadCoordinator } from './app-lifecycle-reload.coordinator';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { ToastService } from './toast.service';

const reloadViaForceClearCacheMock = vi.hoisted(() => vi.fn());

vi.mock('../utils/force-clear-cache', () => ({
  reloadViaForceClearCache: reloadViaForceClearCacheMock,
}));

describe('AppLifecycleReloadCoordinator', () => {
  let coordinator: AppLifecycleReloadCoordinator;
  let loggerCategory: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
  let sentry: {
    captureMessage: ReturnType<typeof vi.fn>;
  };
  let toast: {
    warning: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-14T00:00:00.000Z'));
    localStorage.removeItem('nanoflow.lifecycle.auto-reload');
    reloadViaForceClearCacheMock.mockReset();

    loggerCategory = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    sentry = {
      captureMessage: vi.fn(),
    };
    toast = {
      warning: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        AppLifecycleReloadCoordinator,
        { provide: SwUpdate, useValue: { isEnabled: false, activateUpdate: vi.fn() } },
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn().mockReturnValue(loggerCategory),
          },
        },
        { provide: SentryLazyLoaderService, useValue: sentry },
        { provide: ToastService, useValue: toast },
      ],
    });

    coordinator = TestBed.inject(AppLifecycleReloadCoordinator);
  });

  afterEach(() => {
    localStorage.removeItem('nanoflow.lifecycle.auto-reload');
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('contains failures thrown by the scheduled auto reload callback', async () => {
    const reloadError = new Error('reload failed');
    reloadViaForceClearCacheMock.mockImplementationOnce(() => {
      throw reloadError;
    });

    coordinator.maybeScheduleAutoReload(
      'visibility-quick',
      new Error('resume pipeline failed'),
      APP_LIFECYCLE_CONFIG.AUTO_RELOAD_FAILURE_THRESHOLD,
    );

    await vi.advanceTimersByTimeAsync(1500);

    expect(reloadViaForceClearCacheMock).toHaveBeenCalledOnce();
    expect(loggerCategory.warn).toHaveBeenCalledWith(
      'Lifecycle auto reload failed',
      reloadError,
    );
  });

  it('allows auto reload to be rescheduled when the scheduled reload callback fails', async () => {
    reloadViaForceClearCacheMock
      .mockImplementationOnce(() => {
        throw new Error('first reload failed');
      })
      .mockImplementationOnce(() => undefined);

    coordinator.maybeScheduleAutoReload(
      'visibility-quick',
      new Error('first resume pipeline failed'),
      APP_LIFECYCLE_CONFIG.AUTO_RELOAD_FAILURE_THRESHOLD,
    );
    await vi.advanceTimersByTimeAsync(1500);

    coordinator.maybeScheduleAutoReload(
      'pageshow',
      new Error('second resume pipeline failed'),
      APP_LIFECYCLE_CONFIG.AUTO_RELOAD_FAILURE_THRESHOLD,
    );
    await vi.advanceTimersByTimeAsync(1500);

    expect(reloadViaForceClearCacheMock).toHaveBeenCalledTimes(2);
    expect(toast.warning).toHaveBeenCalledTimes(2);
    expect(sentry.captureMessage).toHaveBeenCalledTimes(2);
  });

  it('keeps failed auto reload retryable when the warning sink also fails', async () => {
    reloadViaForceClearCacheMock
      .mockImplementationOnce(() => {
        throw new Error('reload failed');
      })
      .mockImplementationOnce(() => undefined);
    loggerCategory.warn.mockImplementationOnce(() => {
      throw new Error('logger sink failed');
    });

    coordinator.maybeScheduleAutoReload(
      'visibility-quick',
      new Error('resume pipeline failed'),
      APP_LIFECYCLE_CONFIG.AUTO_RELOAD_FAILURE_THRESHOLD,
    );
    await vi.advanceTimersByTimeAsync(1500);

    coordinator.maybeScheduleAutoReload(
      'pageshow',
      new Error('resume pipeline failed again'),
      APP_LIFECYCLE_CONFIG.AUTO_RELOAD_FAILURE_THRESHOLD,
    );
    await vi.advanceTimersByTimeAsync(1500);

    expect(reloadViaForceClearCacheMock).toHaveBeenCalledTimes(2);
  });
});
