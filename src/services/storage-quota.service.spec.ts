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

  function createDeniedStorage(mode: 'length' | 'key' | 'getItem'): Storage {
    const key = vi.fn((index: number): string | null => {
      if (mode === 'key') throw new DOMException('storage denied', 'SecurityError');
      return index === 0 ? 'nanoflow.temp-cache' : null;
    });
    const getItem = vi.fn((_key: string): string => {
      if (mode === 'getItem') throw new DOMException('storage denied', 'SecurityError');
      return 'x'.repeat(2048);
    });
    return {
      get length() {
        if (mode === 'length') throw new DOMException('storage denied', 'SecurityError');
        return 1;
      },
      key,
      getItem,
      removeItem: vi.fn(),
      setItem: vi.fn(),
      clear: vi.fn(),
    } as Storage;
  }

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

  it('returns no candidates when localStorage is unavailable', () => {
    const originalLocalStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: undefined,
    });
    try {
      TestBed.configureTestingModule({
        providers: [
          StorageQuotaService,
          { provide: LoggerService, useValue: logger },
          { provide: ToastService, useValue: toast },
          { provide: SentryLazyLoaderService, useValue: sentryLazyLoader },
        ],
      });
      const service = TestBed.inject(StorageQuotaService);

      expect(() => service.getCleanableItems()).not.toThrow();
      expect(service.getCleanableItems()).toEqual([]);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: originalLocalStorage,
      });
    }
  });

  it('returns no candidates when the localStorage getter throws', () => {
    const originalLocalStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('storage denied', 'SecurityError');
      },
    });
    try {
      TestBed.configureTestingModule({
        providers: [
          StorageQuotaService,
          { provide: LoggerService, useValue: logger },
          { provide: ToastService, useValue: toast },
          { provide: SentryLazyLoaderService, useValue: sentryLazyLoader },
        ],
      });
      const service = TestBed.inject(StorageQuotaService);

      expect(() => service.getCleanableItems()).not.toThrow();
      expect(service.getCleanableItems()).toEqual([]);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: originalLocalStorage,
      });
    }
  });

  it.each(['length', 'key', 'getItem'] as const)(
    'returns no candidates and performs no cleanup when localStorage %s access throws',
    (mode) => {
      const storage = createDeniedStorage(mode);
      const originalLocalStorage = globalThis.localStorage;
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: storage,
      });
      try {
        TestBed.configureTestingModule({
          providers: [
            StorageQuotaService,
            { provide: LoggerService, useValue: logger },
            { provide: ToastService, useValue: toast },
            { provide: SentryLazyLoaderService, useValue: sentryLazyLoader },
          ],
        });
        const service = TestBed.inject(StorageQuotaService);

        expect(() => service.getCleanableItems()).not.toThrow();
        expect(service.getCleanableItems()).toEqual([]);
        expect(service.emergencyCleanup()).toEqual({ cleaned: 0, freedBytes: 0 });
        expect(storage.removeItem).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(globalThis, 'localStorage', {
          configurable: true,
          value: originalLocalStorage,
        });
      }
    },
  );

  it('discards partially enumerated candidates when a later storage access throws', () => {
    const key = vi.fn((index: number): string | null => {
      if (index === 1) throw new DOMException('storage denied', 'SecurityError');
      return index === 0 ? 'nanoflow.temp-cache' : null;
    });
    const getItem = vi.fn(() => 'x'.repeat(2048));
    const storage = {
      get length() {
        return 2;
      },
      key,
      getItem,
      removeItem: vi.fn(),
      setItem: vi.fn(),
      clear: vi.fn(),
    } as Storage;
    const originalLocalStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage,
    });
    try {
      TestBed.configureTestingModule({
        providers: [
          StorageQuotaService,
          { provide: LoggerService, useValue: logger },
          { provide: ToastService, useValue: toast },
          { provide: SentryLazyLoaderService, useValue: sentryLazyLoader },
        ],
      });
      const service = TestBed.inject(StorageQuotaService);

      expect(service.getCleanableItems()).toEqual([]);
      expect(getItem).toHaveBeenCalledTimes(1);
      expect(storage.removeItem).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: originalLocalStorage,
      });
    }
  });

  it('keeps safe and protected localStorage classification unchanged', () => {
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
    localStorage.setItem('nanoflow.preferences', 'y'.repeat(2048));
    localStorage.setItem('other.temp', 'z'.repeat(2048));

    expect(service.getCleanableItems()).toEqual([
      {
        type: 'localStorage',
        key: 'nanoflow.temp-cache',
        description: '缓存数据 (nanoflow.temp-cache)',
        estimatedSize: 2048,
        safe: true,
      },
    ]);
  });
});
