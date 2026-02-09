import { Injector, signal, WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { UiStateService } from '../../../../services/ui-state.service';
import { FlowMobileDrawerService } from './flow-mobile-drawer.service';

describe('FlowMobileDrawerService', () => {
  let service: FlowMobileDrawerService;
  let injector: Injector;
  let mockUiState: {
    isMobile: WritableSignal<boolean>;
    activeView: WritableSignal<'text' | 'flow' | null>;
    isFlowDetailOpen: WritableSignal<boolean>;
  };

  beforeEach(() => {
    mockUiState = {
      isMobile: signal(true),
      activeView: signal<'text' | 'flow' | null>('flow'),
      isFlowDetailOpen: signal(true),
    };

    TestBed.configureTestingModule({
      providers: [
        FlowMobileDrawerService,
        { provide: UiStateService, useValue: mockUiState },
      ],
    });

    service = TestBed.inject(FlowMobileDrawerService);
    injector = TestBed.inject(Injector);
  });

  it('离开 flow 页面后应清除手动覆盖标记', () => {
    const drawerManualOverride = signal(true);
    const isResizingDrawerSignal = signal(false);

    service.setupDrawerEffects(injector, {
      paletteHeight: () => 80,
      drawerHeight: () => 12,
      drawerManualOverride,
      isResizingDrawerSignal: () => isResizingDrawerSignal(),
      selectedTaskId: () => null,
      scheduleDrawerHeightUpdate: () => undefined,
    });
    TestBed.flushEffects();

    expect(drawerManualOverride()).toBe(true);
    mockUiState.activeView.set('text');
    TestBed.flushEffects();
    expect(drawerManualOverride()).toBe(false);
  });

  it('详情关闭时应清除手动覆盖标记', () => {
    const drawerManualOverride = signal(true);
    const isResizingDrawerSignal = signal(false);

    service.setupDrawerEffects(injector, {
      paletteHeight: () => 80,
      drawerHeight: () => 12,
      drawerManualOverride,
      isResizingDrawerSignal: () => isResizingDrawerSignal(),
      selectedTaskId: () => null,
      scheduleDrawerHeightUpdate: () => undefined,
    });
    TestBed.flushEffects();

    expect(drawerManualOverride()).toBe(true);
    mockUiState.isFlowDetailOpen.set(false);
    TestBed.flushEffects();
    expect(drawerManualOverride()).toBe(false);
  });

  it('拖拽开始时应进入手动覆盖模式', () => {
    const drawerManualOverride = signal(false);
    const isResizingDrawerSignal = signal(false);

    service.setupDrawerEffects(injector, {
      paletteHeight: () => 80,
      drawerHeight: () => 12,
      drawerManualOverride,
      isResizingDrawerSignal: () => isResizingDrawerSignal(),
      selectedTaskId: () => null,
      scheduleDrawerHeightUpdate: () => undefined,
    });
    TestBed.flushEffects();

    isResizingDrawerSignal.set(true);
    TestBed.flushEffects();
    expect(drawerManualOverride()).toBe(true);
  });
});
