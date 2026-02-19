import { DestroyRef, Injector, NgZone, runInInjectionContext } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FocusModeComponent } from './focus-mode.component';
import { GateService } from '../../../services/gate.service';
import { BlackBoxSyncService } from '../../../services/black-box-sync.service';
import { LoggerService } from '../../../services/logger.service';
import { gateState, resetFocusState } from '../../../state/focus-stores';
import { STARTUP_PERF_CONFIG } from '../../../config/startup-performance.config';

describe('FocusModeComponent', () => {
  const flushPromises = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };

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
  });

  afterEach(() => {
    vi.useRealTimers();
    resetFocusState();
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

  it('启动时先做本地检查，远端 pull 延迟 FOCUS_REMOTE_STARTUP_DELAY_MS 后触发', async () => {
    const { component, loadFromLocal, pullChanges, checkGate } = createComponent();

    component.ngOnInit();
    await flushPromises();

    // 本地加载立即执行
    expect(loadFromLocal).toHaveBeenCalledTimes(1);
    // 仅本地检查 gate（1 次），远端 pull 尚未触发
    expect(checkGate).toHaveBeenCalledTimes(1);
    expect(pullChanges).not.toHaveBeenCalled();

    // 推进到延迟时间后，远端 pull 才触发
    vi.advanceTimersByTime(STARTUP_PERF_CONFIG.FOCUS_REMOTE_STARTUP_DELAY_MS);
    await flushPromises();

    expect(pullChanges).toHaveBeenCalledTimes(1);
    expect(pullChanges).toHaveBeenCalledWith({ reason: 'startup' });
    // 本地检查 + 远端拉取后重新检查 = 2 次
    expect(checkGate).toHaveBeenCalledTimes(2);

    component.ngOnDestroy();
  });

  it('组件销毁时应清理远端拉取定时器', async () => {
    const { component, pullChanges } = createComponent();

    component.ngOnInit();
    await flushPromises();

    // pullChanges 尚未触发
    expect(pullChanges).not.toHaveBeenCalled();

    // 销毁组件取消待执行的远端拉取
    component.ngOnDestroy();

    // 推进时间后，pullChanges 不应被调用
    vi.advanceTimersByTime(STARTUP_PERF_CONFIG.FOCUS_REMOTE_STARTUP_DELAY_MS + 1000);
    await flushPromises();

    expect(pullChanges).not.toHaveBeenCalled();
  });
});
