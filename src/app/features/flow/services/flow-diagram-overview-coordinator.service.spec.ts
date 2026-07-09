import { ElementRef, type NgZone } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FlowDiagramOverviewCoordinatorService } from './flow-diagram-overview-coordinator.service';

describe('FlowDiagramOverviewCoordinatorService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('drops fallback overview init timers after reset', () => {
    const coordinator = new FlowDiagramOverviewCoordinatorService();
    const container = document.createElement('div');
    const callbacks: Array<() => void> = [];
    const runtime = {
      isInitialized: () => true,
      initializeOverview: vi.fn(),
    };
    const zone = {
      run: (callback: () => void) => callback(),
    } as NgZone;
    vi.stubGlobal('requestIdleCallback', undefined);
    vi.stubGlobal('cancelIdleCallback', undefined);

    coordinator.scheduleOverviewInit(
      new ElementRef(container),
      true,
      false,
      zone,
      callback => callbacks.push(callback),
      runtime,
    );

    coordinator.reset();
    callbacks.forEach(callback => callback());

    expect(runtime.initializeOverview).not.toHaveBeenCalled();
  });
});
