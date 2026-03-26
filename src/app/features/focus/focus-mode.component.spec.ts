import { DestroyRef, Injector, NgZone, runInInjectionContext } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FocusModeComponent } from './focus-mode.component';
import { GateService } from '../../../services/gate.service';
import { BlackBoxSyncService } from '../../../services/black-box-sync.service';
import { LoggerService } from '../../../services/logger.service';
import { gateState, resetFocusState } from '../../../state/focus-stores';
import { FEATURE_FLAGS } from '../../../config/feature-flags.config';
import { STARTUP_PERF_CONFIG } from '../../../config/startup-performance.config';

describe('FocusModeComponent', () => {
  const flushPromises = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };
  const originalFocusStartupThrottledCheck = FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1;

  const destroyCallbacks: Array<() => void> = [];
  const mockDestroyRef: Pick<DestroyRef, 'onDestroy'> = {
    onDestroy: (cb: () => void) => {
      destroyCallbacks.push(cb);
    },
  };

  beforeEach(() => {
    vi.useFakeTimers();
    resetFocusState();
    destroyCallbacks.length = 0;
    (FEATURE_FLAGS as { FOCUS_STARTUP_THROTTLED_CHECK_V1: boolean }).FOCUS_STARTUP_THROTTLED_CHECK_V1 =
      originalFocusStartupThrottledCheck;
  });

  afterEach(() => {
    vi.useRealTimers();
    resetFocusState();
    (FEATURE_FLAGS as { FOCUS_STARTUP_THROTTLED_CHECK_V1: boolean }).FOCUS_STARTUP_THROTTLED_CHECK_V1 =
      originalFocusStartupThrottledCheck;
  });

  function createComponent() {
    const loadFromLocal = vi.fn().mockResolvedValue([]);
    const pullChanges = vi.fn().mockResolvedValue(undefined);
    const checkGate = vi.fn(() => gateState.set('reviewing'));

    const injector = Injector.create({
      providers: [
        { provide: FocusModeComponent, useClass: FocusModeComponent },
        { provide: GateService, useValue: { checkGate, devForceActive: () => false } },
        { provide: BlackBoxSyncService, useValue: { loadFromLocal, pullChanges } },
        {
          provide: LoggerService,
          useValue: {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
          },
        },
        {
          provide: NgZone,
          useValue: {
            run: (fn: () => unknown) => fn(),
          },
        },
        { provide: DestroyRef, useValue: mockDestroyRef },
      ],
    });

    const component = runInInjectionContext(injector, () => injector.get(FocusModeComponent));
    return { component, loadFromLocal, pullChanges, checkGate };
  }

  it('默认 throttled 路径下应保持被动，由启动探针负责 gate 检查与黑匣子拉取', async () => {
    const { component, loadFromLocal, pullChanges, checkGate } = createComponent();

    component.ngOnInit();
    await flushPromises();

    expect(loadFromLocal).not.toHaveBeenCalled();
    expect(checkGate).not.toHaveBeenCalled();
    expect(pullChanges).not.toHaveBeenCalled();

    vi.advanceTimersByTime(STARTUP_PERF_CONFIG.FOCUS_REMOTE_STARTUP_DELAY_MS);
    await flushPromises();

    expect(loadFromLocal).not.toHaveBeenCalled();
    expect(checkGate).not.toHaveBeenCalled();
    expect(pullChanges).not.toHaveBeenCalled();

    component.ngOnDestroy();
  });

  it('默认 throttled 路径下即使销毁后推进远端窗口，也不应补触发 gate 或拉取', async () => {
    const { component, loadFromLocal, pullChanges, checkGate } = createComponent();

    component.ngOnInit();
    await flushPromises();
    component.ngOnDestroy();

    vi.advanceTimersByTime(STARTUP_PERF_CONFIG.FOCUS_REMOTE_STARTUP_DELAY_MS + 1000);
    await flushPromises();

    expect(loadFromLocal).not.toHaveBeenCalled();
    expect(checkGate).not.toHaveBeenCalled();
    expect(pullChanges).not.toHaveBeenCalled();
  });
});
