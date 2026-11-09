import { describe, expect, it, vi } from 'vitest';

import { initializeParkingStartupLifecycle } from './parking-startup-lifecycle.controller';

describe('initializeParkingStartupLifecycle', () => {
  it('registers startup lifecycle hooks and returns removable listeners', () => {
    let visibilityListener: (() => void) | null = null;
    let onlineListener: (() => void) | null = null;
    let visibilityState: DocumentVisibilityState = 'visible';
    const registerBeforeUnload = vi.fn();
    const saveSnapshotToLocalStorage = vi.fn();
    const saveSnapshotToIndexedDB = vi.fn();
    const scheduleParkedDeltaRefresh = vi.fn();
    const initEviction = vi.fn();
    const initParkedLightweightSync = vi.fn().mockResolvedValue(undefined);

    const handles = initializeParkingStartupLifecycle({
      beforeUnloadPriority: 20,
      registerBeforeUnload,
      saveSnapshotToLocalStorage,
      saveSnapshotToIndexedDB,
      scheduleParkedDeltaRefresh,
      initEviction,
      initParkedLightweightSync,
      addDocumentListener: (_eventName, listener) => {
        visibilityListener = listener;
      },
      addWindowListener: (_eventName, listener) => {
        onlineListener = listener;
      },
      readVisibilityState: () => visibilityState,
    });

    expect(registerBeforeUnload).toHaveBeenCalledWith(
      'parking-snapshot',
      saveSnapshotToLocalStorage,
      20,
    );
    expect(initEviction).toHaveBeenCalledTimes(1);
    expect(initParkedLightweightSync).toHaveBeenCalledTimes(1);

    visibilityState = 'hidden';
    const onVisibilityChange = visibilityListener as (() => void) | null;
    const onOnline = onlineListener as (() => void) | null;
    onVisibilityChange?.();
    expect(saveSnapshotToIndexedDB).toHaveBeenCalledTimes(1);
    expect(scheduleParkedDeltaRefresh).not.toHaveBeenCalled();

    visibilityState = 'visible';
    onVisibilityChange?.();
    onOnline?.();

    expect(scheduleParkedDeltaRefresh).toHaveBeenCalledWith('visible');
    expect(scheduleParkedDeltaRefresh).toHaveBeenCalledWith('online');
    expect(handles.visibilityChangeHandler).toBe(visibilityListener);
    expect(handles.parkedSyncOnlineListener).toBe(onlineListener);
  });

  it('contains rejected lightweight sync initialization', () => {
    const catchInitFailure = vi.fn();
    const initParkedLightweightSync = vi.fn(() => ({
      catch: catchInitFailure,
    } as unknown as Promise<void>));

    initializeParkingStartupLifecycle({
      beforeUnloadPriority: 20,
      registerBeforeUnload: vi.fn(),
      saveSnapshotToLocalStorage: vi.fn(),
      saveSnapshotToIndexedDB: vi.fn(),
      scheduleParkedDeltaRefresh: vi.fn(),
      initEviction: vi.fn(),
      initParkedLightweightSync,
      addDocumentListener: vi.fn(),
      addWindowListener: vi.fn(),
    });

    expect(initParkedLightweightSync).toHaveBeenCalledTimes(1);
    expect(catchInitFailure).toHaveBeenCalledTimes(1);
  });

  it('contains synchronous lightweight sync initialization failures', () => {
    const initParkedLightweightSync = vi.fn(() => {
      throw new Error('lightweight sync failed');
    });

    expect(() => initializeParkingStartupLifecycle({
      beforeUnloadPriority: 20,
      registerBeforeUnload: vi.fn(),
      saveSnapshotToLocalStorage: vi.fn(),
      saveSnapshotToIndexedDB: vi.fn(),
      scheduleParkedDeltaRefresh: vi.fn(),
      initEviction: vi.fn(),
      initParkedLightweightSync,
      addDocumentListener: vi.fn(),
      addWindowListener: vi.fn(),
    })).not.toThrow();

    expect(initParkedLightweightSync).toHaveBeenCalledTimes(1);
  });

  it('contains synchronous eviction initialization failures without blocking lightweight sync', () => {
    let visibilityListener: (() => void) | null = null;
    let onlineListener: (() => void) | null = null;
    const initEviction = vi.fn(() => {
      throw new Error('eviction init failed');
    });
    const initParkedLightweightSync = vi.fn().mockResolvedValue(undefined);

    expect(() => initializeParkingStartupLifecycle({
      beforeUnloadPriority: 20,
      registerBeforeUnload: vi.fn(),
      saveSnapshotToLocalStorage: vi.fn(),
      saveSnapshotToIndexedDB: vi.fn(),
      scheduleParkedDeltaRefresh: vi.fn(),
      initEviction,
      initParkedLightweightSync,
      addDocumentListener: (_eventName, listener) => {
        visibilityListener = listener;
      },
      addWindowListener: (_eventName, listener) => {
        onlineListener = listener;
      },
    })).not.toThrow();

    expect(initEviction).toHaveBeenCalledTimes(1);
    expect(initParkedLightweightSync).toHaveBeenCalledTimes(1);
    expect(visibilityListener).toEqual(expect.any(Function));
    expect(onlineListener).toEqual(expect.any(Function));
  });

  it('contains beforeunload registration failures without blocking startup listeners', () => {
    let visibilityListener: (() => void) | null = null;
    let onlineListener: (() => void) | null = null;
    const initEviction = vi.fn();
    const initParkedLightweightSync = vi.fn().mockResolvedValue(undefined);

    expect(() => initializeParkingStartupLifecycle({
      beforeUnloadPriority: 20,
      registerBeforeUnload: vi.fn(() => {
        throw new Error('beforeunload unavailable');
      }),
      saveSnapshotToLocalStorage: vi.fn(),
      saveSnapshotToIndexedDB: vi.fn(),
      scheduleParkedDeltaRefresh: vi.fn(),
      initEviction,
      initParkedLightweightSync,
      addDocumentListener: (_eventName, listener) => {
        visibilityListener = listener;
      },
      addWindowListener: (_eventName, listener) => {
        onlineListener = listener;
      },
    })).not.toThrow();

    expect(initEviction).toHaveBeenCalledTimes(1);
    expect(initParkedLightweightSync).toHaveBeenCalledTimes(1);
    expect(visibilityListener).toEqual(expect.any(Function));
    expect(onlineListener).toEqual(expect.any(Function));
  });

  it('contains document listener registration failures without blocking online listener startup', () => {
    let onlineListener: (() => void) | null = null;
    const initEviction = vi.fn();
    const initParkedLightweightSync = vi.fn().mockResolvedValue(undefined);

    expect(() => initializeParkingStartupLifecycle({
      beforeUnloadPriority: 20,
      registerBeforeUnload: vi.fn(),
      saveSnapshotToLocalStorage: vi.fn(),
      saveSnapshotToIndexedDB: vi.fn(),
      scheduleParkedDeltaRefresh: vi.fn(),
      initEviction,
      initParkedLightweightSync,
      addDocumentListener: () => {
        throw new Error('visibility listener unavailable');
      },
      addWindowListener: (_eventName, listener) => {
        onlineListener = listener;
      },
    })).not.toThrow();

    expect(initEviction).toHaveBeenCalledTimes(1);
    expect(initParkedLightweightSync).toHaveBeenCalledTimes(1);
    expect(onlineListener).toEqual(expect.any(Function));
  });

  it('contains rejected IndexedDB snapshot writes on hidden visibility', () => {
    let visibilityListener: (() => void) | null = null;
    const catchPersistFailure = vi.fn();
    const saveSnapshotToIndexedDB = vi.fn(() => ({
      catch: catchPersistFailure,
    } as unknown as Promise<void>));

    initializeParkingStartupLifecycle({
      beforeUnloadPriority: 20,
      registerBeforeUnload: vi.fn(),
      saveSnapshotToLocalStorage: vi.fn(),
      saveSnapshotToIndexedDB,
      scheduleParkedDeltaRefresh: vi.fn(),
      initEviction: vi.fn(),
      initParkedLightweightSync: vi.fn().mockResolvedValue(undefined),
      addDocumentListener: (_eventName, listener) => {
        visibilityListener = listener;
      },
      addWindowListener: vi.fn(),
      readVisibilityState: () => 'hidden',
    });

    const onVisibilityChange = visibilityListener as (() => void) | null;
    onVisibilityChange?.();

    expect(saveSnapshotToIndexedDB).toHaveBeenCalledTimes(1);
    expect(catchPersistFailure).toHaveBeenCalledTimes(1);
  });

  it('contains synchronous IndexedDB snapshot failures on hidden visibility', () => {
    let visibilityListener: (() => void) | null = null;
    const saveSnapshotToIndexedDB = vi.fn(() => {
      throw new Error('snapshot failed');
    });

    initializeParkingStartupLifecycle({
      beforeUnloadPriority: 20,
      registerBeforeUnload: vi.fn(),
      saveSnapshotToLocalStorage: vi.fn(),
      saveSnapshotToIndexedDB,
      scheduleParkedDeltaRefresh: vi.fn(),
      initEviction: vi.fn(),
      initParkedLightweightSync: vi.fn().mockResolvedValue(undefined),
      addDocumentListener: (_eventName, listener) => {
        visibilityListener = listener;
      },
      addWindowListener: vi.fn(),
      readVisibilityState: () => 'hidden',
    });

    const onVisibilityChange = visibilityListener as (() => void) | null;
    expect(() => onVisibilityChange?.()).not.toThrow();

    expect(saveSnapshotToIndexedDB).toHaveBeenCalledTimes(1);
  });

  it('contains synchronous parked refresh failures on visible visibility', () => {
    let visibilityListener: (() => void) | null = null;
    const scheduleParkedDeltaRefresh = vi.fn(() => {
      throw new Error('visible refresh failed');
    });

    initializeParkingStartupLifecycle({
      beforeUnloadPriority: 20,
      registerBeforeUnload: vi.fn(),
      saveSnapshotToLocalStorage: vi.fn(),
      saveSnapshotToIndexedDB: vi.fn(),
      scheduleParkedDeltaRefresh,
      initEviction: vi.fn(),
      initParkedLightweightSync: vi.fn().mockResolvedValue(undefined),
      addDocumentListener: (_eventName, listener) => {
        visibilityListener = listener;
      },
      addWindowListener: vi.fn(),
      readVisibilityState: () => 'visible',
    });

    const onVisibilityChange = visibilityListener as (() => void) | null;
    expect(() => onVisibilityChange?.()).not.toThrow();

    expect(scheduleParkedDeltaRefresh).toHaveBeenCalledWith('visible');
  });

  it('contains synchronous parked refresh failures on online events', () => {
    let onlineListener: (() => void) | null = null;
    const scheduleParkedDeltaRefresh = vi.fn(() => {
      throw new Error('online refresh failed');
    });

    initializeParkingStartupLifecycle({
      beforeUnloadPriority: 20,
      registerBeforeUnload: vi.fn(),
      saveSnapshotToLocalStorage: vi.fn(),
      saveSnapshotToIndexedDB: vi.fn(),
      scheduleParkedDeltaRefresh,
      initEviction: vi.fn(),
      initParkedLightweightSync: vi.fn().mockResolvedValue(undefined),
      addDocumentListener: vi.fn(),
      addWindowListener: (_eventName, listener) => {
        onlineListener = listener;
      },
    });

    const onOnline = onlineListener as (() => void) | null;
    expect(() => onOnline?.()).not.toThrow();

    expect(scheduleParkedDeltaRefresh).toHaveBeenCalledWith('online');
  });
});
