import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const remoteCallbacks = { teardown: vi.fn() };
  const sessionLifecycle = { remoteCallbacks };
  const shellLifecycle = { destroyController: {} };

  return {
    remoteCallbacks,
    sessionLifecycle,
    shellLifecycle,
    createWorkspaceShellLifecycleSurface: vi.fn(() => shellLifecycle),
    createWorkspaceShellSessionLifecycleSurface:
      vi.fn(() => sessionLifecycle),
  };
});

async function loadFactory(): Promise<
  typeof import('./workspace-shell-lifecycle-graph.factory')
> {
  vi.resetModules();
  vi.doMock('./workspace-shell-lifecycle-surface.factory', () => ({
    createWorkspaceShellLifecycleSurface:
      mocks.createWorkspaceShellLifecycleSurface,
  }));
  vi.doMock('./workspace-shell-session-lifecycle-surface.factory', () => ({
    createWorkspaceShellSessionLifecycleSurface:
      mocks.createWorkspaceShellSessionLifecycleSurface,
  }));

  return import('./workspace-shell-lifecycle-graph.factory');
}

describe('createWorkspaceShellLifecycleGraph', () => {
  it('builds session lifecycle before shell lifecycle and returns template bindings', async () => {
    vi.clearAllMocks();
    const { createWorkspaceShellLifecycleGraph } = await loadFactory();
    try {
      const runtime = vi.fn(() => false);
      const markDestroyed = vi.fn();
      const template = { state: {} };
      const options = {
        runtime,
        markDestroyed,
        template,
        baseMarker: 'base',
        routingMarker: 'routing',
        interactionMarker: 'interaction',
        startupMarker: 'startup',
      };

      const graph = createWorkspaceShellLifecycleGraph(
        options as unknown as Parameters<typeof createWorkspaceShellLifecycleGraph>[0],
      );

      expect(mocks.createWorkspaceShellSessionLifecycleSurface)
        .toHaveBeenCalledWith(options);
      expect(mocks.createWorkspaceShellLifecycleSurface).toHaveBeenCalledWith({
        ...options,
        ...mocks.sessionLifecycle,
        destroyed: runtime,
        markDestroyed,
        remoteCallbackTeardown: mocks.remoteCallbacks,
      });
      expect(graph).toEqual({
        shellLifecycle: mocks.shellLifecycle,
        template,
      });
    } finally {
      vi.doUnmock('./workspace-shell-lifecycle-surface.factory');
      vi.doUnmock('./workspace-shell-session-lifecycle-surface.factory');
    }
  });
});
