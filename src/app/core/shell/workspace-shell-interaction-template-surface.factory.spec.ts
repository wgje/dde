import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellInteractionTemplateSurface,
} from './workspace-shell-interaction-template-surface.factory';
import type {
  WorkspaceShellInteractionLazyLoadDelegates,
} from './workspace-shell-interaction-lazy-load-delegates.factory';

describe('createWorkspaceShellInteractionTemplateSurface', () => {
  it('projects only the template-facing interaction delegates', () => {
    const actions = { openSettings: vi.fn() };
    const sidebarResize = { startSidebarResize: vi.fn() };
    const touchGestures = { onMainTouchStart: vi.fn() };
    const delegates = {
      actions,
      sidebarResize,
      touchGestures,
      modalLazyLoad: { actions: {} },
      viewportResize: { teardown: vi.fn() },
    } as unknown as WorkspaceShellInteractionLazyLoadDelegates;

    const surface = createWorkspaceShellInteractionTemplateSurface(delegates);

    // 模板层只暴露 actions/sidebarResize/touchGestures 三个交互面，
    // 其余 lazy-load 委托不得泄漏进模板 surface
    expect(surface).toEqual({ actions, sidebarResize, touchGestures });
    expect(surface.actions).toBe(actions);
    expect(surface.sidebarResize).toBe(sidebarResize);
    expect(surface.touchGestures).toBe(touchGestures);
    expect(Object.keys(surface)).toHaveLength(3);
  });
});
