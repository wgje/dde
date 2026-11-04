import type { Injector, WritableSignal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import {
  readWorkspaceShellControllerGraphCallOptions,
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellInteractionSurfacesCallOptions,
  readWorkspaceShellInteractionSurfacesSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

type WorkspaceShellInteractionSurfaceFactory = (
  options: Record<string, unknown>,
) => {
  interaction: unknown;
  interactionLifecycle: unknown;
  modalCallbacks: unknown;
  modalLazyLoad: unknown;
};

async function loadFactories(): Promise<{
  createWorkspaceShellInteractionSurface?:
    WorkspaceShellInteractionSurfaceFactory;
}> {
  const modulePath = './workspace-shell-interaction-surface.factory';
  const module = await import(/* @vite-ignore */ modulePath)
    .catch(() => ({}));

  return module as {
    createWorkspaceShellInteractionSurface?:
      WorkspaceShellInteractionSurfaceFactory;
  };
}

describe('createWorkspaceShellInteractionSurface', () => {
  it('assembles interaction and modal lazy-load delegates behind one shell boundary', async () => {
    const { createWorkspaceShellInteractionSurface } = await loadFactories();

    expect(createWorkspaceShellInteractionSurface).toEqual(expect.any(Function));

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
    const createInteractionDelegates = vi.fn((options: Record<string, unknown>) => {
      void options;
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
    const warn = vi.fn();

    const surface = createWorkspaceShellInteractionSurface?.({
      authCoord: {},
      destroyed,
      injector,
      modalCoord,
      modalLoading,
      sessionExitSurface: { signOutController },
      warn,
      createInteractionDelegates,
      createInteractionTemplateSurface,
      createModalLazyLoadOptions,
      createModalLazyLoadDelegates,
    });

    expect(createInteractionDelegates).toHaveBeenCalledOnce();
    expect(createInteractionDelegates).toHaveBeenCalledWith(
      expect.objectContaining({ signOutController }),
    );
    expect(createInteractionTemplateSurface)
      .toHaveBeenCalledWith(interactionDelegates);
    expect(createModalLazyLoadOptions).toHaveBeenCalledWith({
      modalCallbacks: interactionDelegates.modalCallbacks,
      destroyed,
      modalCoord,
      injector,
      modalLoading,
      warn,
    });
    expect(createModalLazyLoadDelegates)
      .toHaveBeenCalledWith(modalLazyLoadOptions);
    expect(surface).toEqual({
      interaction,
      interactionLifecycle: interactionDelegates.lifecycle,
      modalCallbacks: interactionDelegates.modalCallbacks,
      modalLazyLoad,
    });
  });

  it('moves interaction/modal lazy-load assembly out of WorkspaceShellComponent', () => {
    const source = readWorkspaceShellSource();
    const graphSource = readWorkspaceShellControllerGraphSource();
    const interactionSurfacesBlock = readWorkspaceShellControllerGraphCallOptions(
      'createWorkspaceShellInteractionSurfaces',
    );
    const interactionSurfacesSource = readWorkspaceShellInteractionSurfacesSource();
    const interactionBlock = readWorkspaceShellInteractionSurfacesCallOptions(
      'createWorkspaceShellInteractionBoundarySurface',
    );

    expect(graphSource).toContain('createWorkspaceShellInteractionSurfaces({');
    expect(interactionSurfacesSource).toContain(
      'createWorkspaceShellInteractionBoundarySurface({',
    );
    expect(source).not.toContain('createWorkspaceShellInteractionDelegates');
    expect(source).not.toContain('createWorkspaceShellInteractionTemplateSurface');
    expect(source).not.toContain('createWorkspaceShellModalLazyLoadOptions');
    expect(source).not.toContain('createWorkspaceShellModalLazyLoadDelegates');
    expect(source).not.toContain('private readonly interactionDelegates =');
    expect(source).not.toContain('private readonly modalLazyLoadOptions =');
    expect(interactionSurfacesBlock).toContain('...context');
    expect(interactionSurfacesBlock).toContain('...base');
    expect(interactionSurfacesBlock).toContain('...sessionRouting');
    expect(interactionBlock).toContain('...options');
    expect(interactionBlock).toContain('derivedUiState');
    expect(interactionBlock).not.toContain('navigation: {');
    expect(interactionBlock).not.toContain('layout: {');
    expect(interactionBlock).not.toContain(
      'focus: { mobileFocusGate: this.focusSyncControllers.mobileFocusGate }',
    );
    expect(interactionBlock).not.toContain('dockEngine: this.chrome.dockEngine');
    expect(interactionBlock).not.toContain(
      'runtime: { lazyServiceRefs: this.lazyServiceRefs }',
    );
    expect(interactionBlock).not.toContain(
      'searchLazyLoad: this.searchDelegates.searchLazyLoad',
    );
    expect(interactionBlock).not.toContain(
      'searchController: this.searchDelegates.searchController',
    );
    expect(interactionBlock).not.toContain(
      'modalLoading: this.derivedUiState.modalLoading',
    );
  });
});
