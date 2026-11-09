import { vi, type Mock } from 'vitest';

import type { WorkspaceShellComponent } from '../../../workspace-shell.component';

type WorkspaceShellLifecycleMock = Mock<() => void>;

type WorkspaceShellComponentLifecycle = {
  readonly startupBootstrap: {
    initialize: WorkspaceShellLifecycleMock;
  };
  readonly ngOnInitStartup: {
    initialize: WorkspaceShellLifecycleMock;
  };
  readonly afterViewInit: {
    initialize: WorkspaceShellLifecycleMock;
  };
  readonly destroyController: {
    destroy: WorkspaceShellLifecycleMock;
  };
};

export type WorkspaceShellComponentLifecycleContext = {
  readonly context: WorkspaceShellComponent;
  readonly shellLifecycle: WorkspaceShellComponentLifecycle;
};

export function createWorkspaceShellComponentLifecycleContext(
  overrides: Record<string, unknown> = {},
): WorkspaceShellComponentLifecycleContext {
  const shellLifecycle: WorkspaceShellComponentLifecycle = {
    startupBootstrap: { initialize: vi.fn() },
    ngOnInitStartup: { initialize: vi.fn() },
    afterViewInit: { initialize: vi.fn() },
    destroyController: { destroy: vi.fn() },
  };

  return {
    context: {
      shellLifecycle,
      ...overrides,
    } as unknown as WorkspaceShellComponent,
    shellLifecycle,
  };
}

export function initializeWorkspaceShellComponentConstructor(
  context: WorkspaceShellComponent,
): void {
  const lifecycleContext = context as unknown as {
    shellLifecycle: WorkspaceShellComponentLifecycle;
  };

  lifecycleContext.shellLifecycle.startupBootstrap.initialize();
}
