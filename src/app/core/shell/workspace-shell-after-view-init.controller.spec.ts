import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellAfterViewInitController } from './workspace-shell-after-view-init.controller';

describe('WorkspaceShellAfterViewInitController', () => {
  it('signals workspace handoff readiness during after-view-init initialization', () => {
    const signalWorkspaceHandoffReady = vi.fn();
    const scheduleAggressivePrewarm = vi.fn();
    const controller = new WorkspaceShellAfterViewInitController({
      handoffReadiness: { signalWorkspaceHandoffReady },
      flowPrewarm: { scheduleAggressivePrewarm },
    });

    controller.initialize();

    expect(signalWorkspaceHandoffReady).toHaveBeenCalledTimes(1);
    expect(scheduleAggressivePrewarm).toHaveBeenCalledWith('workspace-after-view-init');
    expect(signalWorkspaceHandoffReady.mock.invocationCallOrder[0]).toBeLessThan(
      scheduleAggressivePrewarm.mock.invocationCallOrder[0],
    );
  });
});
