import { DestroyRef, Injector, NgZone, runInInjectionContext } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FocusModeComponent } from './focus-mode.component';
import { GateService } from '../../../services/gate.service';
import { BlackBoxSyncService } from '../../../services/black-box-sync.service';
import { LoggerService } from '../../../services/logger.service';
import { gateState, resetFocusState } from '../../../state/focus-stores';

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
    resetFocusState();
    destroyCallbacks.length = 0;
  });

  afterEach(() => {
    resetFocusState();
  });

  it('启动时先做本地检查，后台延迟触发远端 pull 并重新检查 gate', async () => {
    const loadFromLocal = vi.fn().mockResolvedValue([]);
    const pullChanges = vi.fn().mockResolvedValue(undefined);
    const checkGate = vi.fn(() => gateState.set('reviewing'));

    const injector = Injector.create({
      providers: [
        { provide: FocusModeComponent, useClass: FocusModeComponent },
        { provide: GateService, useValue: { checkGate } },
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
    component.ngOnInit();
    await flushPromises();

    expect(loadFromLocal).toHaveBeenCalledTimes(1);
    // 第一次从本地检查 + 后台拉取后重新检查 = 2 次
    expect(checkGate).toHaveBeenCalledTimes(2);
    // 后台延迟触发远端 pull
    expect(pullChanges).toHaveBeenCalledTimes(1);
    expect(pullChanges).toHaveBeenCalledWith({ reason: 'startup' });

    component.ngOnDestroy();
  });
});
