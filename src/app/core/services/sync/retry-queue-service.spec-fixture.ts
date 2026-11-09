import { DestroyRef, Injector, runInInjectionContext } from '@angular/core';
import { vi } from 'vitest';

import { AuthService } from '../../../../services/auth.service';
import { BlackBoxSyncService } from '../../../../services/black-box-sync.service';
import { LoggerService } from '../../../../services/logger.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { SyncWriterLeaseService } from '../../../../services/sync-writer-lease.service';
import { ToastService } from '../../../../services/toast.service';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../../../../utils/browser-network-suspension';
import {
  resetRetryQueueSpecUuidCache,
  setVisibilityState,
} from './retry-queue-test-data.spec-helpers';
import {
  RetryQueueService,
  type RetryOperationHandler,
} from './retry-queue.service';

export interface RetryQueueServiceSpecHarness {
  service: RetryQueueService;
  loggerCategory: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
  handler: RetryOperationHandler;
  authServiceMock: {
    currentUserId: ReturnType<typeof vi.fn>;
    peekPersistedOwnerHint: ReturnType<typeof vi.fn>;
    peekPersistedSessionIdentity: ReturnType<typeof vi.fn>;
  };
  projectStateMock: {
    getProject: ReturnType<typeof vi.fn>;
  };
  toastMock: {
    warning: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    success: ReturnType<typeof vi.fn>;
  };
  blackBoxSyncMock: {
    markEntrySyncConflict: ReturnType<typeof vi.fn>;
  };
  initDbSpy: ReturnType<typeof vi.spyOn>;
  loadFromStorageSpy: ReturnType<typeof vi.spyOn>;
  saveToStorageSpy: ReturnType<typeof vi.spyOn>;
  releaseLeaseMock: ReturnType<typeof vi.fn>;
  syncWriterLeaseMock: {
    isFeatureEnabled: ReturnType<typeof vi.fn>;
    requestLease: ReturnType<typeof vi.fn>;
  };
  sentryLazyLoaderMock: {
    captureMessage: ReturnType<typeof vi.fn>;
    captureException: ReturnType<typeof vi.fn>;
    setTag: ReturnType<typeof vi.fn>;
    setContext: ReturnType<typeof vi.fn>;
  };
  destroy: () => Promise<void>;
  teardown: () => Promise<void>;
  setOnline: (value: boolean) => void;
}

export interface RetryQueueServiceSpecHarnessOptions {
  initDb?: () => Promise<IDBDatabase | null>;
  loadFromStorage?: () => Promise<void>;
  clearLocalStorage?: boolean;
  useRealLoadFromStorage?: boolean;
}

type RetryQueueServiceSpecMocks = Pick<
  RetryQueueServiceSpecHarness,
  | 'authServiceMock'
  | 'blackBoxSyncMock'
  | 'loggerCategory'
  | 'projectStateMock'
  | 'releaseLeaseMock'
  | 'sentryLazyLoaderMock'
  | 'syncWriterLeaseMock'
  | 'toastMock'
> & {
  destroy: () => void;
  destroyRefMock: Pick<DestroyRef, 'onDestroy'>;
};

export function createRetryQueueServiceSpecHarness(
  options: RetryQueueServiceSpecHarnessOptions = {},
): RetryQueueServiceSpecHarness {
  resetRetryQueueServiceSpecEnvironment();
  resetRetryQueueSpecUuidCache();
  if (options.clearLocalStorage !== false) localStorage.clear();

  let online = false;
  const mocks = createRetryQueueServiceSpecMocks();
  const { initDbSpy, loadFromStorageSpy } = createRetryQueueStorageSpies(options);
  const injector = createRetryQueueServiceSpecInjector(mocks);
  const { service, storageInitializationPromise } = createRetryQueueServiceInstance(injector);
  const { destroy, teardown } = createRetryQueueDestroyLifecycle(
    service,
    injector,
    mocks,
    storageInitializationPromise,
  );
  const saveToStorageSpy = vi.spyOn(
    service as unknown as { saveToStorage: () => Promise<void> },
    'saveToStorage',
  ).mockResolvedValue(undefined);
  const handler = createRetryQueueOperationHandler(() => online);
  service.setOperationHandler(handler);

  return {
    service,
    loggerCategory: mocks.loggerCategory,
    handler,
    authServiceMock: mocks.authServiceMock,
    projectStateMock: mocks.projectStateMock,
    toastMock: mocks.toastMock,
    blackBoxSyncMock: mocks.blackBoxSyncMock,
    initDbSpy,
    loadFromStorageSpy,
    saveToStorageSpy,
    releaseLeaseMock: mocks.releaseLeaseMock,
    syncWriterLeaseMock: mocks.syncWriterLeaseMock,
    sentryLazyLoaderMock: mocks.sentryLazyLoaderMock,
    destroy,
    teardown,
    setOnline: (value: boolean) => {
      online = value;
    },
  };
}

function createRetryQueueServiceInstance(injector: Injector): {
  service: RetryQueueService;
  storageInitializationPromise: Promise<void>;
} {
  const storageInitialization = captureRetryQueueStorageInitialization();
  let service: RetryQueueService;
  try {
    service = runInInjectionContext(
      injector,
      () => injector.get(RetryQueueService),
    );
  } finally {
    storageInitialization.restore();
  }
  return {
    service,
    storageInitializationPromise: storageInitialization.promise(),
  };
}

function createRetryQueueDestroyLifecycle(
  service: RetryQueueService,
  injector: Injector,
  mocks: RetryQueueServiceSpecMocks,
  storageInitializationPromise: Promise<void>,
): Pick<RetryQueueServiceSpecHarness, 'destroy' | 'teardown'> {
  let destroyFlushPromise: Promise<void> | null = null;
  const serviceWithDestroyFlush = service as unknown as {
    flushStorageOnDestroy: () => Promise<void>;
  };
  const flushStorageOnDestroy = serviceWithDestroyFlush.flushStorageOnDestroy.bind(service);
  vi.spyOn(serviceWithDestroyFlush, 'flushStorageOnDestroy').mockImplementation(() => {
    destroyFlushPromise = flushStorageOnDestroy();
    return destroyFlushPromise;
  });
  let destroyPromise: Promise<void> | null = null;
  const destroy = () => {
    if (!destroyPromise) {
      (injector as unknown as { destroy?: () => void }).destroy?.();
      mocks.destroy();
      destroyPromise = Promise.all([
        storageInitializationPromise,
        destroyFlushPromise ?? Promise.resolve(),
      ]).then(() => undefined);
    }
    return destroyPromise;
  };
  const teardown = () => {
    if (!destroyPromise) {
      vi.spyOn(service, 'persistNow').mockResolvedValue(true);
    }
    return destroy();
  };

  return { destroy, teardown };
}

function captureRetryQueueStorageInitialization(): {
  promise: () => Promise<void>;
  restore: () => void;
} {
  const prototype = RetryQueueService.prototype as unknown as {
    initializeStorageLoad: () => Promise<void>;
  };
  const initializeStorageLoad = prototype.initializeStorageLoad;
  let captured: Promise<void> | null = null;
  const spy = vi.spyOn(prototype, 'initializeStorageLoad').mockImplementation(function (
    this: RetryQueueService,
  ) {
    captured = initializeStorageLoad.call(this);
    return captured;
  });
  return {
    promise: () => captured ?? Promise.resolve(),
    restore: () => spy.mockRestore(),
  };
}

export function resetRetryQueueServiceSpecEnvironment(): void {
  setVisibilityState('visible');
  resetBrowserNetworkSuspensionTrackingForTests();
}

function createRetryQueueServiceSpecMocks(): RetryQueueServiceSpecMocks {
  const loggerCategory = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const toastMock = {
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  };
  const sentryLazyLoaderMock = {
    captureMessage: vi.fn(),
    captureException: vi.fn(),
    setTag: vi.fn(),
    setContext: vi.fn(),
  };
  const authServiceMock = {
    currentUserId: vi.fn((): string | null => 'test-user'),
    peekPersistedOwnerHint: vi.fn((): string | null => null),
    peekPersistedSessionIdentity: vi.fn((): {
      userId: string;
      email: string | null;
    } | null => null),
  };
  const projectStateMock = {
    getProject: vi.fn((): Record<string, string> | undefined => undefined),
  };
  const blackBoxSyncMock = {
    markEntrySyncConflict: vi.fn().mockResolvedValue(undefined),
  };
  const { destroy, destroyRefMock } = createRetryQueueDestroyRefMock();
  const { releaseLeaseMock, syncWriterLeaseMock } =
    createRetryQueueSyncWriterLeaseMock();

  return {
    authServiceMock,
    blackBoxSyncMock,
    destroy,
    destroyRefMock,
    loggerCategory,
    projectStateMock,
    releaseLeaseMock,
    sentryLazyLoaderMock,
    syncWriterLeaseMock,
    toastMock,
  };
}

function createRetryQueueDestroyRefMock(): Pick<
  RetryQueueServiceSpecMocks,
  'destroy' | 'destroyRefMock'
> {
  const destroyCallbacks: Array<() => void> = [];
  const destroyRefMock: Pick<DestroyRef, 'onDestroy'> = {
    onDestroy: (callback: () => void) => {
      destroyCallbacks.push(callback);
      return () => {};
    },
  };
  const destroy = () => {
    const callbacks = destroyCallbacks.splice(0);
    for (const callback of callbacks) {
      callback();
    }
  };

  return { destroy, destroyRefMock };
}

function createRetryQueueSyncWriterLeaseMock(): Pick<
  RetryQueueServiceSpecHarness,
  'releaseLeaseMock' | 'syncWriterLeaseMock'
> {
  const releaseLeaseMock = vi.fn(async () => undefined);
  const syncWriterLeaseMock = {
    isFeatureEnabled: vi.fn(() => false),
    requestLease: vi.fn(async () => ({
      tabId: 'tab-test',
      lockName: 'nanoflow-sync:test:test-user:__global__',
      mode: 'memory-only' as const,
      release: releaseLeaseMock,
    })),
  };

  return { releaseLeaseMock, syncWriterLeaseMock };
}

function createRetryQueueStorageSpies(
  options: RetryQueueServiceSpecHarnessOptions,
): Pick<
  RetryQueueServiceSpecHarness,
  'initDbSpy' | 'loadFromStorageSpy'
> {
  const initDbSpy = vi.spyOn(RetryQueueService.prototype as unknown as {
    initDb: () => Promise<IDBDatabase | null>;
  }, 'initDb').mockImplementation(options.initDb ?? (async () => null));
  const loadFromStorageSpy = vi.spyOn(RetryQueueService.prototype as unknown as {
    loadFromStorage: () => Promise<void>;
  }, 'loadFromStorage');
  if (options.useRealLoadFromStorage !== true) {
    loadFromStorageSpy.mockImplementation(options.loadFromStorage ?? (async () => undefined));
  }

  return { initDbSpy, loadFromStorageSpy };
}

function createRetryQueueServiceSpecInjector(
  mocks: RetryQueueServiceSpecMocks,
): Injector {
  return Injector.create({
    providers: [
      { provide: RetryQueueService, useClass: RetryQueueService },
      {
        provide: LoggerService,
        useValue: {
          category: vi.fn().mockReturnValue(mocks.loggerCategory),
        },
      },
      { provide: ToastService, useValue: mocks.toastMock },
      { provide: AuthService, useValue: mocks.authServiceMock },
      { provide: ProjectStateService, useValue: mocks.projectStateMock },
      { provide: BlackBoxSyncService, useValue: mocks.blackBoxSyncMock },
      { provide: SyncWriterLeaseService, useValue: mocks.syncWriterLeaseMock },
      {
        provide: SentryLazyLoaderService,
        useValue: mocks.sentryLazyLoaderMock,
      },
      { provide: DestroyRef, useValue: mocks.destroyRefMock },
    ],
  });
}

function createRetryQueueOperationHandler(
  isOnline: () => boolean,
): RetryOperationHandler {
  return {
    pushTask: vi.fn().mockResolvedValue(true),
    deleteTask: vi.fn().mockResolvedValue(true),
    pushProject: vi.fn().mockResolvedValue(true),
    pushConnection: vi.fn().mockResolvedValue(true),
    pushBlackBoxEntry: vi.fn().mockResolvedValue(true),
    isSessionExpired: vi.fn().mockReturnValue(false),
    isOnline: vi.fn(isOnline),
    onProcessingStateChange: vi.fn(),
  };
}
