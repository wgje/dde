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
  let online: boolean;
  let swUpdate: {
    isEnabled: boolean;
    activateUpdate: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-14T00:00:00.000Z'));
    localStorage.removeItem('nanoflow.lifecycle.auto-reload');
    reloadViaForceClearCacheMock.mockReset();
    online = true;
    vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => online);

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
    swUpdate = { isEnabled: false, activateUpdate: vi.fn().mockResolvedValue(undefined) };

    TestBed.configureTestingModule({
      providers: [
        AppLifecycleReloadCoordinator,
        { provide: SwUpdate, useValue: swUpdate },
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
    vi.restoreAllMocks();
  });

  const scheduleAutoReload = (
    reason: 'visibility-quick' | 'pageshow' = 'visibility-quick',
    errorMessage = 'resume pipeline failed',
  ): void => coordinator.maybeScheduleAutoReload(
    reason,
    new Error(errorMessage),
    APP_LIFECYCLE_CONFIG.AUTO_RELOAD_FAILURE_THRESHOLD,
  );

  it('resets the manual prompt without activating or clearing while offline', async () => {
    online = false;
    swUpdate.isEnabled = true;
    const resetVersionPrompt = vi.fn();

    await coordinator.triggerVersionReload(vi.fn(), resetVersionPrompt);

    expect(swUpdate.activateUpdate).not.toHaveBeenCalled();
    expect(reloadViaForceClearCacheMock).not.toHaveBeenCalled();
    expect(resetVersionPrompt).toHaveBeenCalledOnce();
  });

  it('does not clear when connectivity is lost during update activation', async () => {
    swUpdate.isEnabled = true;
    swUpdate.activateUpdate.mockImplementationOnce(async () => { online = false; });
    const resetVersionPrompt = vi.fn();

    await coordinator.triggerVersionReload(vi.fn(), resetVersionPrompt);

    expect(reloadViaForceClearCacheMock).not.toHaveBeenCalled();
    expect(resetVersionPrompt).toHaveBeenCalledOnce();
  });

  it('does not consume quota or schedule an automatic reload while offline', () => {
    online = false;

    scheduleAutoReload();

    expect(localStorage.getItem('nanoflow.lifecycle.auto-reload')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('restores quota once after timer-time offline and permits an online reschedule', async () => {
    const removeQuota = vi.spyOn(localStorage, 'removeItem');
    scheduleAutoReload();
    expect(JSON.parse(localStorage.getItem('nanoflow.lifecycle.auto-reload') ?? '{}').count).toBe(1);
    online = false;
    await vi.advanceTimersByTimeAsync(1500);

    expect(localStorage.getItem('nanoflow.lifecycle.auto-reload')).toBeNull();
    expect(removeQuota).toHaveBeenCalledOnce();
    expect(reloadViaForceClearCacheMock).not.toHaveBeenCalled();
    coordinator.resetSessionRuntime();
    expect(removeQuota).toHaveBeenCalledOnce();

    online = true;
    scheduleAutoReload();
    expect(JSON.parse(localStorage.getItem('nanoflow.lifecycle.auto-reload') ?? '{}').count).toBe(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(reloadViaForceClearCacheMock).toHaveBeenCalledOnce();
  });

  it('keeps consumed quota after a successful online automatic reload', async () => {
    scheduleAutoReload();
    await vi.advanceTimersByTimeAsync(1500);

    expect(JSON.parse(localStorage.getItem('nanoflow.lifecycle.auto-reload') ?? '{}').count).toBe(1);
  });

  it('does not restore committed quota after a successful online automatic reload', async () => {
    scheduleAutoReload();
    await vi.advanceTimersByTimeAsync(1500);
    expect(reloadViaForceClearCacheMock).toHaveBeenCalledOnce();
    coordinator.resetSessionRuntime();
    expect(JSON.parse(localStorage.getItem('nanoflow.lifecycle.auto-reload') ?? '{}').count).toBe(1);
  });

  it('keeps activation failure compatible with the force-clear recovery path', async () => {
    swUpdate.isEnabled = true;
    swUpdate.activateUpdate.mockRejectedValueOnce(new Error('activation failed'));
    const addBreadcrumb = vi.fn();

    await coordinator.triggerVersionReload(addBreadcrumb, vi.fn());

    expect(addBreadcrumb).toHaveBeenCalledWith(
      'lifecycle.version-reload.activate-failed',
      'manual',
      { error: 'activation failed' },
    );
    expect(reloadViaForceClearCacheMock).toHaveBeenCalledOnce();
  });

  it('cancels a pending timer and restores quota when session runtime resets', async () => {
    scheduleAutoReload();

    coordinator.resetSessionRuntime();
    await vi.advanceTimersByTimeAsync(1500);

    expect(reloadViaForceClearCacheMock).not.toHaveBeenCalled();
    expect(localStorage.getItem('nanoflow.lifecycle.auto-reload')).toBeNull();
  });

  it('coalesces duplicate automatic reload scheduling', async () => {
    scheduleAutoReload();
    scheduleAutoReload();
    await vi.advanceTimersByTimeAsync(1500);

    expect(reloadViaForceClearCacheMock).toHaveBeenCalledOnce();
    expect(toast.warning).toHaveBeenCalledOnce();
    expect(sentry.captureMessage).toHaveBeenCalledOnce();
  });

  it('contains failures thrown by the scheduled auto reload callback', async () => {
    const reloadError = new Error('reload failed');
    reloadViaForceClearCacheMock.mockImplementationOnce(() => {
      throw reloadError;
    });

    scheduleAutoReload();

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

    scheduleAutoReload('visibility-quick', 'first resume pipeline failed');
    await vi.advanceTimersByTimeAsync(1500);

    scheduleAutoReload('pageshow', 'second resume pipeline failed');
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

    scheduleAutoReload();
    await vi.advanceTimersByTimeAsync(1500);

    scheduleAutoReload('pageshow', 'resume pipeline failed again');
    await vi.advanceTimersByTimeAsync(1500);

    expect(reloadViaForceClearCacheMock).toHaveBeenCalledTimes(2);
  });
});
