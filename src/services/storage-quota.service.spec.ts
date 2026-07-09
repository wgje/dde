import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { StorageQuotaService } from './storage-quota.service';
import { ToastService } from './toast.service';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

describe('StorageQuotaService', () => {
  const loggerCategory = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const logger = {
    category: vi.fn(() => loggerCategory),
  };
  const toast = {
    warning: vi.fn(),
  };
  const sentryLazyLoader = {
    captureException: vi.fn(),
  };

  let originalStorageDescriptor: PropertyDescriptor | undefined;

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.useRealTimers();
    localStorage.clear();
    if (originalStorageDescriptor) {
      Object.defineProperty(navigator, 'storage', originalStorageDescriptor);
    } else {
      Reflect.deleteProperty(navigator, 'storage');
    }
  });

  it('does not start periodic quota checks after destroy while startup check is pending', async () => {
    vi.useFakeTimers();
    originalStorageDescriptor = Object.getOwnPropertyDescriptor(navigator, 'storage');
    const estimate = createDeferred<StorageEstimate>();
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        estimate: vi.fn(() => estimate.promise),
      },
    });
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    TestBed.configureTestingModule({
      providers: [
        StorageQuotaService,
        { provide: LoggerService, useValue: logger },
        { provide: ToastService, useValue: toast },
        { provide: SentryLazyLoaderService, useValue: sentryLazyLoader },
      ],
    });
    const service = TestBed.inject(StorageQuotaService);

    const initialize = service.initialize();
    service.ngOnDestroy();
    estimate.resolve({ quota: 1024, usage: 128 });
    await initialize;

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(service.report()).toBeNull();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('clears zero-valued periodic quota timer handles on destroy', async () => {
    originalStorageDescriptor = Object.getOwnPropertyDescriptor(navigator, 'storage');
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        estimate: vi.fn().mockResolvedValue({ quota: 1024, usage: 128 }),
      },
    });
    vi.spyOn(globalThis, 'setInterval')
      .mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
      .mockImplementation(() => undefined);

    TestBed.configureTestingModule({
      providers: [
        StorageQuotaService,
        { provide: LoggerService, useValue: logger },
        { provide: ToastService, useValue: toast },
        { provide: SentryLazyLoaderService, useValue: sentryLazyLoader },
      ],
    });
    const service = TestBed.inject(StorageQuotaService);

    await service.initialize();
    service.ngOnDestroy();

    expect(clearIntervalSpy).toHaveBeenCalledWith(0);
  });

  it('deduplicates concurrent critical quota checks to avoid duplicate cleanup side effects', async () => {
    originalStorageDescriptor = Object.getOwnPropertyDescriptor(navigator, 'storage');
    const estimate = createDeferred<StorageEstimate>();
    const estimateApi = vi.fn(() => estimate.promise);
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        estimate: estimateApi,
      },
    });

    TestBed.configureTestingModule({
      providers: [
        StorageQuotaService,
        { provide: LoggerService, useValue: logger },
        { provide: ToastService, useValue: toast },
        { provide: SentryLazyLoaderService, useValue: sentryLazyLoader },
      ],
    });
    const service = TestBed.inject(StorageQuotaService);
    const cleanupSpy = vi.spyOn(service, 'emergencyCleanup')
      .mockReturnValue({ cleaned: 0, freedBytes: 0 });

    const first = service.checkQuota();
    const second = service.checkQuota();

    expect(estimateApi).toHaveBeenCalledTimes(1);

    estimate.resolve({ quota: 100 * 1024 * 1024, usage: 50 * 1024 * 1024 });
    await Promise.all([first, second]);

    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it('does not run emergency cleanup side effects after destroy', () => {
    TestBed.configureTestingModule({
      providers: [
        StorageQuotaService,
        { provide: LoggerService, useValue: logger },
        { provide: ToastService, useValue: toast },
        { provide: SentryLazyLoaderService, useValue: sentryLazyLoader },
      ],
    });
    const service = TestBed.inject(StorageQuotaService);
    localStorage.setItem('nanoflow.temp-cache', 'x'.repeat(2048));

    service.ngOnDestroy();
    const result = service.emergencyCleanup();

    expect(result).toEqual({ cleaned: 0, freedBytes: 0 });
    expect(localStorage.getItem('nanoflow.temp-cache')).not.toBeNull();
    expect(sentryLazyLoader.captureException).not.toHaveBeenCalled();
  });
});
