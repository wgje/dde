import type { ComponentFixture } from '@angular/core/testing';
import type { WritableSignal } from '@angular/core';
import { expect, it, vi } from 'vitest';

import { PARKING_CONFIG } from '../../../../config/parking.config';
import type { DockEntry, DockFocusTransitionState, StatusMachineEntry } from '../../../../models/parking-dock';
import type { UiStateService } from '../../../../services/ui-state.service';
import { ParkingDockComponent } from '../parking-dock.component';

type MockFn = ReturnType<typeof vi.fn>;
type FocusExitDockEntry = Partial<DockEntry>
  & Pick<DockEntry, 'taskId' | 'title' | 'status' | 'load' | 'lane' | 'isMain'>;

export interface ParkingDockFocusExitSpecContext {
  fixture: ComponentFixture<ParkingDockComponent>;
  component: ParkingDockComponent;
  uiState: UiStateService;
  dockedEntries: WritableSignal<FocusExitDockEntry[]>;
  focusMode: WritableSignal<boolean>;
  focusScrimOn: WritableSignal<boolean>;
  focusTransition: WritableSignal<DockFocusTransitionState | null>;
  statusMachineEntries: WritableSignal<StatusMachineEntry[]>;
  firstMainSelectionPending: WritableSignal<{ taskId: string; expiresAt: number } | null>;
  mockEngine: {
    beginFocusTransition: MockFn;
    toggleFocusMode: MockFn;
    beginFocusChromeRestore: MockFn;
    endFocusTransition: MockFn;
    markExitAction: MockFn;
    clearDockForExit: MockFn;
    setFocusScrim: MockFn;
    archiveInlineEntriesToActiveProject: MockFn;
    setMainTask: MockFn;
    overrideFirstMainTask: MockFn;
  };
  mockPerformanceTier: {
    tier: WritableSignal<'T0' | 'T1' | 'T2'>;
  };
}

export function registerParkingDockFocusExitSpecs(getContext: () => ParkingDockFocusExitSpecContext): void {
  it('onFocusSessionToggle should start enter transition with flip ghost when dock entries exist', async () => {
    const { fixture, component, dockedEntries, focusMode, focusTransition, mockEngine } = getContext();
    dockedEntries.set([
      {
        taskId: 'focus-source',
        title: 'Focus Source',
        status: 'pending_start',
        load: 'low',
        lane: 'backup',
        expectedMinutes: 25,
        waitMinutes: null,
        isMain: true,
      },
    ]);
    component.onFocusSessionToggle();
    fixture.detectChanges();

    expect(mockEngine.beginFocusTransition).toHaveBeenCalled();
    expect(focusTransition()?.phase).toBe('entering');
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v4-flip-ghost"]')).toBeTruthy();

    await vi.advanceTimersByTimeAsync(20);
    fixture.detectChanges();
    expect(mockEngine.toggleFocusMode).toHaveBeenCalledTimes(1);
    expect(focusMode()).toBe(true);

    await vi.advanceTimersByTimeAsync(PARKING_CONFIG.MOTION.focus.enterMs + 20);
    fixture.detectChanges();
    expect(focusTransition()?.phase).toBe('focused');
  });

  it('onFocusSessionToggle should skip the flip ghost when the dock is empty', async () => {
    const { fixture, component, dockedEntries, focusTransition, mockEngine } = getContext();
    dockedEntries.set([]);

    component.onFocusSessionToggle();
    fixture.detectChanges();

    expect(mockEngine.beginFocusTransition).toHaveBeenCalled();
    expect(focusTransition()?.phase).toBe('entering');
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v4-flip-ghost"]')).toBeNull();

    await vi.advanceTimersByTimeAsync(PARKING_CONFIG.MOTION.focus.enterMs + 20);
    fixture.detectChanges();
    expect(focusTransition()?.phase).toBe('focused');
  });

  it('should freeze performance tier during focus transition until settled', async () => {
    const { fixture, component, mockPerformanceTier } = getContext();
    mockPerformanceTier.tier.set('T0');
    component.onFocusSessionToggle();
    fixture.detectChanges();

    expect(component.focusTransitionService.performanceTier()).toBe('T0');

    mockPerformanceTier.tier.set('T2');
    fixture.detectChanges();
    expect(component.focusTransitionService.performanceTier()).toBe('T0');

    await vi.advanceTimersByTimeAsync(20);
    fixture.detectChanges();
    component.onFocusTransitionSettled('entering');
    fixture.detectChanges();
    expect(component.focusTransitionService.performanceTier()).toBe('T2');
  });

  it('onFocusSessionToggle should require confirmation before handing off to the exit transition', async () => {
    const { fixture, component, dockedEntries, focusMode, focusTransition, mockEngine } = getContext();
    focusMode.set(true);
    dockedEntries.set([
      {
        taskId: 'focus-main',
        title: 'Focus Main',
        status: 'focusing',
        load: 'low',
        lane: 'backup',
        expectedMinutes: 25,
        waitMinutes: null,
        isMain: true,
      },
    ]);
    fixture.detectChanges();

    component.onFocusSessionToggle();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-exit-confirm"]')).toBeTruthy();
    expect(mockEngine.beginFocusTransition).not.toHaveBeenCalled();

    component.confirmExitFocus('request-end-focus');
    fixture.detectChanges();
    expect(component.exitFlowStep()).toBe('destructive');

    component.confirmExitFocus('save-exit');
    fixture.detectChanges();
    expect(mockEngine.beginFocusTransition).toHaveBeenCalled();
    expect(focusTransition()?.phase).toBe('exiting');
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v4-flip-ghost"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-console-card"]')).toBeNull();

    await vi.advanceTimersByTimeAsync(20);
    fixture.detectChanges();
    expect(mockEngine.toggleFocusMode).not.toHaveBeenCalled();
    expect(focusMode()).toBe(true);

    await vi.advanceTimersByTimeAsync(PARKING_CONFIG.MOTION.focus.exitMs + 20);
    fixture.detectChanges();
    expect(mockEngine.toggleFocusMode).toHaveBeenCalledTimes(1);
    expect(focusMode()).toBe(false);
    expect(mockEngine.beginFocusChromeRestore).not.toHaveBeenCalled();
    expect(mockEngine.endFocusTransition).not.toHaveBeenCalled();
    expect(focusTransition()?.phase).toBe('exiting');

    const exitUnmountDelay = Math.max(
      PARKING_CONFIG.MOTION.focus.exitMs,
      PARKING_CONFIG.MOTION.hud.enterMs,
    ) + 80;
    await vi.advanceTimersByTimeAsync(exitUnmountDelay);
    fixture.detectChanges();

    expect(mockEngine.endFocusTransition).toHaveBeenCalled();
    expect(focusTransition()).toBeNull();
    expect(mockEngine.beginFocusChromeRestore).toHaveBeenCalled();
  });

  it('confirmExitFocus clear-exit should keep exit visuals alive after live dock data is cleared', () => {
    const { fixture, component, dockedEntries, focusMode, focusTransition, statusMachineEntries, mockEngine } = getContext();
    focusMode.set(true);
    dockedEntries.set([
      {
        taskId: 'focus-main',
        title: 'Focus Main',
        status: 'focusing',
        load: 'low',
        lane: 'backup',
        expectedMinutes: 25,
        waitMinutes: null,
        isMain: true,
      },
    ]);
    statusMachineEntries.set([
      {
        taskId: 'focus-main',
        title: 'Focus Main',
        uiStatus: 'focusing',
        label: '专注中',
        waitRemainingSeconds: null,
        waitTotalSeconds: null,
      },
    ]);
    focusTransition.set({
      phase: 'exiting',
      direction: 'exit',
      fromRect: { left: 10, top: 10, width: 100, height: 100 },
      toRect: { left: 10, top: 500, width: 100, height: 100 },
      durationMs: PARKING_CONFIG.MOTION.focus.exitMs,
      startedAt: new Date().toISOString(),
    });
    fixture.detectChanges();

    component.confirmExitFocus('clear-exit');
    fixture.detectChanges();
    expect(mockEngine.markExitAction).toHaveBeenCalledWith('clear_exit');
    expect(mockEngine.clearDockForExit).toHaveBeenCalledTimes(1);
    expect(dockedEntries()).toHaveLength(0);
    expect(statusMachineEntries()).toHaveLength(0);
    expect(component.exitConsoleEntries()?.[0]?.taskId).toBe('focus-main');
    expect(component.exitStatusMachineEntries()?.[0]?.taskId).toBe('focus-main');
  });

  it('keep-focus-hide-scrim should not trigger archive conversion', () => {
    const { component, focusMode, mockEngine } = getContext();
    focusMode.set(true);

    component.confirmExitFocus('keep-focus-hide-scrim');

    expect(mockEngine.archiveInlineEntriesToActiveProject).not.toHaveBeenCalled();
    expect(mockEngine.setFocusScrim).toHaveBeenCalledWith(false);
    expect(mockEngine.beginFocusChromeRestore).toHaveBeenCalledWith(PARKING_CONFIG.MOTION.shell.enterMs);
  });

  it('Alt+H should render the help overlay when focus mode is active', () => {
    const { fixture, component, focusMode, focusScrimOn } = getContext();
    focusMode.set(true);
    focusScrimOn.set(true);
    fixture.detectChanges();

    component.onKeydown(new KeyboardEvent('keydown', { key: 'h', altKey: true }));
    fixture.detectChanges();

    expect(component.helpFeedback.showHelpOverlay()).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-help-overlay"]')).toBeTruthy();
  });

  it('keyboard shortcuts should not fire while editing text', () => {
    const { fixture, component, focusMode, focusScrimOn } = getContext();
    focusMode.set(true);
    focusScrimOn.set(true);
    const input = document.createElement('input');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');

    component.onKeydown({
      key: 'h',
      altKey: true,
      shiftKey: false,
      repeat: false,
      target: input,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);
    fixture.detectChanges();
    expect(component.helpFeedback.showHelpOverlay()).toBe(false);

    component.toggleHelpOverlay();
    fixture.detectChanges();
    component.onKeydown({
      key: 'Escape',
      altKey: false,
      shiftKey: false,
      repeat: false,
      target: editable,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);
    fixture.detectChanges();
    expect(component.helpFeedback.showHelpOverlay()).toBe(true);
  });

  it('background dock clicks should surface feedback while switching the front task', () => {
    const { fixture, component, dockedEntries, focusMode, focusScrimOn, mockEngine } = getContext();
    dockedEntries.set([
      {
        taskId: 'focus-main',
        title: 'Focus Main',
        status: 'focusing',
        load: 'low',
        lane: 'backup',
        expectedMinutes: 25,
        waitMinutes: null,
        isMain: true,
      },
      {
        taskId: 'focus-next',
        title: 'Focus Next',
        status: 'pending_start',
        load: 'low',
        lane: 'backup',
        expectedMinutes: 15,
        waitMinutes: null,
        isMain: false,
      },
    ]);
    focusMode.set(true);
    focusScrimOn.set(true);
    fixture.detectChanges();

    component.onDockCardClick('focus-next');
    fixture.detectChanges();

    expect(mockEngine.setMainTask).toHaveBeenCalledWith('focus-next');
    expect(component.helpFeedback.dockActionFeedback()?.message).toContain('已切换到前台');
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-dock-feedback"]')).toBeTruthy();
  });

  it('two-step exit flow should allow returning from destructive choices', () => {
    const { fixture, component, focusMode } = getContext();
    focusMode.set(true);
    fixture.detectChanges();

    component.onFocusSessionToggle();
    component.confirmExitFocus('request-end-focus');
    fixture.detectChanges();
    expect(component.exitFlowStep()).toBe('destructive');

    component.confirmExitFocus('back');
    fixture.detectChanges();
    expect(component.exitFlowStep()).toBe('primary');
  });

  it('first main 15s window should route click to override path', () => {
    const { component, dockedEntries, firstMainSelectionPending, mockEngine } = getContext();
    dockedEntries.set([
      {
        taskId: 'A',
        title: 'Focus A',
        status: 'focusing',
        load: 'low',
        lane: 'backup',
        expectedMinutes: 25,
        waitMinutes: null,
        isMain: true,
      },
      {
        taskId: 'B',
        title: 'Focus B',
        status: 'pending_start',
        load: 'low',
        lane: 'backup',
        expectedMinutes: 15,
        waitMinutes: null,
        isMain: false,
      },
    ]);
    firstMainSelectionPending.set({ taskId: 'A', expiresAt: Date.now() + 15000 });
    component.onDockCardClick('B');
    expect(mockEngine.overrideFirstMainTask).toHaveBeenCalledWith('B');
    expect(mockEngine.setMainTask).not.toHaveBeenCalled();
  });

  it('focus scrim should still allow switching the dock main task', () => {
    const { component, dockedEntries, focusMode, focusScrimOn, mockEngine } = getContext();
    dockedEntries.set([
      {
        taskId: 'focus-main',
        title: 'Focus Main',
        status: 'focusing',
        load: 'low',
        lane: 'backup',
        expectedMinutes: 25,
        waitMinutes: null,
        isMain: true,
      },
      {
        taskId: 'focus-target',
        title: 'Focus Target',
        status: 'pending_start',
        load: 'low',
        lane: 'backup',
        expectedMinutes: 15,
        waitMinutes: null,
        isMain: false,
      },
    ]);
    focusMode.set(true);
    focusScrimOn.set(true);

    component.onDockCardClick('focus-target');

    expect(mockEngine.setMainTask).toHaveBeenCalledWith('focus-target');
  });

  it('clicking the dock main card should bring it back to C position when another task is in front', () => {
    const { component, dockedEntries, focusMode, focusScrimOn, mockEngine } = getContext();
    dockedEntries.set([
      {
        taskId: 'focus-main',
        title: 'Focus Main',
        status: 'stalled',
        load: 'low',
        lane: 'backup',
        expectedMinutes: 25,
        waitMinutes: null,
        isMain: true,
      },
      {
        taskId: 'focus-secondary',
        title: 'Focus Secondary',
        status: 'focusing',
        load: 'low',
        lane: 'combo-select',
        expectedMinutes: 15,
        waitMinutes: null,
        isMain: false,
      },
    ]);
    focusMode.set(true);
    focusScrimOn.set(true);

    component.onDockCardClick('focus-main');

    expect(mockEngine.setMainTask).toHaveBeenCalledWith('focus-main');
    expect(component.helpFeedback.dockActionFeedback()?.message).toContain('已切换到前台');
  });

  it('main dock cards should not show backup or combo lane labels', () => {
    const { fixture, dockedEntries } = getContext();
    dockedEntries.set([
      {
        taskId: 'main-backup',
        title: 'Main Backup Task',
        status: 'pending_start',
        load: 'low',
        lane: 'backup',
        expectedMinutes: 25,
        waitMinutes: null,
        isMain: true,
      },
    ]);
    fixture.detectChanges();

    const card = fixture.nativeElement.querySelector('[data-testid="dock-v3-item"]') as HTMLElement | null;
    const text = card?.textContent ?? '';
    const mainLabelMatches = text.match(/主任务/g) ?? [];

    expect(text).toContain('主任务');
    expect(mainLabelMatches).toHaveLength(1);
    expect(text).not.toContain('副任务');
    expect(text).not.toContain('组合选择');
  });

  it('should render visible first-main override hint during 15s window', () => {
    const { fixture, firstMainSelectionPending } = getContext();
    firstMainSelectionPending.set({ taskId: 'A', expiresAt: Date.now() + 15000 });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-first-main-hint"]')).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('15 秒内');
  });

  it('hud minimal mode should use fixed top-center width', () => {
    const { component, focusMode, focusScrimOn } = getContext();
    focusMode.set(true);
    focusScrimOn.set(false);
    const style = component.hudContainerStyle();
    expect(style.top).toBe('16px');
    expect(style.left).toBe('50%');
    expect(style.width).toBe('200px');
  });

  it('mobile hud minimal mode should sit lower in the top-center area for better visual balance', () => {
    const { component, uiState, focusMode, focusScrimOn } = getContext();
    uiState.isMobile.set(true);
    focusMode.set(true);
    focusScrimOn.set(false);

    const style = component.hudContainerStyle();

    expect(style.top).toBe(`calc(env(safe-area-inset-top) + ${PARKING_CONFIG.HUD_MINIMAL_MOBILE_TOP_PX}px)`);
    expect(style.left).toBe('50%');
    expect(style.width).toBe('200px');
  });
}
