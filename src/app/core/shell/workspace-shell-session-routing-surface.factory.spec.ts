import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const chrome = { focusChrome: {} };
  const focusSyncControllers = { mountState: {} };
  const routing = { routeUrl: vi.fn() };
  const sessionExitSurface = { sessionExit: {} };
  const storageEscape = { setup: vi.fn() };

  return {
    chrome,
    focusSyncControllers,
    routing,
    sessionExitSurface,
    storageEscape,
    createWorkspaceShellChromeSurface: vi.fn(() => chrome),
    createWorkspaceShellFocusSyncSurface: vi.fn(() => focusSyncControllers),
    createWorkspaceShellRoutingSurface: vi.fn(() => routing),
    createWorkspaceShellSessionExitSurface: vi.fn((_options: unknown) => sessionExitSurface),
    createWorkspaceShellStorageEscapeDelegates: vi.fn(() => storageEscape),
  };
});

vi.mock('./workspace-shell-chrome-surface.factory', () => ({
  createWorkspaceShellChromeSurface: mocks.createWorkspaceShellChromeSurface,
}));

vi.mock('./workspace-shell-focus-sync-surface.factory', () => ({
  createWorkspaceShellFocusSyncSurface: mocks.createWorkspaceShellFocusSyncSurface,
}));

vi.mock('./workspace-shell-routing-surface.factory', () => ({
  createWorkspaceShellRoutingSurface: mocks.createWorkspaceShellRoutingSurface,
}));

vi.mock('./workspace-shell-session-exit-surface.factory', () => ({
  createWorkspaceShellSessionExitSurface: mocks.createWorkspaceShellSessionExitSurface,
}));

vi.mock('./workspace-shell-storage-escape-delegates.factory', () => ({
  createWorkspaceShellStorageEscapeDelegates:
    mocks.createWorkspaceShellStorageEscapeDelegates,
}));

describe('createWorkspaceShellSessionRoutingSurface', () => {
  it('builds focus sync first and lends it to the session exit surface lazily', async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const {
      createWorkspaceShellSessionRoutingSurface,
    } = await import('./workspace-shell-session-routing-surface.factory');
    const runtime = vi.fn(() => false);
    const options = { runtime, warn: vi.fn() };

    const surface = createWorkspaceShellSessionRoutingSurface(
      options as unknown as Parameters<typeof createWorkspaceShellSessionRoutingSurface>[0],
    );

    // focus sync surface 把 runtime 归一化为 isDestroyed
    expect(mocks.createWorkspaceShellFocusSyncSurface).toHaveBeenCalledWith(
      expect.objectContaining({ isDestroyed: runtime }),
    );

    const sessionExitOptions =
      mocks.createWorkspaceShellSessionExitSurface.mock.calls[0]?.[0] as {
        focusSyncControllers: () => unknown;
      };

    // session exit 通过访问器惰性借用同一 focusSyncControllers 实例
    expect(sessionExitOptions.focusSyncControllers()).toBe(mocks.focusSyncControllers);
    expect(mocks.createWorkspaceShellChromeSurface).toHaveBeenCalledTimes(1);
    expect(mocks.createWorkspaceShellRoutingSurface).toHaveBeenCalledTimes(1);
    expect(mocks.createWorkspaceShellStorageEscapeDelegates).toHaveBeenCalledTimes(1);
    expect(surface).toEqual({
      chrome: mocks.chrome,
      focusSyncControllers: mocks.focusSyncControllers,
      routing: mocks.routing,
      sessionExitSurface: mocks.sessionExitSurface,
      storageEscape: mocks.storageEscape,
    });
  });
});
