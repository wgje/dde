import { describe, expect, it, vi } from 'vitest';
import type { Injector } from '@angular/core';

import {
  createWorkspaceShellLazyLifecycleDelegates,
  type WorkspaceShellLazyLifecycleDelegatesOptions,
} from './workspace-shell-lazy-lifecycle-delegates.factory';
import type {
  WorkspaceShellLazyLifecycleGroupControllerLike,
} from './workspace-shell-lazy-lifecycle-group.factory';
import {
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellLifecycleGraphSource,
  readWorkspaceShellLifecycleSurfaceSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

function createOptions(
  overrides: Partial<WorkspaceShellLazyLifecycleDelegatesOptions> = {},
): WorkspaceShellLazyLifecycleDelegatesOptions {
  return {
    runtime: { destroyed: () => false },
    injector: {} as Injector,
    warn: vi.fn(),
    ...overrides,
  };
}

function createController(): WorkspaceShellLazyLifecycleGroupControllerLike {
  return {
    initializeConstructorStage: vi.fn(),
    initializeNgOnInitStage: vi.fn(),
    teardownKeyboardShortcutsStage: vi.fn(),
    teardownStartupStage: vi.fn(),
  };
}

describe('createWorkspaceShellLazyLifecycleDelegates', () => {
  it('keeps lazy lifecycle group wiring behind the shell lifecycle boundary', () => {
    const componentSource = readWorkspaceShellSource();
    const graphSource = readWorkspaceShellControllerGraphSource();
    const lifecycleGraphSource = readWorkspaceShellLifecycleGraphSource();
    const lifecycleSurfaceSource = readWorkspaceShellLifecycleSurfaceSource();

    expect(graphSource).toContain('createWorkspaceShellLifecycleGraph');
    expect(lifecycleGraphSource).toContain('createWorkspaceShellLifecycleSurface');
    expect(lifecycleSurfaceSource).toContain('createWorkspaceShellLifecycleDelegates');
    expect(componentSource).not.toContain('createWorkspaceShellLazyLifecycleDelegates');
    expect(componentSource).not.toContain('createWorkspaceShellLazyLifecycleGroupController');
  });

  it('adapts shell-level lifecycle dependencies into the lazy lifecycle group factory', () => {
    const destroyed = vi.fn(() => false);
    const injector = {} as Injector;
    const warn = vi.fn();
    const controller = createController();
    const createLazyLifecycleGroup = vi.fn(() => controller);

    const delegates = createWorkspaceShellLazyLifecycleDelegates(createOptions({
      createLazyLifecycleGroup,
      injector,
      runtime: { destroyed },
      warn,
    }));

    expect(delegates).toBe(controller);
    expect(createLazyLifecycleGroup).toHaveBeenCalledWith({
      injector,
      runtime: { destroyed },
      warn,
    });
  });
});
