import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LinkActionMenu,
  LinkDeleteHint,
} from '../../../../models/flow-view-state';
import { FlowLinkTransientUiController } from './flow-link-transient-ui.controller';

describe('FlowLinkTransientUiController', () => {
  let destroyed = false;
  let linkDeleteHint: ReturnType<typeof signal<LinkDeleteHint | null>>;
  let linkActionMenu: ReturnType<typeof signal<LinkActionMenu | null>>;
  let controller: FlowLinkTransientUiController;

  beforeEach(() => {
    vi.useFakeTimers();
    destroyed = false;
    linkDeleteHint = signal<LinkDeleteHint | null>(null);
    linkActionMenu = signal<LinkActionMenu | null>(null);
    controller = new FlowLinkTransientUiController({
      isDestroyed: () => destroyed,
      linkDeleteHint,
      linkActionMenu,
    });
  });

  afterEach(() => {
    controller.clearAll();
    vi.runOnlyPendingTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('auto-hides the current delete hint after the legacy timeout', () => {
    const linkData = { from: 'source-task', to: 'target-task', isCrossTree: true };

    controller.showDeleteHint(linkData, 20, 40);

    expect(linkDeleteHint()).toMatchObject({ x: 20, y: 40, isCrossTree: true });
    vi.advanceTimersByTime(3000);
    expect(linkDeleteHint()).toBeNull();
  });

  it('showing an action menu cancels the pending delete hint', () => {
    controller.showDeleteHint({ from: 'a', to: 'b', isCrossTree: true }, 10, 20);
    controller.showActionMenu({ from: 'c', to: 'd', isCrossTree: false }, 30, 40);

    expect(linkDeleteHint()).toBeNull();
    expect(linkActionMenu()).toMatchObject({ x: 30, y: 40, isCrossTree: false });
  });

  it('does not auto-hide when the owning service has been destroyed', () => {
    controller.showActionMenu({ from: 'a', to: 'b', isCrossTree: true }, 10, 20);
    destroyed = true;

    vi.advanceTimersByTime(5000);

    expect(linkActionMenu()).toMatchObject({ x: 10, y: 20, isCrossTree: true });
  });

  it('clearAll cancels timers and resets transient state', () => {
    controller.showDeleteHint({ from: 'a', to: 'b', isCrossTree: true }, 10, 20);
    controller.showActionMenu({ from: 'c', to: 'd', isCrossTree: false }, 30, 40);

    controller.clearAll();
    vi.advanceTimersByTime(5000);

    expect(linkDeleteHint()).toBeNull();
    expect(linkActionMenu()).toBeNull();
  });

  it('cancels zero-valued timer handles for transient overlays', () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'setTimeout')
      .mockImplementation(() => 0 as unknown as ReturnType<typeof setTimeout>);

    controller.showDeleteHint({ from: 'a', to: 'b', isCrossTree: true }, 10, 20);
    controller.cancelDeleteHint();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);

    clearTimeoutSpy.mockClear();

    controller.showActionMenu({ from: 'c', to: 'd', isCrossTree: false }, 30, 40);
    controller.cancelActionMenu();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
  });
});
