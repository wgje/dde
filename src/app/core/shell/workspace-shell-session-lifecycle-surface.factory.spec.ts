import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const projectSubscription = { clear: vi.fn() };
  const remoteCallbacks = { teardown: vi.fn() };
  const sessionLaunchControllers = { sessionTransition: {} };
  const signalEffects = { setup: vi.fn() };

  return {
    projectSubscription,
    remoteCallbacks,
    sessionLaunchControllers,
    signalEffects,
    createWorkspaceShellProjectSubscriptionDelegate: vi.fn(() => projectSubscription),
    createWorkspaceShellRemoteCallbacksDelegate: vi.fn(() => remoteCallbacks),
    createWorkspaceShellSessionLaunchSurface: vi.fn(() => sessionLaunchControllers),
    createWorkspaceShellSignalEffectsSurface: vi.fn(() => signalEffects),
  };
});

vi.mock('./workspace-shell-project-subscription-options.factory', () => ({
  createWorkspaceShellProjectSubscriptionDelegate:
    mocks.createWorkspaceShellProjectSubscriptionDelegate,
}));

vi.mock('./workspace-shell-remote-callbacks-options.factory', () => ({
  createWorkspaceShellRemoteCallbacksDelegate:
    mocks.createWorkspaceShellRemoteCallbacksDelegate,
}));

vi.mock('./workspace-shell-session-launch-options.factory', () => ({
  createWorkspaceShellSessionLaunchSurface:
    mocks.createWorkspaceShellSessionLaunchSurface,
}));

vi.mock('./workspace-shell-signal-effects-surface.factory', () => ({
  createWorkspaceShellSignalEffectsSurface:
    mocks.createWorkspaceShellSignalEffectsSurface,
}));

describe('createWorkspaceShellSessionLifecycleSurface', () => {
  it('shares the project subscription and session launch surfaces with the signal effects surface', async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const {
      createWorkspaceShellSessionLifecycleSurface,
    } = await import('./workspace-shell-session-lifecycle-surface.factory');
    const runtime = vi.fn(() => false);
    const options = { runtime, warn: vi.fn() };

    const surface = createWorkspaceShellSessionLifecycleSurface(
      options as unknown as Parameters<typeof createWorkspaceShellSessionLifecycleSurface>[0],
    );

    expect(mocks.createWorkspaceShellProjectSubscriptionDelegate).toHaveBeenCalledTimes(1);
    // 会话启动 surface 必须复用同一 projectSubscription，避免出现双份订阅状态
    expect(mocks.createWorkspaceShellSessionLaunchSurface).toHaveBeenCalledWith(
      expect.objectContaining({ projectSubscription: mocks.projectSubscription }),
    );
    // signal effects 聚合其余三个 surface，并把 runtime 归一化为 destroyed
    expect(mocks.createWorkspaceShellSignalEffectsSurface).toHaveBeenCalledWith(
      expect.objectContaining({
        projectSubscription: mocks.projectSubscription,
        remoteCallbacks: mocks.remoteCallbacks,
        sessionLaunchControllers: mocks.sessionLaunchControllers,
        destroyed: runtime,
      }),
    );
    expect(surface).toEqual({
      projectSubscription: mocks.projectSubscription,
      remoteCallbacks: mocks.remoteCallbacks,
      sessionLaunchControllers: mocks.sessionLaunchControllers,
      signalEffects: mocks.signalEffects,
    });
  });
});
