import type { ComponentFixture } from '@angular/core/testing';
import type { WritableSignal } from '@angular/core';
import { expect, it, vi } from 'vitest';

import { PARKING_CONFIG } from '../../../../config/parking.config';
import type { StatusMachineEntry } from '../../../../models/parking-dock';
import type { UiStateService } from '../../../../services/ui-state.service';
import { ParkingDockComponent } from '../parking-dock.component';

type MockFn = ReturnType<typeof vi.fn>;

export interface ParkingDockHudSpecContext {
  fixture: ComponentFixture<ParkingDockComponent>;
  component: ParkingDockComponent;
  uiState: UiStateService;
  focusMode: WritableSignal<boolean>;
  focusScrimOn: WritableSignal<boolean>;
  statusMachineEntries: WritableSignal<StatusMachineEntry[]>;
  pendingDecision: WritableSignal<{ reason: string; rootRemainingMinutes?: number } | null>;
  pendingDecisionEntries: WritableSignal<unknown[]>;
  mockEngine: {
    restReminderActive: WritableSignal<boolean>;
    cumulativeHighLoadMs: WritableSignal<number>;
    fragmentRest: {
      dismissRestReminder: MockFn;
    };
  };
  mockFocusHudWindow: {
    isActive: WritableSignal<boolean>;
    isSupported: WritableSignal<boolean>;
    open: MockFn;
    close: MockFn;
  };
  mockToast: {
    warning: MockFn;
  };
}

function focusingEntry(): StatusMachineEntry {
  return {
    taskId: 'A',
    title: 'Focus A',
    uiStatus: 'focusing',
    label: '专注中',
    waitRemainingSeconds: null,
    waitTotalSeconds: null,
  };
}

export function registerParkingDockHudSpecs(getContext: () => ParkingDockHudSpecContext): void {
  it('full HUD should default to upper-right with 12px margin', () => {
    const { component, focusMode, focusScrimOn } = getContext();
    focusMode.set(true);
    focusScrimOn.set(true);

    const style = component.hudContainerStyle();

    expect(style.top).toBe(`${PARKING_CONFIG.HUD_FULL_DEFAULT_TOP_PX}px`);
    expect(style.left).toBe(`${window.innerWidth - PARKING_CONFIG.HUD_FULL_MAX_WIDTH_PX - 12}px`);
    expect(style.right).toBe('auto');
  });

  it('mobile minimal HUD should enable pass-through styling for drawer gestures', () => {
    const { fixture, component, uiState, focusMode, focusScrimOn, statusMachineEntries } = getContext();
    uiState.isMobile.set(true);
    focusMode.set(true);
    focusScrimOn.set(false);
    statusMachineEntries.set([focusingEntry()]);
    fixture.detectChanges();

    const container = fixture.nativeElement.querySelector('[data-testid="dock-v3-status-machine-container"]') as HTMLElement | null;
    const minimal = fixture.nativeElement.querySelector('[data-testid="dock-v3-status-machine-minimal"]') as HTMLElement | null;

    expect(component.hudMinimalPassThrough()).toBe(true);
    expect(container?.classList.contains('pointer-events-none')).toBe(true);
    expect(container?.getAttribute('data-pass-through')).toBe('true');
    expect(minimal?.getAttribute('data-pass-through')).toBe('true');
  });

  it('mobile minimal HUD should keep explicit action buttons clickable in pass-through mode', () => {
    const {
      fixture,
      uiState,
      focusMode,
      focusScrimOn,
      statusMachineEntries,
      mockEngine,
    } = getContext();
    uiState.isMobile.set(true);
    focusMode.set(true);
    focusScrimOn.set(false);
    mockEngine.restReminderActive.set(true);
    mockEngine.cumulativeHighLoadMs.set(25 * 60 * 1000);
    statusMachineEntries.set([focusingEntry()]);
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector(
      '[data-testid="dock-v3-status-machine-minimal"] [data-status-interactive="true"]',
    ) as HTMLButtonElement | null;

    expect(button).toBeTruthy();

    button?.click();

    expect(mockEngine.fragmentRest.dismissRestReminder).toHaveBeenCalledTimes(1);
  });

  it('active PiP HUD should collapse the in-page HUD to minimal mode even with scrim on', () => {
    const { fixture, component, focusMode, focusScrimOn, statusMachineEntries, mockFocusHudWindow } = getContext();
    focusMode.set(true);
    focusScrimOn.set(true);
    mockFocusHudWindow.isActive.set(true);
    statusMachineEntries.set([focusingEntry()]);
    fixture.detectChanges();

    expect(component.hudMinimalMode()).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-status-machine-minimal"]')).toBeTruthy();
  });

  it('transparent focus mode should keep stage mounted and HUD minimal', () => {
    const { fixture, focusMode, focusScrimOn, statusMachineEntries } = getContext();
    focusMode.set(true);
    focusScrimOn.set(false);
    statusMachineEntries.set([focusingEntry()]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-focus-stage"]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-status-machine-container"]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-status-machine-minimal"]')).toBeTruthy();
  });

  it('PiP HUD toggle should open the PiP window on desktop focus mode', async () => {
    const { fixture, component, focusMode, focusScrimOn, mockFocusHudWindow } = getContext();
    focusMode.set(true);
    focusScrimOn.set(true);
    mockFocusHudWindow.isSupported.set(true);
    fixture.detectChanges();

    await component.togglePipHud();

    expect(mockFocusHudWindow.open).toHaveBeenCalledTimes(1);
    expect(mockFocusHudWindow.close).not.toHaveBeenCalled();
  });

  it('PiP HUD toggle should close the PiP window when it is already active', async () => {
    const { fixture, component, focusMode, focusScrimOn, mockFocusHudWindow } = getContext();
    focusMode.set(true);
    focusScrimOn.set(true);
    mockFocusHudWindow.isSupported.set(true);
    mockFocusHudWindow.isActive.set(true);
    fixture.detectChanges();

    await component.togglePipHud();

    expect(mockFocusHudWindow.close).toHaveBeenCalledTimes(1);
    expect(mockFocusHudWindow.open).not.toHaveBeenCalled();
  });

  it('PiP HUD open failure should warn the user instead of failing silently', async () => {
    const { fixture, component, focusMode, focusScrimOn, mockFocusHudWindow, mockToast } = getContext();
    focusMode.set(true);
    focusScrimOn.set(true);
    mockFocusHudWindow.isSupported.set(true);
    mockFocusHudWindow.open.mockResolvedValue(false);
    fixture.detectChanges();

    await component.togglePipHud();

    expect(mockToast.warning).toHaveBeenCalledWith(
      '打开悬浮窗失败',
      '当前环境未能创建悬浮窗，请先留在主窗口继续处理。',
    );
  });

  it('HUD drag handler should ignore header action buttons so the PiP toggle remains clickable', () => {
    const { fixture, component, focusMode, focusScrimOn, mockFocusHudWindow } = getContext();
    focusMode.set(true);
    focusScrimOn.set(true);
    mockFocusHudWindow.isSupported.set(true);
    fixture.detectChanges();

    const shell = fixture.nativeElement.querySelector('.status-machine-shell') as HTMLElement | null;
    const pipButton = fixture.nativeElement.querySelector('[data-testid="dock-v3-status-pip-toggle"]') as HTMLButtonElement | null;
    const preventDefault = vi.fn();

    component.onHudPointerDown({
      button: 0,
      clientX: 48,
      clientY: 48,
      currentTarget: shell,
      target: pipButton,
      pointerId: 1,
      preventDefault,
    } as unknown as PointerEvent);

    expect(component.hudDragging()).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('should render the PiP toggle inside the status HUD header instead of an external floating button', () => {
    const { fixture, focusMode, focusScrimOn, mockFocusHudWindow } = getContext();
    focusMode.set(true);
    focusScrimOn.set(true);
    mockFocusHudWindow.isSupported.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-status-pip-toggle"]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-status-machine-pip-toggle"]')).toBeNull();
  });

  it('blank period should render dedicated card and fragment scene mode', () => {
    const { fixture, component, focusMode, focusScrimOn, pendingDecision, pendingDecisionEntries } = getContext();
    focusMode.set(true);
    focusScrimOn.set(true);
    pendingDecision.set({ reason: '窗口过短', rootRemainingMinutes: 5 });
    pendingDecisionEntries.set([]);
    fixture.detectChanges();

    const scene = fixture.nativeElement.querySelector('[data-testid="dock-v3-focus-scene"]');

    expect(component.blankPeriodActive()).toBe(true);
    expect(scene?.getAttribute('data-scene')).toBe('fragment');
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-blank-period-card"]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-pending-decision"]')).toBeNull();
  });
}
