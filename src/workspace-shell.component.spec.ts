import { vi, describe, it, expect } from 'vitest';
import { WorkspaceShellComponent } from './workspace-shell.component';
import {
  createWorkspaceShellComponentLifecycleContext,
  initializeWorkspaceShellComponentConstructor,
} from './app/core/shell/workspace-shell-component.spec-helpers';

describe('WorkspaceShellComponent lifecycle delegation', () => {
  it('constructor 应委托 startup bootstrap lifecycle controller', () => {
    const { context, shellLifecycle } =
      createWorkspaceShellComponentLifecycleContext();

    initializeWorkspaceShellComponentConstructor(context);

    expect(shellLifecycle.startupBootstrap.initialize).toHaveBeenCalledTimes(1);
  });

  it('ngOnInit 应委托启动编排 controller', () => {
    const { context, shellLifecycle } =
      createWorkspaceShellComponentLifecycleContext();

    WorkspaceShellComponent.prototype.ngOnInit.call(context);

    expect(shellLifecycle.ngOnInitStartup.initialize).toHaveBeenCalledTimes(1);
  });

  it('ngAfterViewInit 应委托 after-view-init lifecycle controller', () => {
    const scheduleAggressivePrewarm = vi.fn();
    const { context, shellLifecycle } =
      createWorkspaceShellComponentLifecycleContext({
      flowPrewarm: { scheduleAggressivePrewarm },
    });

    WorkspaceShellComponent.prototype.ngAfterViewInit.call(context);

    expect(shellLifecycle.afterViewInit.initialize).toHaveBeenCalledTimes(1);
    expect(scheduleAggressivePrewarm).not.toHaveBeenCalled();
  });

  it('ngOnDestroy 应委托 destroy controller 统一清理 shell 生命周期资源', () => {
    const teardown = vi.fn();
    const { context, shellLifecycle } =
      createWorkspaceShellComponentLifecycleContext({
      flowPrewarm: { teardown },
    });

    WorkspaceShellComponent.prototype.ngOnDestroy.call(context);

    expect(teardown).not.toHaveBeenCalled();
    expect(shellLifecycle.destroyController.destroy).toHaveBeenCalledTimes(1);
  });

});
