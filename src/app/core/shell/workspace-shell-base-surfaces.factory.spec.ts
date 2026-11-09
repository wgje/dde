import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const lazyServiceRefs = { blackBoxService: {} };
  const launchSnapshotSurface = { startupLaunchSnapshot: vi.fn() };
  const searchDelegates = { searchLazyLoad: {} };
  const toolControllers = { sidebarToolsLazyLoad: {} };

  return {
    lazyServiceRefs,
    launchSnapshotSurface,
    searchDelegates,
    toolControllers,
    createWorkspaceShellLaunchSnapshotSurface:
      vi.fn(() => launchSnapshotSurface),
    createWorkspaceShellLazyServiceRefs: vi.fn(() => lazyServiceRefs),
    createWorkspaceShellSearchDelegates: vi.fn(() => searchDelegates),
    createWorkspaceShellToolSurface: vi.fn(() => toolControllers),
  };
});

vi.mock('./workspace-shell-launch-snapshot-surface.factory', () => ({
  createWorkspaceShellLaunchSnapshotSurface:
    mocks.createWorkspaceShellLaunchSnapshotSurface,
}));

vi.mock('./workspace-shell-lazy-service-refs.factory', () => ({
  createWorkspaceShellLazyServiceRefs: mocks.createWorkspaceShellLazyServiceRefs,
}));

vi.mock('./workspace-shell-search-delegates.factory', () => ({
  createWorkspaceShellSearchDelegates:
    mocks.createWorkspaceShellSearchDelegates,
}));

vi.mock('./workspace-shell-tool-surface.factory', () => ({
  createWorkspaceShellToolSurface: mocks.createWorkspaceShellToolSurface,
}));

describe('createWorkspaceShellBaseSurfaces', () => {
  it('builds shared base surfaces from shell graph context', async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const {
      createWorkspaceShellBaseSurfaces,
    } = await import('./workspace-shell-base-surfaces.factory');
    const injector = {};
    const uiState = {};
    const projects = vi.fn();
    const runtime = vi.fn(() => false);
    const warn = vi.fn();
    const logger = { warn: vi.fn() };
    const context = {
      injector,
      logger,
      projectState: { projects },
      runtime,
      uiState,
      warn,
    };

    const surfaces = createWorkspaceShellBaseSurfaces(
      context as unknown as Parameters<typeof createWorkspaceShellBaseSurfaces>[0],
    );

    expect(mocks.createWorkspaceShellLazyServiceRefs).toHaveBeenCalledWith({
      injector,
    });
    expect(mocks.createWorkspaceShellLaunchSnapshotSurface).toHaveBeenCalledWith({
      injector,
    });
    expect(mocks.createWorkspaceShellSearchDelegates).toHaveBeenCalledWith({
      injector,
      uiState,
      fallbackProjects: projects,
      runtime: { destroyed: runtime },
      warn,
    });
    expect(mocks.createWorkspaceShellToolSurface).toHaveBeenCalledWith({
      ...context,
      lazyServiceRefs: mocks.lazyServiceRefs,
      logger,
    });
    expect(surfaces).toEqual({
      lazyServiceRefs: mocks.lazyServiceRefs,
      launchSnapshotSurface: mocks.launchSnapshotSurface,
      searchDelegates: mocks.searchDelegates,
      toolControllers: mocks.toolControllers,
    });
  });
});
