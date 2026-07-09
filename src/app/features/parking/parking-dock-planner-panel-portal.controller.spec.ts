import type { ElementRef } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ParkingDockPlannerPanelPortalController } from './parking-dock-planner-panel-portal.controller';

function createPanelContext(): {
  readonly parent: HTMLElement;
  readonly panel: HTMLElement;
  readonly sibling: HTMLElement;
  readonly focus: ReturnType<typeof vi.fn>;
  readonly scrollIntoView: ReturnType<typeof vi.fn>;
  readonly panelRef: () => ElementRef<HTMLElement>;
} {
  const parent = document.createElement('section');
  const panel = document.createElement('div');
  const sibling = document.createElement('div');
  const focus = vi.fn();
  const scrollIntoView = vi.fn();

  panel.focus = focus;
  panel.scrollIntoView = scrollIntoView;
  parent.append(panel, sibling);
  document.body.appendChild(parent);

  return {
    parent,
    panel,
    sibling,
    focus,
    scrollIntoView,
    panelRef: () => ({ nativeElement: panel }),
  };
}

describe('ParkingDockPlannerPanelPortalController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('portals sheet panels to document.body and restores them before the original sibling', () => {
    const { parent, panel, sibling, panelRef } = createPanelContext();
    const controller = new ParkingDockPlannerPanelPortalController(panelRef);

    controller.scheduleOpen('sheet');
    vi.advanceTimersByTime(0);

    expect(panel.parentElement).toBe(document.body);

    controller.restore();

    expect(panel.parentElement).toBe(parent);
    expect(panel.nextSibling).toBe(sibling);
  });

  it('keeps popover panels inline while focusing and scrolling them into view', () => {
    const { parent, panel, focus, scrollIntoView, panelRef } = createPanelContext();
    const controller = new ParkingDockPlannerPanelPortalController(panelRef);

    controller.scheduleOpen('popover');
    vi.advanceTimersByTime(0);

    expect(panel.parentElement).toBe(parent);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'nearest' });
  });

  it('cancels a delayed open when restored before the delay elapses', () => {
    const { parent, panel, focus, panelRef } = createPanelContext();
    const controller = new ParkingDockPlannerPanelPortalController(panelRef);

    controller.scheduleOpen('sheet', 50);
    controller.restore();
    vi.advanceTimersByTime(50);

    expect(panel.parentElement).toBe(parent);
    expect(focus).not.toHaveBeenCalled();
  });
});
