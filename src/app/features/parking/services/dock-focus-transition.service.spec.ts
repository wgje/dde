import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockFocusTransitionService } from './dock-focus-transition.service';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { PerformanceTierService } from '../../../../services/performance-tier.service';
import { PARKING_CONFIG } from '../../../../config/parking.config';
import type { DockFocusTransitionState } from '../../../../models/parking-dock';

describe('DockFocusTransitionService', () => {
  let service: DockFocusTransitionService;
  let rafQueue: FrameRequestCallback[];

  const focusMode = signal(false);
  const focusTransition = signal<DockFocusTransitionState | null>(null);
  const lastExitAction = signal<'save_exit' | 'clear_exit' | 'keep_focus_hide_scrim' | null>('save_exit');
  const dockedCount = signal(0);

  const mockEngine = {
    dockExpanded: signal(false),
    dockedCount,
    focusMode,
    focusTransition,
    lastExitAction,
    clearFocusChromeRestore: vi.fn(),
    toggleFocusMode: vi.fn(() => {
      focusMode.update((value) => !value);
      return Promise.resolve(true);
    }),
    holdNonCriticalWork: vi.fn(),
    beginFocusTransition: vi.fn((state: DockFocusTransitionState) => focusTransition.set(state)),
    finalizeClearDockForExit: vi.fn(),
    beginFocusChromeRestore: vi.fn(),
    endFocusTransition: vi.fn(() => focusTransition.set(null)),
  };

  const mockPerformanceTier = {
    tier: signal<'T0' | 'T1' | 'T2'>('T0'),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    focusMode.set(false);
    focusTransition.set(null);
    lastExitAction.set('save_exit');
    dockedCount.set(0);
    rafQueue = [];

    vi.stubGlobal('requestAnimationFrame', ((callback: FrameRequestCallback) => {
      rafQueue.push(callback);
      return rafQueue.length;
    }) as typeof requestAnimationFrame);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    TestBed.configureTestingModule({
      providers: [
        DockFocusTransitionService,
        { provide: DockEngineService, useValue: mockEngine },
        { provide: PerformanceTierService, useValue: mockPerformanceTier },
      ],
    });

    service = TestBed.inject(DockFocusTransitionService);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('delays floating UI visibility until the HUD delay elapses on focus enter', () => {
    dockedCount.set(1);
    service.runEnterFocusTransition();

    expect(service.floatingUiVisible()).toBe(false);

    rafQueue.splice(0).forEach((callback) => callback(0));

    vi.advanceTimersByTime(PARKING_CONFIG.MOTION.focus.hudDelayMs - 1);
    expect(service.floatingUiVisible()).toBe(false);

    vi.advanceTimersByTime(1);
    expect(service.floatingUiVisible()).toBe(true);
  });

  it('rolls back the enter transition when focus mode commit fails', async () => {
    dockedCount.set(1);
    mockEngine.toggleFocusMode.mockResolvedValueOnce(false);

    service.runEnterFocusTransition();
    rafQueue.splice(0).forEach((callback) => callback(0));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(PARKING_CONFIG.MOTION.focus.enterMs);

    expect(focusMode()).toBe(false);
    expect(service.floatingUiVisible()).toBe(false);
    expect(focusTransition()).toBeNull();
    expect(mockEngine.endFocusTransition).toHaveBeenCalledTimes(1);
  });

  it('does not create a flip ghost during exit even when dock data exists', () => {
    dockedCount.set(1);
    focusMode.set(true);

    service.runExitFocusTransition();

    expect(focusTransition()?.phase).toBe('exiting');
    expect(service.flipGhost()).toBeNull();
  });

  it('starts chrome restore only after the exit transition unmounts', () => {
    focusMode.set(true);

    service.runExitFocusTransition();

    const transitionDuration = focusTransition()?.durationMs ?? 0;
    vi.advanceTimersByTime(transitionDuration);

    expect(focusMode()).toBe(false);
    expect(focusTransition()?.phase).toBe('exiting');
    expect(mockEngine.beginFocusChromeRestore).not.toHaveBeenCalled();

    const exitUnmountDelay = Math.max(
      PARKING_CONFIG.MOTION.focus.exitMs,
      PARKING_CONFIG.MOTION.hud.enterMs,
    ) + 80;
    vi.advanceTimersByTime(exitUnmountDelay);

    expect(focusTransition()).toBeNull();
    expect(mockEngine.beginFocusChromeRestore).toHaveBeenCalledTimes(1);
  });
});
