import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimePollingService } from '../core-bridge';
import { setVisibilityState } from './app-lifecycle-orchestrator.test-harness';
import { AppLifecycleBrowserEventsCoordinator } from './app-lifecycle-browser-events.coordinator';
import { LoggerService } from './logger.service';

interface ListenerTarget {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  dispatchEvent(type: string): void;
  listenerCount(type: string): number;
}

function createListenerTarget(): ListenerTarget {
  const listeners = new Map<string, Set<EventListener>>();

  return {
    addEventListener(type: string, listener: EventListener): void {
      const current = listeners.get(type) ?? new Set<EventListener>();
      current.add(listener);
      listeners.set(type, current);
    },
    removeEventListener(type: string, listener: EventListener): void {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent(type: string): void {
      for (const listener of listeners.get(type) ?? []) {
        listener(new Event(type));
      }
    },
    listenerCount(type: string): number {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

describe('AppLifecycleBrowserEventsCoordinator', () => {
  let coordinator: AppLifecycleBrowserEventsCoordinator;
  let suspendTransport: ReturnType<typeof vi.fn>;
  let loggerCategory: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };

  const flushPromises = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };

  beforeEach(() => {
    setVisibilityState('visible');
    suspendTransport = vi.fn().mockResolvedValue(undefined);
    loggerCategory = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        AppLifecycleBrowserEventsCoordinator,
        {
          provide: RealtimePollingService,
          useValue: {
            suspendTransport,
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn().mockReturnValue(loggerCategory),
          },
        },
      ],
    });

    coordinator = TestBed.inject(AppLifecycleBrowserEventsCoordinator);
  });

  afterEach(() => {
    coordinator.cleanup();
    setVisibilityState('visible');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('contains suspendTransport rejection during hidden transition', async () => {
    const error = new Error('transport closed');
    suspendTransport.mockRejectedValueOnce(error);

    coordinator.initialize(vi.fn());
    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();

    expect(suspendTransport).toHaveBeenCalledTimes(1);
    expect(loggerCategory.warn).toHaveBeenCalledWith(
      'Lifecycle transport suspension failed',
      { error },
    );
  });

  it('contains synchronous suspendTransport failure during hidden transition', async () => {
    const error = new Error('transport unavailable');
    suspendTransport.mockImplementationOnce(() => {
      throw error;
    });

    coordinator.initialize(vi.fn());
    setVisibilityState('hidden');

    expect(() => document.dispatchEvent(new Event('visibilitychange'))).not.toThrow();
    await flushPromises();

    expect(suspendTransport).toHaveBeenCalledOnce();
    expect(loggerCategory.warn).toHaveBeenCalledWith(
      'Lifecycle transport suspension failed',
      { error },
    );
  });

  it('ignores in-flight suspendTransport rejection after cleanup', async () => {
    const error = new Error('late transport suspension failure');
    let rejectSuspend: ((error: unknown) => void) | null = null;
    suspendTransport.mockReturnValueOnce(
      new Promise<void>((_, reject) => {
        rejectSuspend = reject;
      })
    );

    coordinator.initialize(vi.fn());
    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(suspendTransport).toHaveBeenCalledOnce();
    expect(rejectSuspend).toBeTypeOf('function');

    coordinator.cleanup();
    rejectSuspend!(error);
    await flushPromises();

    expect(loggerCategory.warn).not.toHaveBeenCalled();
  });

  it('keeps initialize idempotent without replacing the active resume callback', () => {
    const firstResume = vi.fn();
    const secondResume = vi.fn();

    expect(coordinator.initialize(firstResume)).toBe(true);
    expect(coordinator.initialize(secondResume)).toBe(false);

    window.dispatchEvent(new Event('online'));

    expect(firstResume).toHaveBeenCalledOnce();
    expect(firstResume).toHaveBeenCalledWith('online');
    expect(secondResume).not.toHaveBeenCalled();
  });

  it('keeps lifecycle listeners active when initialization logging fails', () => {
    const triggerResume = vi.fn();
    loggerCategory.info.mockImplementationOnce(() => {
      throw new Error('logger info sink failed');
    });

    expect(() => coordinator.initialize(triggerResume)).not.toThrow();
    expect(coordinator.initialize(vi.fn())).toBe(false);

    window.dispatchEvent(new Event('online'));

    expect(triggerResume).toHaveBeenCalledOnce();
    expect(triggerResume).toHaveBeenCalledWith('online');
  });

  it('contains synchronous resume callback failures from browser events', () => {
    const error = new Error('resume callback failed');
    const triggerResume = vi.fn(() => {
      throw error;
    });

    coordinator.initialize(triggerResume);

    expect(() => window.dispatchEvent(new Event('online'))).not.toThrow();
    expect(triggerResume).toHaveBeenCalledWith('online');
    expect(loggerCategory.warn).toHaveBeenCalledWith(
      'Lifecycle resume trigger failed',
      { reason: 'online', error },
    );
  });

  it('contains async resume callback rejection after browser events', async () => {
    const error = new Error('resume callback rejected');
    const triggerResume = vi.fn().mockRejectedValue(error);

    coordinator.initialize(triggerResume);
    window.dispatchEvent(new Event('online'));
    await flushPromises();

    expect(triggerResume).toHaveBeenCalledWith('online');
    expect(loggerCategory.warn).toHaveBeenCalledWith(
      'Lifecycle resume trigger failed',
      { reason: 'online', error },
    );
  });

  it('deduplicates repeated online resume events while the previous trigger is still pending', async () => {
    let resolveResume: (() => void) | null = null;
    const triggerResume = vi.fn(() => new Promise<void>(resolve => {
      resolveResume = resolve;
    }));

    coordinator.initialize(triggerResume);
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('online'));
    await flushPromises();

    expect(triggerResume).toHaveBeenCalledTimes(1);
    expect(triggerResume).toHaveBeenCalledWith('online');

    resolveResume!();
    await flushPromises();
    window.dispatchEvent(new Event('online'));

    expect(triggerResume).toHaveBeenCalledTimes(2);
  });

  it('drops lower-priority resume reasons while a higher-priority trigger is pending', async () => {
    let resolveResume: (() => void) | null = null;
    const triggerResume = vi.fn(() => new Promise<void>(resolve => {
      resolveResume = resolve;
    }));
    let nowMs = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const pageShow = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(pageShow, 'persisted', { value: true });

    coordinator.initialize(triggerResume);
    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    nowMs = 6_000;
    setVisibilityState('visible');
    window.dispatchEvent(pageShow);
    window.dispatchEvent(new Event('online'));
    await flushPromises();

    expect(triggerResume).toHaveBeenCalledTimes(1);
    expect(triggerResume).toHaveBeenCalledWith('pageshow');

    resolveResume!();
    await flushPromises();
    window.dispatchEvent(new Event('online'));

    expect(triggerResume).toHaveBeenCalledTimes(2);
    expect(triggerResume).toHaveBeenLastCalledWith('online');
  });

  it('forwards higher-priority pageshow while quick visibility resume is pending', async () => {
    let resolveQuickResume: (() => void) | null = null;
    const triggerResume = vi.fn((reason: string) => {
      if (reason === 'visibility-quick') {
        return new Promise<void>(resolve => {
          resolveQuickResume = resolve;
        });
      }
      return undefined;
    });
    let nowMs = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const pageShow = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(pageShow, 'persisted', { value: true });

    coordinator.initialize(triggerResume);
    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    nowMs = 1_100;
    setVisibilityState('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(pageShow);
    await flushPromises();

    expect(triggerResume).toHaveBeenCalledTimes(2);
    expect(triggerResume).toHaveBeenNthCalledWith(1, 'visibility-quick');
    expect(triggerResume).toHaveBeenNthCalledWith(2, 'pageshow');

    resolveQuickResume!();
    await flushPromises();
  });

  it('does not trigger resume events after cleanup', () => {
    const triggerResume = vi.fn();
    coordinator.initialize(triggerResume);

    coordinator.cleanup();
    window.dispatchEvent(new Event('online'));

    expect(triggerResume).not.toHaveBeenCalled();
  });

  it('resets background duration snapshot during cleanup', () => {
    const triggerResume = vi.fn();
    let nowMs = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    coordinator.initialize(triggerResume);
    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    nowMs = 6_000;
    setVisibilityState('visible');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(coordinator.getLastBackgroundDurationMs()).toBe(5_000);

    coordinator.cleanup();

    expect(coordinator.getLastBackgroundDurationMs()).toBe(0);
  });

  it('continues cleanup when one browser listener removal throws', () => {
    const triggerResume = vi.fn();
    const removalError = new Error('visibility listener already removed');
    const removeDocumentListener = vi
      .spyOn(document, 'removeEventListener')
      .mockImplementationOnce(() => {
        throw removalError;
      });
    const removeWindowListener = vi.spyOn(window, 'removeEventListener');

    coordinator.initialize(triggerResume);
    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(coordinator.getLastBackgroundDurationMs()).toBe(0);
    expect(() => coordinator.cleanup()).not.toThrow();

    expect(removeDocumentListener).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function),
    );
    for (const event of ['blur', 'focus', 'pageshow', 'online']) {
      expect(removeWindowListener).toHaveBeenCalledWith(event, expect.any(Function));
    }
    expect(coordinator.getLastBackgroundDurationMs()).toBe(0);
    expect(loggerCategory.warn).toHaveBeenCalledWith(
      'Lifecycle browser listener cleanup failed',
      { error: removalError },
    );
  });

  it('continues cleanup when listener removal and warning sink both fail', () => {
    const triggerResume = vi.fn();
    const removalError = new Error('visibility listener already removed');
    const warningError = new Error('logger sink unavailable');
    const removeDocumentListener = vi
      .spyOn(document, 'removeEventListener')
      .mockImplementationOnce(() => {
        throw removalError;
      });
    const removeWindowListener = vi.spyOn(window, 'removeEventListener');
    loggerCategory.warn.mockImplementationOnce(() => {
      throw warningError;
    });

    coordinator.initialize(triggerResume);

    expect(() => coordinator.cleanup()).not.toThrow();

    expect(removeDocumentListener).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function),
    );
    for (const event of ['blur', 'focus', 'pageshow', 'online']) {
      expect(removeWindowListener).toHaveBeenCalledWith(event, expect.any(Function));
    }
  });

  it('ignores stale browser events when listener removal fails during cleanup', () => {
    const triggerResume = vi.fn();
    const removalError = new Error('visibility listener still attached');
    vi.spyOn(document, 'removeEventListener').mockImplementationOnce(() => {
      throw removalError;
    });

    coordinator.initialize(triggerResume);
    coordinator.cleanup();

    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));

    expect(suspendTransport).not.toHaveBeenCalled();
    expect(triggerResume).not.toHaveBeenCalled();
  });

  it('rolls back already registered browser listeners when initialization fails midway', () => {
    const triggerResume = vi.fn();
    const initializationError = new Error('focus listener rejected');
    const addDocumentListener = vi.spyOn(document, 'addEventListener');
    const removeDocumentListener = vi.spyOn(document, 'removeEventListener');
    const originalAddWindowListener = window.addEventListener.bind(window);
    const addWindowListener = vi
      .spyOn(window, 'addEventListener')
      .mockImplementation((eventName, listener, options) => {
        if (eventName === 'focus') {
          throw initializationError;
        }
        return originalAddWindowListener(eventName, listener, options);
      });
    const removeWindowListener = vi.spyOn(window, 'removeEventListener');

    expect(() => coordinator.initialize(triggerResume)).toThrow(initializationError);

    expect(addDocumentListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(addWindowListener).toHaveBeenCalledWith('blur', expect.any(Function));
    expect(removeDocumentListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(removeWindowListener).toHaveBeenCalledWith('blur', expect.any(Function));

    addWindowListener.mockRestore();
    expect(coordinator.initialize(triggerResume)).toBe(true);
    window.dispatchEvent(new Event('online'));
    expect(triggerResume).toHaveBeenCalledWith('online');
  });

  it('cleans listeners from the exact original Window/Document targets after globals are replaced', () => {
    const triggerResume = vi.fn();
    const originalDocument = createListenerTarget();
    const originalWindow = createListenerTarget();
    vi.stubGlobal('document', originalDocument);
    vi.stubGlobal('window', originalWindow);

    expect(coordinator.initialize(triggerResume)).toBe(true);

    const replacementDocument = createListenerTarget();
    const replacementWindow = createListenerTarget();
    vi.stubGlobal('document', replacementDocument);
    vi.stubGlobal('window', replacementWindow);

    coordinator.cleanup();

    expect(originalDocument.listenerCount('visibilitychange')).toBe(0);
    expect(originalWindow.listenerCount('blur')).toBe(0);
    expect(originalWindow.listenerCount('focus')).toBe(0);
    expect(originalWindow.listenerCount('pageshow')).toBe(0);
    expect(originalWindow.listenerCount('online')).toBe(0);
    expect(replacementDocument.listenerCount('visibilitychange')).toBe(0);
    expect(replacementWindow.listenerCount('blur')).toBe(0);
    expect(replacementWindow.listenerCount('focus')).toBe(0);
    expect(replacementWindow.listenerCount('pageshow')).toBe(0);
    expect(replacementWindow.listenerCount('online')).toBe(0);
  });

  it('reinitializes replacement targets once without inheriting stale original activity', () => {
    const firstResume = vi.fn();
    const originalDocument = createListenerTarget();
    const originalWindow = createListenerTarget();
    vi.stubGlobal('document', originalDocument);
    vi.stubGlobal('window', originalWindow);

    expect(coordinator.initialize(firstResume)).toBe(true);

    const replacementDocument = createListenerTarget();
    const replacementWindow = createListenerTarget();
    vi.stubGlobal('document', replacementDocument);
    vi.stubGlobal('window', replacementWindow);

    coordinator.cleanup();
    expect(coordinator.initialize(firstResume)).toBe(true);

    expect(originalDocument.listenerCount('visibilitychange')).toBe(0);
    expect(originalWindow.listenerCount('online')).toBe(0);
    expect(replacementDocument.listenerCount('visibilitychange')).toBe(1);
    expect(replacementWindow.listenerCount('online')).toBe(1);

    originalWindow.dispatchEvent('online');
    expect(firstResume).not.toHaveBeenCalled();
    replacementWindow.dispatchEvent('online');
    expect(firstResume).toHaveBeenCalledOnce();
    expect(firstResume).toHaveBeenCalledWith('online');

    expect(coordinator.initialize(firstResume)).toBe(false);
    expect(replacementDocument.listenerCount('visibilitychange')).toBe(1);
    expect(replacementWindow.listenerCount('online')).toBe(1);
  });

  it('rolls back partial registration from captured original targets when globals change mid-failure', () => {
    const triggerResume = vi.fn();
    const initializationError = new Error('pageshow listener rejected');
    const originalDocument = createListenerTarget();
    const originalWindow = createListenerTarget();
    vi.stubGlobal('document', originalDocument);
    vi.stubGlobal('window', originalWindow);

    const originalAddEventListener = originalWindow.addEventListener;
    originalWindow.addEventListener = ((type: string, listener: EventListener) => {
      if (type === 'pageshow') {
        vi.stubGlobal('document', createListenerTarget());
        vi.stubGlobal('window', createListenerTarget());
        throw initializationError;
      }
      originalAddEventListener(type, listener);
    }) as typeof originalWindow.addEventListener;

    expect(() => coordinator.initialize(triggerResume)).toThrow(initializationError);

    const replacementDocument = (globalThis as unknown as { document: ListenerTarget }).document;
    const replacementWindow = (globalThis as unknown as { window: ListenerTarget }).window;

    expect(originalDocument.listenerCount('visibilitychange')).toBe(0);
    expect(originalWindow.listenerCount('blur')).toBe(0);
    expect(replacementDocument.listenerCount('visibilitychange')).toBe(0);
    expect(replacementWindow.listenerCount('blur')).toBe(0);
  });

  it('suspends transport only once during a continuous hidden session', () => {
    coordinator.initialize(vi.fn());
    setVisibilityState('hidden');

    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));

    expect(suspendTransport).toHaveBeenCalledOnce();
  });

  it('does not emit a second visibility resume after a persisted pageshow handled the hidden session', () => {
    const triggerResume = vi.fn();
    let nowMs = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const pageShow = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(pageShow, 'persisted', { value: true });

    coordinator.initialize(triggerResume);
    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    nowMs = 6_000;
    setVisibilityState('visible');
    window.dispatchEvent(pageShow);
    document.dispatchEvent(new Event('visibilitychange'));

    expect(triggerResume).toHaveBeenCalledTimes(1);
    expect(triggerResume).toHaveBeenCalledWith('pageshow');
  });
});
