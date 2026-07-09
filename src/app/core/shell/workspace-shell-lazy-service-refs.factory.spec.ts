import type { Injector } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellLazyServiceRefsController,
  type WorkspaceShellLazyServiceRefsControllerOptions,
} from './workspace-shell-lazy-service-refs.controller';
import {
  readWorkspaceShellBaseSurfacesSource,
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

type LazyServiceRefsFactoryModule = {
  createWorkspaceShellLazyServiceRefs?: unknown;
};

async function loadFactoryModule(): Promise<LazyServiceRefsFactoryModule> {
  try {
    const modulePath = './workspace-shell-lazy-service-refs.factory';
    return await import(/* @vite-ignore */ modulePath) as LazyServiceRefsFactoryModule;
  } catch {
    return {};
  }
}

describe('createWorkspaceShellLazyServiceRefs', () => {
  it('keeps lazy service refs construction behind a shell factory boundary', () => {
    const componentSource = readWorkspaceShellSource();
    const graphSource = readWorkspaceShellControllerGraphSource();
    const baseSurfacesSource = readWorkspaceShellBaseSurfacesSource();

    expect(graphSource).toContain('createWorkspaceShellBaseSurfaces');
    expect(graphSource).not.toContain('createWorkspaceShellLazyServiceRefs');
    expect(baseSurfacesSource).toContain('createWorkspaceShellLazyServiceRefs');
    expect(componentSource).not.toContain('WorkspaceShellLazyServiceRefsController');
    expect(componentSource).not.toContain('new WorkspaceShellLazyServiceRefsController');
  });

  it('creates lazy service refs from the supplied injector without resolving services', async () => {
    const { createWorkspaceShellLazyServiceRefs } = await loadFactoryModule();
    expect(createWorkspaceShellLazyServiceRefs).toBeTypeOf('function');
    const createLazyServiceRefs = createWorkspaceShellLazyServiceRefs as (
      options: WorkspaceShellLazyServiceRefsControllerOptions,
    ) => WorkspaceShellLazyServiceRefsController;
    const injector = {
      get: vi.fn(),
    } as Pick<Injector, 'get'>;

    const refs = createLazyServiceRefs({ injector });

    expect(refs).toBeInstanceOf(WorkspaceShellLazyServiceRefsController);
    expect(injector.get).not.toHaveBeenCalled();
  });
});
