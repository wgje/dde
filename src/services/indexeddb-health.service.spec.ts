import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IndexedDBService } from '../core-bridge';
import { IndexedDBHealthService } from './indexeddb-health.service';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('IndexedDBHealthService', () => {
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
    error: vi.fn(),
    warning: vi.fn(),
  };
  const sentryLazyLoader = {
    captureException: vi.fn(),
  };

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('does not start periodic health checks after destroy while startup check is pending', async () => {
    vi.useFakeTimers();
    const initDatabase = createDeferred<IDBDatabase | null>();
    const indexedDBService = {
      initDatabase: vi.fn(() => initDatabase.promise),
    };
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    TestBed.configureTestingModule({
      providers: [
        IndexedDBHealthService,
        { provide: IndexedDBService, useValue: indexedDBService },
        { provide: LoggerService, useValue: logger },
        { provide: ToastService, useValue: toast },
        { provide: SentryLazyLoaderService, useValue: sentryLazyLoader },
      ],
    });
    const service = TestBed.inject(IndexedDBHealthService);

    const initialize = service.initialize();
    service.ngOnDestroy();
    initDatabase.resolve(null);
    await initialize;

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(service.lastResult()).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
    expect(sentryLazyLoader.captureException).not.toHaveBeenCalled();
  });

  it('clears zero-valued periodic health check timer handles on destroy', async () => {
    const indexedDBService = {
      initDatabase: vi.fn().mockResolvedValue(null),
    };
    vi.spyOn(globalThis, 'setInterval')
      .mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
      .mockImplementation(() => undefined);

    TestBed.configureTestingModule({
      providers: [
        IndexedDBHealthService,
        { provide: IndexedDBService, useValue: indexedDBService },
        { provide: LoggerService, useValue: logger },
        { provide: ToastService, useValue: toast },
        { provide: SentryLazyLoaderService, useValue: sentryLazyLoader },
      ],
    });
    const service = TestBed.inject(IndexedDBHealthService);

    await service.initialize();
    service.ngOnDestroy();

    expect(clearIntervalSpy).toHaveBeenCalledWith(0);
  });

  it('deduplicates concurrent initialization while startup health check is pending', async () => {
    vi.useFakeTimers();
    const initDatabase = createDeferred<IDBDatabase | null>();
    const indexedDBService = {
      initDatabase: vi.fn(() => initDatabase.promise),
    };

    TestBed.configureTestingModule({
      providers: [
        IndexedDBHealthService,
        { provide: IndexedDBService, useValue: indexedDBService },
        { provide: LoggerService, useValue: logger },
        { provide: ToastService, useValue: toast },
        { provide: SentryLazyLoaderService, useValue: sentryLazyLoader },
      ],
    });
    const service = TestBed.inject(IndexedDBHealthService);

    const firstInitialize = service.initialize();
    const secondInitialize = service.initialize();
    let secondSettled = false;
    void secondInitialize.then(() => {
      secondSettled = true;
    });
    await flushMicrotasks();

    expect(secondSettled).toBe(false);

    initDatabase.resolve(null);
    const [firstResult, secondResult] = await Promise.all([
      firstInitialize,
      secondInitialize,
    ]);

    expect(indexedDBService.initDatabase).toHaveBeenCalledOnce();
    expect(secondResult).toBe(firstResult);
    expect(secondResult.healthy).toBe(false);
    service.ngOnDestroy();
  });

  it('deduplicates concurrent health checks to avoid duplicate diagnostics side effects', async () => {
    const initDatabase = createDeferred<IDBDatabase | null>();
    const indexedDBService = {
      initDatabase: vi.fn(() => initDatabase.promise),
    };

    TestBed.configureTestingModule({
      providers: [
        IndexedDBHealthService,
        { provide: IndexedDBService, useValue: indexedDBService },
        { provide: LoggerService, useValue: logger },
        { provide: ToastService, useValue: toast },
        { provide: SentryLazyLoaderService, useValue: sentryLazyLoader },
      ],
    });
    const service = TestBed.inject(IndexedDBHealthService);

    const firstCheck = service.performHealthCheck();
    const secondCheck = service.performHealthCheck();
    let secondSettled = false;
    void secondCheck.then(() => {
      secondSettled = true;
    });
    await flushMicrotasks();

    expect(secondSettled).toBe(false);

    initDatabase.resolve(null);
    const [firstResult, secondResult] = await Promise.all([
      firstCheck,
      secondCheck,
    ]);

    expect(indexedDBService.initDatabase).toHaveBeenCalledOnce();
    expect(secondResult).toBe(firstResult);
    expect(toast.error).toHaveBeenCalledOnce();
    expect(sentryLazyLoader.captureException).toHaveBeenCalledOnce();
    service.ngOnDestroy();
  });

  it('ignores a captured periodic health check callback after destroy', async () => {
    vi.useFakeTimers();
    const indexedDBService = {
      initDatabase: vi.fn().mockResolvedValue(null),
    };

    TestBed.configureTestingModule({
      providers: [
        IndexedDBHealthService,
        { provide: IndexedDBService, useValue: indexedDBService },
        { provide: LoggerService, useValue: logger },
        { provide: ToastService, useValue: toast },
        { provide: SentryLazyLoaderService, useValue: sentryLazyLoader },
      ],
    });
    const service = TestBed.inject(IndexedDBHealthService);

    await service.initialize();
    expect(indexedDBService.initDatabase).toHaveBeenCalledTimes(1);

    service.ngOnDestroy();
    vi.runOnlyPendingTimers();
    await flushMicrotasks();

    expect(indexedDBService.initDatabase).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledOnce();
    expect(sentryLazyLoader.captureException).toHaveBeenCalledOnce();
  });
});
