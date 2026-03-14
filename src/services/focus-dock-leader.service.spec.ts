import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FocusDockLeaderService } from './focus-dock-leader.service';
import { LoggerService } from './logger.service';
import { PARKING_CONFIG } from '../config/parking.config';

class MockBroadcastChannel {
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(_name: string) {}
  postMessage(_message: unknown): void {}
  close(): void {}
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
  const originalBroadcastChannel = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    (globalThis as { BroadcastChannel?: typeof MockBroadcastChannel }).BroadcastChannel = MockBroadcastChannel;
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    if (originalBroadcastChannel) {
      (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel = originalBroadcastChannel;
    } else {
      delete (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
    }
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
});
