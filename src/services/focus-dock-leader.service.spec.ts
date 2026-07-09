import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FocusDockLeaderService } from './focus-dock-leader.service';
import { LoggerService } from './logger.service';
import { PARKING_CONFIG } from '../config/parking.config';

class MockBroadcastChannel {
  static closeMock = vi.fn();
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(_name: string) {}
  postMessage(_message: unknown): void {}
  close(): void {
    MockBroadcastChannel.closeMock();
  }
}

describe('FocusDockLeaderService', () => {
  const loggerMock = {
    category: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  };
  const originalBroadcastChannel = (globalThis as unknown as {
    BroadcastChannel?: typeof BroadcastChannel;
  }).BroadcastChannel;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    MockBroadcastChannel.closeMock.mockReset();
    (globalThis as unknown as {
      BroadcastChannel?: typeof MockBroadcastChannel;
    }).BroadcastChannel = MockBroadcastChannel;
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    if (originalBroadcastChannel) {
      (globalThis as unknown as {
        BroadcastChannel?: typeof BroadcastChannel;
      }).BroadcastChannel = originalBroadcastChannel;
    } else {
      delete (globalThis as unknown as {
        BroadcastChannel?: typeof BroadcastChannel;
      }).BroadcastChannel;
    }
    vi.restoreAllMocks();
  });

  it('should become leader when no lease exists', () => {
    TestBed.configureTestingModule({
      providers: [
        FocusDockLeaderService,
        { provide: LoggerService, useValue: loggerMock },
      ],
    });

    const service = TestBed.inject(FocusDockLeaderService);
    expect(service.isLeader()).toBe(true);
    expect(service.isReadOnlyFollower()).toBe(false);
  });

  it('should remain follower when another active lease exists', () => {
    localStorage.setItem(
      PARKING_CONFIG.FOCUS_CONSOLE_LEADER_LEASE_KEY,
      JSON.stringify({
        tabId: 'other-tab',
        updatedAt: Date.now(),
        expiresAt: Date.now() + 10000,
      }),
    );

    TestBed.configureTestingModule({
      providers: [
        FocusDockLeaderService,
        { provide: LoggerService, useValue: loggerMock },
      ],
    });

    const service = TestBed.inject(FocusDockLeaderService);
    expect(service.isLeader()).toBe(false);
    expect(service.isReadOnlyFollower()).toBe(true);
  });

  it('should take over leadership when requested', () => {
    localStorage.setItem(
      PARKING_CONFIG.FOCUS_CONSOLE_LEADER_LEASE_KEY,
      JSON.stringify({
        tabId: 'other-tab',
        updatedAt: Date.now(),
        expiresAt: Date.now() + 10000,
      }),
    );

    TestBed.configureTestingModule({
      providers: [
        FocusDockLeaderService,
        { provide: LoggerService, useValue: loggerMock },
      ],
    });

    const service = TestBed.inject(FocusDockLeaderService);
    expect(service.isLeader()).toBe(false);

    expect(service.tryTakeover()).toBe(true);
    expect(service.isLeader()).toBe(true);
  });

  it('should not claim leadership when no durable lease can be written', () => {
    const setItemSpy = vi.spyOn(localStorage, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('quota exceeded', 'QuotaExceededError');
      });

    TestBed.configureTestingModule({
      providers: [
        FocusDockLeaderService,
        { provide: LoggerService, useValue: loggerMock },
      ],
    });

    const service = TestBed.inject(FocusDockLeaderService);

    expect(service.isLeader()).toBe(false);
    expect(service.tryTakeover()).toBe(false);
    expect(service.isLeader()).toBe(false);

    setItemSpy.mockRestore();
  });

  it('should not claim leadership when its lease write is immediately overwritten', () => {
    const originalSetItem = localStorage.setItem.bind(localStorage);
    const now = Date.now();
    const setItemSpy = vi.spyOn(localStorage, 'setItem')
      .mockImplementation((key, value) => {
        originalSetItem(key, value);
        if (key === PARKING_CONFIG.FOCUS_CONSOLE_LEADER_LEASE_KEY) {
          originalSetItem(key, JSON.stringify({
            tabId: 'other-tab',
            updatedAt: now,
            expiresAt: now + 10000,
          }));
        }
      });

    TestBed.configureTestingModule({
      providers: [
        FocusDockLeaderService,
        { provide: LoggerService, useValue: loggerMock },
      ],
    });

    const service = TestBed.inject(FocusDockLeaderService);

    expect(service.isLeader()).toBe(false);
    expect(service.leaderTabId()).toBe('other-tab');
    expect(service.isReadOnlyFollower()).toBe(true);

    setItemSpy.mockRestore();
  });

  it('should continue cleanup when BroadcastChannel close throws', () => {
    const closeError = new Error('channel already closed');
    MockBroadcastChannel.closeMock.mockImplementationOnce(() => {
      throw closeError;
    });
    const removeStorageListener = vi.spyOn(window, 'removeEventListener');
    TestBed.configureTestingModule({
      providers: [
        FocusDockLeaderService,
        { provide: LoggerService, useValue: loggerMock },
      ],
    });
    const service = TestBed.inject(FocusDockLeaderService);

    let thrown: unknown;
    try {
      service.ngOnDestroy();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(removeStorageListener).toHaveBeenCalledWith('storage', expect.any(Function));
  });

  it('should continue storage listener cleanup when channel cleanup warning logger throws', () => {
    MockBroadcastChannel.closeMock.mockImplementationOnce(() => {
      throw new Error('channel already closed');
    });
    loggerMock.category.mockReturnValueOnce({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(() => {
        throw new Error('logger unavailable');
      }),
      error: vi.fn(),
    });
    const originalAddEventListener = window.addEventListener.bind(window);
    const originalRemoveEventListener = window.removeEventListener.bind(window);
    const registeredStorageListener = {
      current: null as EventListenerOrEventListenerObject | null,
    };
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
      if (type === 'storage') {
        registeredStorageListener.current = listener;
      }
      originalAddEventListener(type, listener, options);
    });
    const removeStorageListener = vi.spyOn(window, 'removeEventListener');
    TestBed.configureTestingModule({
      providers: [
        FocusDockLeaderService,
        { provide: LoggerService, useValue: loggerMock },
      ],
    });
    const service = TestBed.inject(FocusDockLeaderService);

    try {
      expect(() => service.ngOnDestroy()).not.toThrow();
      expect(removeStorageListener).toHaveBeenCalledWith('storage', expect.any(Function));
    } finally {
      removeStorageListener.mockRestore();
      if (registeredStorageListener.current) {
        originalRemoveEventListener('storage', registeredStorageListener.current);
      }
    }
  });

  it('should release its active leader lease on destroy', () => {
    TestBed.configureTestingModule({
      providers: [
        FocusDockLeaderService,
        { provide: LoggerService, useValue: loggerMock },
      ],
    });
    const service = TestBed.inject(FocusDockLeaderService);

    expect(service.isLeader()).toBe(true);

    service.ngOnDestroy();

    expect(localStorage.getItem(PARKING_CONFIG.FOCUS_CONSOLE_LEADER_LEASE_KEY)).toBeNull();
  });

  it('should not remove another tab lease on destroy', () => {
    TestBed.configureTestingModule({
      providers: [
        FocusDockLeaderService,
        { provide: LoggerService, useValue: loggerMock },
      ],
    });
    const service = TestBed.inject(FocusDockLeaderService);
    const otherLease = {
      tabId: 'other-tab',
      updatedAt: Date.now(),
      expiresAt: Date.now() + 10000,
    };
    localStorage.setItem(
      PARKING_CONFIG.FOCUS_CONSOLE_LEADER_LEASE_KEY,
      JSON.stringify(otherLease),
    );

    service.ngOnDestroy();

    expect(JSON.parse(
      localStorage.getItem(PARKING_CONFIG.FOCUS_CONSOLE_LEADER_LEASE_KEY) ?? 'null',
    )).toEqual(otherLease);
  });

  it('should not throw when storage listener cleanup fails', () => {
    const removeError = new Error('listener cleanup failed');
    const originalAddEventListener = window.addEventListener.bind(window);
    const originalRemoveEventListener = window.removeEventListener.bind(window);
    const registeredStorageListener = {
      current: null as EventListenerOrEventListenerObject | null,
    };
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
      if (type === 'storage') {
        registeredStorageListener.current = listener;
      }
      originalAddEventListener(type, listener, options);
    });
    const removeStorageListener = vi.spyOn(window, 'removeEventListener').mockImplementationOnce(() => {
      throw removeError;
    });
    TestBed.configureTestingModule({
      providers: [
        FocusDockLeaderService,
        { provide: LoggerService, useValue: loggerMock },
      ],
    });
    const service = TestBed.inject(FocusDockLeaderService);

    expect(() => service.ngOnDestroy()).not.toThrow();
    expect(MockBroadcastChannel.closeMock).toHaveBeenCalledOnce();
    removeStorageListener.mockRestore();
    if (registeredStorageListener.current) {
      originalRemoveEventListener('storage', registeredStorageListener.current);
    }
  });

  it('should not reacquire leadership from a late storage event after destroy', () => {
    const originalAddEventListener = window.addEventListener.bind(window);
    const originalRemoveEventListener = window.removeEventListener.bind(window);
    const registeredStorageListener = {
      current: null as EventListenerOrEventListenerObject | null,
    };
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
      if (type === 'storage') {
        registeredStorageListener.current = listener;
      }
      originalAddEventListener(type, listener, options);
    });
    const removeStorageListener = vi.spyOn(window, 'removeEventListener').mockImplementationOnce(() => {
      throw new Error('listener cleanup failed');
    });
    TestBed.configureTestingModule({
      providers: [
        FocusDockLeaderService,
        { provide: LoggerService, useValue: loggerMock },
      ],
    });
    const service = TestBed.inject(FocusDockLeaderService);

    expect(service.isLeader()).toBe(true);

    service.ngOnDestroy();
    expect(localStorage.getItem(PARKING_CONFIG.FOCUS_CONSOLE_LEADER_LEASE_KEY)).toBeNull();

    const lateStorageEvent = new StorageEvent('storage', {
      key: PARKING_CONFIG.FOCUS_CONSOLE_LEADER_LEASE_KEY,
    });
    if (typeof registeredStorageListener.current === 'function') {
      registeredStorageListener.current(lateStorageEvent);
    } else {
      registeredStorageListener.current?.handleEvent(lateStorageEvent);
    }

    expect(localStorage.getItem(PARKING_CONFIG.FOCUS_CONSOLE_LEADER_LEASE_KEY)).toBeNull();
    expect(service.isLeader()).toBe(false);

    removeStorageListener.mockRestore();
    if (registeredStorageListener.current) {
      originalRemoveEventListener('storage', registeredStorageListener.current);
    }
  });
});
