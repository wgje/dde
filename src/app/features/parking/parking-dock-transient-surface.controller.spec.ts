import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { ParkingDockTransientSurfaceController } from './parking-dock-transient-surface.controller';

interface TransientSurfaceSpecState {
  plannerTaskId: string | null;
  waitPresetTaskId: string | null;
  helpOverlayVisible: boolean;
}

function createController(
  state: TransientSurfaceSpecState,
  callbacks: {
    readonly closePlannerQuickEdit?: Mock<() => void>;
    readonly closeHelpOverlay?: Mock<() => void>;
  } = {},
): ParkingDockTransientSurfaceController {
  return new ParkingDockTransientSurfaceController({
    plannerQuickEditTaskId: () => state.plannerTaskId,
    closePlannerQuickEdit: callbacks.closePlannerQuickEdit ?? vi.fn(),
    waitPresetTaskId: () => state.waitPresetTaskId,
    showHelpOverlay: () => state.helpOverlayVisible,
    closeHelpOverlay: callbacks.closeHelpOverlay ?? vi.fn(() => {
      state.helpOverlayVisible = false;
    }),
  });
}

function createState(overrides: Partial<TransientSurfaceSpecState> = {}): TransientSurfaceSpecState {
  return {
    plannerTaskId: null,
    waitPresetTaskId: null,
    helpOverlayVisible: false,
    ...overrides,
  };
}

describe('ParkingDockTransientSurfaceController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('closes planner quick edit before other transient surfaces', () => {
    const closePlannerQuickEdit = vi.fn();
    const state = createState({
      plannerTaskId: 'task-1',
      waitPresetTaskId: 'task-2',
      helpOverlayVisible: true,
    });
    const controller = createController(state, { closePlannerQuickEdit });

    expect(controller.closeFirst()).toBe(true);

    expect(closePlannerQuickEdit).toHaveBeenCalledTimes(1);
    expect(controller.showExitConfirm()).toBe(false);
  });

  it('dispatches the wait-menu close event when a wait preset menu is visible', () => {
    const listener = vi.fn();
    window.addEventListener('dock-close-transient-surfaces', listener);
    const controller = createController(createState({ waitPresetTaskId: 'task-1' }));

    expect(controller.closeFirst()).toBe(true);

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('dock-close-transient-surfaces', listener);
  });

  it('closes help overlay before exit confirmation', () => {
    const closeHelpOverlay = vi.fn();
    const controller = createController(createState({ helpOverlayVisible: true }), { closeHelpOverlay });
    controller.openExitConfirm();

    expect(controller.closeFirst()).toBe(true);

    expect(closeHelpOverlay).toHaveBeenCalledTimes(1);
    expect(controller.showExitConfirm()).toBe(true);
  });

  it('steps destructive exit confirmation back to the primary choice and restores focus', () => {
    const cancelButton = document.createElement('button');
    const focus = vi.fn();
    cancelButton.dataset.testid = 'dock-v3-exit-cancel';
    cancelButton.focus = focus;
    document.body.append(cancelButton);

    const controller = createController(createState());
    controller.showExitConfirm.set(true);
    controller.exitFlowStep.set('destructive');

    expect(controller.closeFirst()).toBe(true);
    vi.advanceTimersByTime(0);

    expect(controller.showExitConfirm()).toBe(true);
    expect(controller.exitFlowStep()).toBe('primary');
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('hides primary exit confirmation', () => {
    const controller = createController(createState());
    controller.showExitConfirm.set(true);

    expect(controller.closeFirst()).toBe(true);

    expect(controller.showExitConfirm()).toBe(false);
    expect(controller.exitFlowStep()).toBe('primary');
  });

  it('opens exit confirmation on the primary step and focuses its primary action', () => {
    const cancelButton = document.createElement('button');
    const focus = vi.fn();
    cancelButton.dataset.testid = 'dock-v3-exit-cancel';
    cancelButton.focus = focus;
    document.body.append(cancelButton);

    const controller = createController(createState());
    controller.exitFlowStep.set('destructive');

    controller.openExitConfirm();
    vi.advanceTimersByTime(0);

    expect(controller.showExitConfirm()).toBe(true);
    expect(controller.exitFlowStep()).toBe('primary');
    expect(focus).toHaveBeenCalledTimes(1);
  });
});
