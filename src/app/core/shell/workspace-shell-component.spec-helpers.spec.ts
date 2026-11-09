import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellComponentLifecycleContext,
  initializeWorkspaceShellComponentConstructor,
} from './workspace-shell-component.spec-helpers';

describe('workspace shell component spec helpers', () => {
  it('creates a component context with lifecycle controller fakes', () => {
    const overrideValue = { teardown: vi.fn() };
    const { context, shellLifecycle } =
      createWorkspaceShellComponentLifecycleContext({
        flowPrewarm: overrideValue,
      });

    expect(context).toMatchObject({
      flowPrewarm: overrideValue,
      shellLifecycle,
    });

    shellLifecycle.ngOnInitStartup.initialize();
    shellLifecycle.afterViewInit.initialize();
    shellLifecycle.destroyController.destroy();

    expect(shellLifecycle.ngOnInitStartup.initialize).toHaveBeenCalledOnce();
    expect(shellLifecycle.afterViewInit.initialize).toHaveBeenCalledOnce();
    expect(shellLifecycle.destroyController.destroy).toHaveBeenCalledOnce();
  });

  it('initializes constructor startup through the shared lifecycle context', () => {
    const { context, shellLifecycle } =
      createWorkspaceShellComponentLifecycleContext();

    initializeWorkspaceShellComponentConstructor(context);

    expect(shellLifecycle.startupBootstrap.initialize).toHaveBeenCalledOnce();
  });
});
