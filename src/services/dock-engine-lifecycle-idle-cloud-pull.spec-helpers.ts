import { TestBed } from '@angular/core/testing';
import { expect, it, vi } from 'vitest';

import {
  DockEngineLifecycleService,
  type DockEngineLifecycleContext,
} from './dock-engine-lifecycle.service';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface DockEngineLifecycleIdleCloudPullSpecContext {
  getService: () => DockEngineLifecycleService;
  createContext: (currentSnapshotUserId: string | null) => DockEngineLifecycleContext;
  createDeferred: <T>() => Deferred<T>;
  flushEffects: () => Promise<void>;
  mockSnapshotPersistence: {
    restoreLocalSnapshot: ReturnType<typeof vi.fn>;
  };
  mockCloudSync: {
    scheduleCloudPull: ReturnType<typeof vi.fn>;
  };
}

export function registerDockEngineLifecycleIdleCloudPullSpecs(
  context: DockEngineLifecycleIdleCloudPullSpecContext,
): void {
  const {
    createContext,
    createDeferred,
    flushEffects,
    getService,
    mockCloudSync,
    mockSnapshotPersistence,
  } = context;

  it('restoreInitialSnapshot 应在本地 restore 完成后才触发 idle cloud pull', async () => {
    const service = getService();
    const lifecycleContext = createContext('user-a');
    const initialRestore = createDeferred<null>();
    const hadRequestIdleCallback = 'requestIdleCallback' in window;
    const originalRequestIdleCallback = (window as Window & {
      requestIdleCallback?: (cb: () => void) => number;
    }).requestIdleCallback;
    let idleCallback: (() => void) | null = null;
    (window as Window & {
      requestIdleCallback?: (cb: () => void) => number;
    }).requestIdleCallback = vi.fn((cb: () => void) => {
      idleCallback = cb;
      return 1;
    });
    mockSnapshotPersistence.restoreLocalSnapshot.mockImplementationOnce(() => initialRestore.promise);
    service.init(lifecycleContext);

    try {
      service.restoreInitialSnapshot();
      await flushEffects();

      expect(mockCloudSync.scheduleCloudPull).not.toHaveBeenCalled();

      initialRestore.resolve(null);
      await flushEffects();

      expect(mockCloudSync.scheduleCloudPull).not.toHaveBeenCalled();
      expect(idleCallback).not.toBeNull();

      idleCallback!();

      expect(mockCloudSync.scheduleCloudPull).toHaveBeenCalledTimes(1);
      expect(mockCloudSync.scheduleCloudPull).toHaveBeenCalledWith('user-a', true);
    } finally {
      if (hadRequestIdleCallback) {
        (window as Window & {
          requestIdleCallback?: (cb: () => void) => number;
        }).requestIdleCallback = originalRequestIdleCallback;
      } else {
        delete (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
      }
    }
  });

  it('销毁后 late idle restore 回调不应再调度 cloud pull', async () => {
    const service = getService();
    const lifecycleContext = createContext('user-a');
    const initialRestore = createDeferred<null>();
    const hadRequestIdleCallback = 'requestIdleCallback' in window;
    const originalRequestIdleCallback = (window as Window & {
      requestIdleCallback?: (cb: () => void) => number;
    }).requestIdleCallback;
    let idleCallback: (() => void) | null = null;
    (window as Window & {
      requestIdleCallback?: (cb: () => void) => number;
    }).requestIdleCallback = vi.fn((cb: () => void) => {
      idleCallback = cb;
      return 1;
    });
    mockSnapshotPersistence.restoreLocalSnapshot.mockImplementationOnce(() => initialRestore.promise);
    service.init(lifecycleContext);
    service.registerDestroyCleanup(vi.fn());
    try {
      service.restoreInitialSnapshot();
      await flushEffects();

      initialRestore.resolve(null);
      await flushEffects();
      expect(idleCallback).not.toBeNull();

      TestBed.resetTestingModule();
      idleCallback!();

      expect(mockCloudSync.scheduleCloudPull).not.toHaveBeenCalled();
    } finally {
      if (hadRequestIdleCallback) {
        (window as Window & {
          requestIdleCallback?: (cb: () => void) => number;
        }).requestIdleCallback = originalRequestIdleCallback;
      } else {
        delete (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
      }
    }
  });

  it('销毁时应取消 pending idle cloud pull callback', async () => {
    const service = getService();
    const lifecycleContext = createContext('user-a');
    const initialRestore = createDeferred<null>();
    const hadRequestIdleCallback = 'requestIdleCallback' in window;
    const hadCancelIdleCallback = 'cancelIdleCallback' in window;
    const originalRequestIdleCallback = (window as Window & {
      requestIdleCallback?: (cb: () => void) => number;
    }).requestIdleCallback;
    const originalCancelIdleCallback = (window as Window & {
      cancelIdleCallback?: (handle: number) => void;
    }).cancelIdleCallback;
    (window as Window & {
      requestIdleCallback?: (cb: () => void) => number;
    }).requestIdleCallback = vi.fn(() => 37);
    const cancelIdleCallback = vi.fn();
    (window as Window & {
      cancelIdleCallback?: (handle: number) => void;
    }).cancelIdleCallback = cancelIdleCallback;
    mockSnapshotPersistence.restoreLocalSnapshot.mockImplementationOnce(() => initialRestore.promise);
    service.init(lifecycleContext);
    service.registerDestroyCleanup(vi.fn());

    try {
      service.restoreInitialSnapshot();
      await flushEffects();

      initialRestore.resolve(null);
      await flushEffects();

      expect(cancelIdleCallback).not.toHaveBeenCalled();

      TestBed.resetTestingModule();

      expect(cancelIdleCallback).toHaveBeenCalledWith(37);
      expect(mockCloudSync.scheduleCloudPull).not.toHaveBeenCalled();
    } finally {
      if (hadRequestIdleCallback) {
        (window as Window & {
          requestIdleCallback?: (cb: () => void) => number;
        }).requestIdleCallback = originalRequestIdleCallback;
      } else {
        delete (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
      }
      if (hadCancelIdleCallback) {
        (window as Window & {
          cancelIdleCallback?: (handle: number) => void;
        }).cancelIdleCallback = originalCancelIdleCallback;
      } else {
        delete (window as unknown as { cancelIdleCallback?: (handle: number) => void }).cancelIdleCallback;
      }
    }
  });

  it('cancelIdleCallback 抛错时仍应清理 pending idle cloud pull handle', async () => {
    const service = getService();
    const lifecycleContext = createContext('user-a');
    const initialRestore = createDeferred<null>();
    const idleWindow = window as Window & {
      requestIdleCallback?: (cb: () => void) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const hadRequestIdleCallback = 'requestIdleCallback' in window;
    const hadCancelIdleCallback = 'cancelIdleCallback' in window;
    const originalRequestIdleCallback = idleWindow.requestIdleCallback;
    const originalCancelIdleCallback = idleWindow.cancelIdleCallback;
    idleWindow.requestIdleCallback = vi.fn(() => 37);
    idleWindow.cancelIdleCallback = vi.fn(() => {
      throw new Error('idle cancel failed');
    });
    mockSnapshotPersistence.restoreLocalSnapshot.mockImplementationOnce(() => initialRestore.promise);
    service.init(lifecycleContext);
    service.registerDestroyCleanup(vi.fn());

    try {
      service.restoreInitialSnapshot();
      await flushEffects();

      initialRestore.resolve(null);
      await flushEffects();

      expect((service as unknown as { idleCloudPullHandle: number | null }).idleCloudPullHandle).toBe(37);

      TestBed.resetTestingModule();

      expect((service as unknown as { idleCloudPullHandle: number | null }).idleCloudPullHandle).toBeNull();
      expect(mockCloudSync.scheduleCloudPull).not.toHaveBeenCalled();
    } finally {
      if (hadRequestIdleCallback) {
        idleWindow.requestIdleCallback = originalRequestIdleCallback;
      } else {
        Reflect.deleteProperty(idleWindow, 'requestIdleCallback');
      }
      if (hadCancelIdleCallback) {
        idleWindow.cancelIdleCallback = originalCancelIdleCallback;
      } else {
        Reflect.deleteProperty(idleWindow, 'cancelIdleCallback');
      }
    }
  });

  it('销毁时应取消 pending fallback idle cloud pull timeout', async () => {
    const service = getService();
    vi.useFakeTimers();
    const lifecycleContext = createContext('user-a');
    const initialRestore = createDeferred<null>();
    const hadRequestIdleCallback = 'requestIdleCallback' in window;
    const originalRequestIdleCallback = (window as Window & {
      requestIdleCallback?: (cb: () => void) => number;
    }).requestIdleCallback;
    delete (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    mockSnapshotPersistence.restoreLocalSnapshot.mockImplementationOnce(() => initialRestore.promise);
    service.init(lifecycleContext);
    service.registerDestroyCleanup(vi.fn());

    try {
      service.restoreInitialSnapshot();
      await flushEffects();

      initialRestore.resolve(null);
      await flushEffects();

      TestBed.resetTestingModule();
      vi.runAllTimers();

      expect(mockCloudSync.scheduleCloudPull).not.toHaveBeenCalled();
    } finally {
      if (hadRequestIdleCallback) {
        (window as Window & {
          requestIdleCallback?: (cb: () => void) => number;
        }).requestIdleCallback = originalRequestIdleCallback;
      }
      vi.useRealTimers();
    }
  });
}
