import { signal } from '@angular/core';

import { TimerHandle } from '../../../utils/timer-handle';

export type ParkingDockExitFlowStep = 'primary' | 'destructive';

const DOCK_CLOSE_TRANSIENT_SURFACES_EVENT = 'dock-close-transient-surfaces';

interface ParkingDockTransientSurfaceControllerOptions {
  readonly plannerQuickEditTaskId: () => string | null;
  readonly closePlannerQuickEdit: () => void;
  readonly waitPresetTaskId: () => string | null;
  readonly showHelpOverlay: () => boolean;
  readonly closeHelpOverlay: () => void;
}

export class ParkingDockTransientSurfaceController {
  readonly showExitConfirm = signal(false);
  readonly exitFlowStep = signal<ParkingDockExitFlowStep>('primary');

  private readonly exitFocusTimer = new TimerHandle();

  constructor(private readonly options: ParkingDockTransientSurfaceControllerOptions) {}

  openExitConfirm(): void {
    this.exitFlowStep.set('primary');
    this.showExitConfirm.set(true);
    this.focusExitConfirmPrimaryAction();
  }

  resetExitFlow(): void {
    this.showExitConfirm.set(false);
    this.exitFlowStep.set('primary');
  }

  closeFirst(): boolean {
    if (this.options.plannerQuickEditTaskId()) {
      this.options.closePlannerQuickEdit();
      return true;
    }

    if (this.options.waitPresetTaskId() != null) {
      this.dispatchCloseTransientSurfaceEvent();
      return true;
    }

    if (this.options.showHelpOverlay()) {
      this.options.closeHelpOverlay();
      return true;
    }

    if (this.showExitConfirm()) {
      if (this.exitFlowStep() === 'destructive') {
        this.exitFlowStep.set('primary');
        this.focusExitConfirmPrimaryAction();
      } else {
        this.showExitConfirm.set(false);
      }
      return true;
    }

    return false;
  }

  focusExitConfirmPrimaryAction(): void {
    if (typeof document === 'undefined') return;
    this.exitFocusTimer.schedule(() => {
      const selector = this.exitFlowStep() === 'destructive'
        ? '[data-testid="dock-v3-exit-save"]'
        : '[data-testid="dock-v3-exit-cancel"]';
      const primary = document.querySelector<HTMLElement>(selector);
      primary?.focus();
    }, 0);
  }

  destroy(): void {
    this.exitFocusTimer.cancel();
  }

  private dispatchCloseTransientSurfaceEvent(): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(DOCK_CLOSE_TRANSIENT_SURFACES_EVENT));
  }
}
