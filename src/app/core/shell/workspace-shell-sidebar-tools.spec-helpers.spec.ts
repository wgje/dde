import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellSidebarToolsDeferred,
  createWorkspaceShellSidebarToolsSpecDelegate,
  expectWorkspaceShellSidebarToolsLoadsOnce,
  flushWorkspaceShellSidebarToolsMicrotasks,
} from './workspace-shell-sidebar-tools.spec-helpers';
import {
  WorkspaceShellSidebarToolsLazyLoadHostController,
} from './workspace-shell-sidebar-tools-lazy-load-host.controller';

describe('workspace shell sidebar tools spec helpers', () => {
  it('creates sidebar tools delegates that track preload and teardown calls', () => {
    const delegate = createWorkspaceShellSidebarToolsSpecDelegate();

    delegate.onVoiceTranscribed('capture');
    delegate.onToolsIntent();
    delegate.preload('p1');
    delegate.scheduleFocusModePreload('startup');
    delegate.teardown();

    expect(delegate.onVoiceTranscribed).toHaveBeenCalledWith('capture');
    expect(delegate.onToolsIntent).toHaveBeenCalledTimes(1);
    expect(delegate.preload).toHaveBeenCalledWith('p1');
    expect(delegate.scheduleFocusModePreload).toHaveBeenCalledWith('startup');
    expect(delegate.teardown).toHaveBeenCalledTimes(1);
  });

  it('creates deferred sidebar tools promises for lazy host specs', async () => {
    const deferred = createWorkspaceShellSidebarToolsDeferred<string>();

    deferred.resolve('loaded');
    await flushWorkspaceShellSidebarToolsMicrotasks();

    await expect(deferred.promise).resolves.toBe('loaded');
  });

  it('asserts sidebar tools loads once through the shared lazy helper', async () => {
    await expectWorkspaceShellSidebarToolsLoadsOnce({
      createController: loadSidebarTools => new WorkspaceShellSidebarToolsLazyLoadHostController({
        createSidebarToolsController: loadSidebarTools,
        warn: vi.fn(),
      }),
      createSidebarTools: createWorkspaceShellSidebarToolsSpecDelegate,
    });
  });
});
