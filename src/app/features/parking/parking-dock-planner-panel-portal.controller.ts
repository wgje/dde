import type { ElementRef } from '@angular/core';

import { TimerHandle } from '../../../utils/timer-handle';

export type PlannerPanelPresentation = 'popover' | 'sheet';

export class ParkingDockPlannerPanelPortalController {
  private originalParent: Node | null = null;
  private originalNextSibling: ChildNode | null = null;
  private portaledPanel: HTMLElement | null = null;
  private readonly autoFocus = new TimerHandle();

  constructor(private readonly panelRef: () => ElementRef<HTMLElement> | undefined) {}

  scheduleOpen(presentation: PlannerPanelPresentation, delayMs = 0): void {
    this.autoFocus.schedule(() => {
      this.syncPortal(presentation);
      this.focusPanel();
      this.scrollPanelIntoView(presentation);
    }, delayMs);
  }

  restore(): void {
    this.autoFocus.cancel();

    const panel = this.portaledPanel;
    if (!panel) return;

    const parent = this.originalParent;
    if (parent instanceof HTMLElement && parent.isConnected) {
      const nextSibling = this.originalNextSibling?.parentNode === parent
        ? this.originalNextSibling
        : null;
      parent.insertBefore(panel, nextSibling);
    } else if (panel.isConnected) {
      panel.remove();
    }

    this.portaledPanel = null;
    this.originalParent = null;
    this.originalNextSibling = null;
  }

  destroy(): void {
    this.restore();
  }

  private syncPortal(presentation: PlannerPanelPresentation): void {
    if (typeof document === 'undefined') return;

    const panel = this.panelRef()?.nativeElement ?? null;
    if (!panel) {
      this.restore();
      return;
    }

    if (presentation !== 'sheet') {
      this.restore();
      return;
    }

    if (panel.parentElement === document.body) return;

    this.originalParent = panel.parentNode;
    this.originalNextSibling = panel.nextSibling;
    this.portaledPanel = panel;
    document.body.appendChild(panel);
  }

  private focusPanel(): void {
    this.panelRef()?.nativeElement.focus();
  }

  private scrollPanelIntoView(presentation: PlannerPanelPresentation): void {
    if (presentation !== 'popover') return;
    this.panelRef()?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}
