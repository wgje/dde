import { Injector, NgZone, runInInjectionContext } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { FlowDiagramRetryService } from './flow-diagram-retry.service';
import { FlowDiagramService } from './flow-diagram.service';

function createService() {
  const diagram = {
    dispose: vi.fn(),
    isInitialized: true,
  };
  const zone = {
    run: (callback: () => void) => callback(),
  };
  const injector = Injector.create({
    providers: [
      {
        provide: LoggerService,
        useValue: {
          category: () => ({
            debug: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
          }),
        },
      },
      {
        provide: ToastService,
        useValue: {
          error: vi.fn(),
          info: vi.fn(),
          success: vi.fn(),
        },
      },
      { provide: NgZone, useValue: zone },
      { provide: FlowDiagramService, useValue: diagram },
    ],
  });

  return {
    diagram,
    service: runInInjectionContext(injector, () => new FlowDiagramRetryService()),
  };
}

function createIdleDeadline(): IdleDeadline {
  return {
    didTimeout: false,
    timeRemaining: () => 50,
  };
}

describe('FlowDiagramRetryService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('replaces a pending idle diagram init so stale idle callbacks cannot initialize twice', () => {
    const { service } = createService();
    const initDiagram = vi.fn();
    const onInitialized = vi.fn();
    const scheduleTimer = vi.fn();
    const idleCallbacks = new Map<number, IdleRequestCallback>();
    let nextIdleHandle = 1;
    const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      const handle = nextIdleHandle++;
      idleCallbacks.set(handle, callback);
      return handle;
    });
    const cancelIdleCallback = vi.fn((handle: number) => {
      idleCallbacks.delete(handle);
    });

    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    vi.stubGlobal('cancelIdleCallback', cancelIdleCallback);

    service.scheduleDiagramInit(initDiagram, onInitialized, scheduleTimer, () => false);
    const firstIdleCallback = idleCallbacks.get(1);
    service.scheduleDiagramInit(initDiagram, onInitialized, scheduleTimer, () => false);

    expect(cancelIdleCallback).toHaveBeenCalledWith(1);
    expect(firstIdleCallback).toBeTypeOf('function');
    firstIdleCallback?.(createIdleDeadline());
    expect(initDiagram).not.toHaveBeenCalled();

    idleCallbacks.get(2)?.(createIdleDeadline());

    expect(initDiagram).toHaveBeenCalledOnce();
    expect(onInitialized).toHaveBeenCalledOnce();
    expect(scheduleTimer).not.toHaveBeenCalled();
  });

  it('clears the tracked idle init handle even when cancelIdleCallback is unavailable', () => {
    const { service } = createService();
    const initDiagram = vi.fn();
    let idleCallback: IdleRequestCallback | null = null;
    vi.stubGlobal('requestIdleCallback', vi.fn((callback: IdleRequestCallback) => {
      idleCallback = callback;
      return 7;
    }));
    vi.stubGlobal('cancelIdleCallback', undefined);

    service.scheduleDiagramInit(initDiagram, vi.fn(), vi.fn(), () => false);
    expect(service.getIdleInitHandle()).toBe(7);

    service.clearIdleInitHandle();

    expect(service.getIdleInitHandle()).toBeNull();
    const capturedIdleCallback = idleCallback as IdleRequestCallback | null;
    capturedIdleCallback?.(createIdleDeadline());
    expect(initDiagram).not.toHaveBeenCalled();
  });
});
