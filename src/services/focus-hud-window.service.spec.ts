import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FocusHudWindowService } from './focus-hud-window.service';
import { LoggerService } from './logger.service';
import { DockEngineService } from './dock-engine.service';
import { PerformanceTierService } from './performance-tier.service';

describe('FocusHudWindowService', () => {
  let service: FocusHudWindowService;
  let originalDescriptor: PropertyDescriptor | undefined;

  const mockLogger = {
    category: vi.fn(() => ({
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    })),
  };

  const mockEngine = {
    focusMode: signal(true),
    toggleFocusMode: vi.fn(),
    statusMachineEntries: signal([
      {
        taskId: 'A',
        title: 'Focus A',
        uiStatus: 'focusing',
        label: '专注中',
        waitRemainingSeconds: null,
        waitTotalSeconds: null,
      },
    ]),
    focusingEntry: signal({
      taskId: 'A',
      title: 'Focus A',
      expectedMinutes: 25,
      waitMinutes: null,
      isMain: true,
    }),
    muteWaitTone: signal(false),
    pendingDecision: signal(null),
    pendingDecisionEntries: signal([]),
    fragmentEntryCountdown: signal<number | null>(null),
    switchToTask: vi.fn(),
    toggleMuteWaitTone: vi.fn(),
    isBurnoutActive: signal(false),
    fragmentDefenseLevel: signal(1 as 1 | 2),
    burnoutTriggeredAt: signal<number | null>(null),
    restReminderActive: signal(false),
    cumulativeHighLoadMs: signal(0),
    cumulativeLowLoadMs: signal(0),
    dismissRestReminder: vi.fn(),
    tick: signal(0),
  };

  const mockPerformanceTier = {
    tier: signal<'T0' | 'T1' | 'T2'>('T0'),
  };

  beforeEach(() => {
    originalDescriptor = Object.getOwnPropertyDescriptor(window, 'documentPictureInPicture');

    TestBed.configureTestingModule({
      providers: [
        FocusHudWindowService,
        { provide: LoggerService, useValue: mockLogger },
        { provide: DockEngineService, useValue: mockEngine },
        { provide: PerformanceTierService, useValue: mockPerformanceTier },
      ],
    });

    service = TestBed.inject(FocusHudWindowService);
  });

  afterEach(async () => {
    await service.close();
    if (originalDescriptor) {
      Object.defineProperty(window, 'documentPictureInPicture', originalDescriptor);
    } else {
      delete (window as Record<string, unknown>).documentPictureInPicture;
    }
    TestBed.resetTestingModule();
  });

  it('should mount and unmount the PiP HUD component', async () => {
    let pageHideHandler: ((event: PageTransitionEvent) => void) | null = null;
    const pipDocument = document.implementation.createHTMLDocument('pip');
    const closeSpy = vi.fn(() => {
      pipWindow.closed = true;
      pageHideHandler?.({} as PageTransitionEvent);
    });
    const pipWindow = {
      document: pipDocument,
      closed: false,
      focus: vi.fn(),
      close: closeSpy,
      addEventListener: vi.fn((type: string, handler: EventListenerOrEventListenerObject) => {
        if (type === 'pagehide') {
          pageHideHandler = handler as (event: PageTransitionEvent) => void;
        }
      }),
      removeEventListener: vi.fn(),
    } as unknown as Window;

    Object.defineProperty(window, 'documentPictureInPicture', {
      configurable: true,
      value: {
        requestWindow: vi.fn().mockResolvedValue(pipWindow),
      },
    });

    expect(service.isSupported()).toBe(true);

    await service.open();

    expect(service.isActive()).toBe(true);
    expect(pipDocument.body.querySelector('[data-testid="dock-v3-status-machine-pip"]')).toBeTruthy();

    await service.close();

    expect(service.isActive()).toBe(false);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
