import type { Injector, WritableSignal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceShellModalLazyLoadFactoryOptions,
} from './workspace-shell-modal-lazy-load.factory';
import {
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellInteractionSurfaceSource,
  readWorkspaceShellInteractionSurfacesSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

type WorkspaceShellModalLazyLoadOptionsFactory = (
  options: Record<string, unknown>,
) => WorkspaceShellModalLazyLoadFactoryOptions;

async function loadFactory(): Promise<
  WorkspaceShellModalLazyLoadOptionsFactory | undefined
> {
  const modulePath = './workspace-shell-modal-lazy-load-options.factory';
  const module = await import(/* @vite-ignore */ modulePath)
    .catch(() => ({}));

  return (
    module as {
      createWorkspaceShellModalLazyLoadOptions?:
        WorkspaceShellModalLazyLoadOptionsFactory;
    }
  ).createWorkspaceShellModalLazyLoadOptions;
}

describe('workspace shell modal lazy-load options', () => {
  it('builds modal lazy-load delegate options from shell dependencies', async () => {
    const createWorkspaceShellModalLazyLoadOptions = await loadFactory();

    expect(createWorkspaceShellModalLazyLoadOptions).toEqual(
      expect.any(Function),
    );

    const modalCallbacks = { createCallbacks: vi.fn(() => ({})) };
    const destroyed = vi.fn(() => false);
    const modalCoord = { open: vi.fn() };
    const injector = { get: vi.fn() } as unknown as Injector;
    const modalLoading = vi.fn() as unknown as WritableSignal<Record<string, boolean>>;
    const warn = vi.fn();

    const options = createWorkspaceShellModalLazyLoadOptions?.({
      modalCallbacks,
      destroyed,
      modalCoord,
      injector,
      modalLoading,
      warn,
    });

    expect(options).toEqual({
      createCallbacks: expect.any(Function),
      destroyed,
      fallbackModalCoord: modalCoord,
      injector,
      modalLoading,
      warn,
    });
    expect(options?.createCallbacks()).toEqual({});
    expect(modalCallbacks.createCallbacks).toHaveBeenCalledTimes(1);
  });

  it('keeps modal lazy-load option wiring outside WorkspaceShellComponent', () => {
    const source = readWorkspaceShellSource();
    const graphSource = readWorkspaceShellControllerGraphSource();
    const interactionSurfacesSource = readWorkspaceShellInteractionSurfacesSource();
    const interactionSurfaceSource = readWorkspaceShellInteractionSurfaceSource();

    expect(graphSource).toContain('createWorkspaceShellInteractionSurfaces({');
    expect(interactionSurfacesSource)
      .toContain('createWorkspaceShellInteractionBoundarySurface({');
    expect(interactionSurfaceSource)
      .toContain('createWorkspaceShellModalLazyLoadOptions');
    expect(interactionSurfaceSource)
      .toContain('createWorkspaceShellModalLazyLoadDelegates');
    expect(source).not.toContain('createWorkspaceShellModalLazyLoadOptions');
    expect(source).not.toContain('private readonly modalLazyLoadOptions');
    expect(source).not.toContain('createWorkspaceShellModalLazyLoadDelegates');
    expect(source).not.toMatch(
      /createWorkspaceShellModalLazyLoadDelegates\(\{\s*createCallbacks:/s,
    );
  });
});
