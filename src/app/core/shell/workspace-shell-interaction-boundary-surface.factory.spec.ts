import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Injector, WritableSignal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

type WorkspaceShellInteractionBoundarySurfaceFactory = (
  options: Record<string, unknown>,
) => {
  interaction: unknown;
  modalLazyLoad: unknown;
};

async function loadBoundaryFactory(): Promise<{
  createWorkspaceShellInteractionBoundarySurface?:
    WorkspaceShellInteractionBoundarySurfaceFactory;
}> {
  const modulePath = './workspace-shell-interaction-boundary-surface.factory';
  return import(/* @vite-ignore */ modulePath)
    .catch(() => ({})) as Promise<{
      createWorkspaceShellInteractionBoundarySurface?:
        WorkspaceShellInteractionBoundarySurfaceFactory;
    }>;
}

describe('workspace shell interaction boundary surface', () => {
  it('owns grouped shell option adaptation outside the core interaction surface', async () => {
    const boundaryModule = await loadBoundaryFactory();

    expect(boundaryModule).toHaveProperty(
      'createWorkspaceShellInteractionBoundarySurface',
      expect.any(Function),
    );

    const boundarySource = readFileSync(
      join(__dirname, 'workspace-shell-interaction-boundary-surface.factory.ts'),
      'utf8',
    );
    const surfaceSource = readFileSync(
      join(__dirname, 'workspace-shell-interaction-surface.factory.ts'),
      'utf8',
    );

    expect(boundarySource).toContain('createWorkspaceShellInteractionSurface');
    expect(boundarySource).toContain('WorkspaceShellInteractionBoundarySurfaceOptions');
    expect(surfaceSource).not.toContain(
      'WorkspaceShellInteractionBoundarySurfaceOptions',
    );
    expect(surfaceSource).not.toContain(
      'createWorkspaceShellInteractionBoundarySurface',
    );
  });

  it('creates interaction delegates from grouped shell surfaces', async () => {
    const { createWorkspaceShellInteractionBoundarySurface } =
      await loadBoundaryFactory();

    expect(createWorkspaceShellInteractionBoundarySurface)
      .toEqual(expect.any(Function));

    const interactionDelegates = {
      actions: { createNewProject: vi.fn() },
      lifecycle: { initialize: vi.fn() },
      modalCallbacks: { createCallbacks: vi.fn() },
      sidebarResize: { startSidebarResize: vi.fn() },
      touchGestures: { onSidebarTouchStart: vi.fn() },
    };
    const interaction = {
      actions: interactionDelegates.actions,
      sidebarResize: interactionDelegates.sidebarResize,
      touchGestures: interactionDelegates.touchGestures,
    };
    const modalLazyLoadOptions = { createCallbacks: vi.fn() };
    const modalLazyLoad = { actions: { isLoading: vi.fn() } };
    let delegatedOptions!: Record<string, unknown>;
    const createInteractionDelegates = vi.fn((options: Record<string, unknown>) => {
      delegatedOptions = options;
      return interactionDelegates;
    });
    const createInteractionTemplateSurface = vi.fn(() => interaction);
    const createModalLazyLoadOptions = vi.fn(() => modalLazyLoadOptions);
    const createModalLazyLoadDelegates = vi.fn(() => modalLazyLoad);
    const destroyed = vi.fn(() => false);
    const injector = { get: vi.fn() } as unknown as Injector;
    const modalCoord = { initCallbacks: vi.fn() };
    const modalLoading = vi.fn() as unknown as WritableSignal<
      Record<string, boolean>
    >;
    const signOutController = { signOut: vi.fn() };
    const router = { navigate: vi.fn() };
    const projectState = { projects: vi.fn() };
    const sidebarOpen = vi.fn(() => true) as unknown as (() => boolean) & {
      set: (value: boolean) => void;
    };
    sidebarOpen.set = vi.fn();
    const isMobile = vi.fn(() => false) as unknown as (() => boolean) & {
      set: (value: boolean) => void;
    };
    isMobile.set = vi.fn();
    const uiState = {
      activeView: vi.fn(() => 'flow'),
      filterMode: vi.fn(() => 'all'),
      floatingWindowPref: vi.fn(() => 'remember'),
      layoutDirection: vi.fn(() => 'ltr'),
      sidebarOpen,
      isMobile,
    };
    const mobileFocusGate = { setup: vi.fn() };
    const dockEngine = { focus: vi.fn() };
    const lazyServiceRefs = { fullActions: vi.fn() };
    const warn = vi.fn();

    const surface = createWorkspaceShellInteractionBoundarySurface?.({
      destroyed,
      injector,
      session: { authService: { signOut: vi.fn() } },
      authCoord: {},
      sessionExitSurface: { signOutController },
      storageEscape: {},
      modalCoord,
      projectCoord: {},
      routing: { router, routeUrl: vi.fn(), routeSyncController: {} },
      projectState,
      uiState,
      userSession: {},
      toast: {},
      taskStore: {},
      focusSyncControllers: { mobileFocusGate },
      chrome: { dockEngine },
      lazyServiceRefs,
      preferenceService: {},
      searchDelegates: {
        searchLazyLoad: {},
        searchController: {},
      },
      derivedUiState: { modalLoading },
      warn,
      createInteractionDelegates,
      createInteractionTemplateSurface,
      createModalLazyLoadOptions,
      createModalLazyLoadDelegates,
    });

    expect(delegatedOptions.navigation).toEqual({ router, projectState });
    expect(delegatedOptions.layout).toEqual({
      uiState,
      sidebarOpen: uiState.sidebarOpen,
    });
    expect(delegatedOptions.focus).toEqual({ mobileFocusGate });
    expect(delegatedOptions.dockEngine).toBe(dockEngine);
    expect(delegatedOptions.runtime).toEqual({ lazyServiceRefs });
    expect(createModalLazyLoadOptions).toHaveBeenCalledWith({
      modalCallbacks: interactionDelegates.modalCallbacks,
      destroyed,
      modalCoord,
      injector,
      modalLoading,
      warn,
    });
    expect(surface?.interaction).toBe(interaction);
    expect(surface?.modalLazyLoad).toBe(modalLazyLoad);
  });
});
