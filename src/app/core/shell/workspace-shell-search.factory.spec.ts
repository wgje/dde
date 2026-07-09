import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellSearchController } from './workspace-shell-search.controller';
import {
  readWorkspaceShellBaseSurfacesSource,
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

type SearchFactoryModule = {
  createWorkspaceShellSearchController?: unknown;
};

type SearchFactoryUiState = ConstructorParameters<
  typeof WorkspaceShellSearchController
>[0];

async function loadFactoryModule(): Promise<SearchFactoryModule> {
  try {
    const modulePath = './workspace-shell-search.factory';
    return await import(/* @vite-ignore */ modulePath) as SearchFactoryModule;
  } catch {
    return {};
  }
}

describe('createWorkspaceShellSearchController', () => {
  it('moves search controller construction out of WorkspaceShellComponent', () => {
    const componentSource = readWorkspaceShellSource();
    const graphSource = readWorkspaceShellControllerGraphSource();
    const baseSurfacesSource = readWorkspaceShellBaseSurfacesSource();

    expect(graphSource).toContain('createWorkspaceShellBaseSurfaces');
    expect(graphSource).not.toContain('createWorkspaceShellSearchDelegates');
    expect(baseSurfacesSource).toContain('createWorkspaceShellSearchDelegates');
    expect(componentSource).not.toContain('createWorkspaceShellSearchController');
    expect(componentSource).not.toContain('new WorkspaceShellSearchController');
    expect(componentSource).not.toContain('this.uiState,\n    this.unifiedSearchQuery');
  });

  it('adapts shell search state into the search controller constructor', async () => {
    const { createWorkspaceShellSearchController } = await loadFactoryModule();
    expect(createWorkspaceShellSearchController).toBeTypeOf('function');
    const createSearchController = createWorkspaceShellSearchController as (
      options: {
        createController: (
          uiState: SearchFactoryUiState,
          unifiedSearchQuery: ReturnType<typeof signal<string>>,
        ) => WorkspaceShellSearchController;
        uiState: SearchFactoryUiState;
        unifiedSearchQuery: ReturnType<typeof signal<string>>;
      },
    ) => WorkspaceShellSearchController;
    const uiState: SearchFactoryUiState = {
      clearSearch: vi.fn(),
      projectSearchQuery: signal(''),
      searchQuery: signal(''),
    };
    const unifiedSearchQuery = signal('');
    let receivedUiState!: SearchFactoryUiState;
    let receivedUnifiedSearchQuery!: ReturnType<typeof signal<string>>;
    const createController = vi.fn((nextUiState, nextUnifiedSearchQuery) => {
      receivedUiState = nextUiState;
      receivedUnifiedSearchQuery = nextUnifiedSearchQuery;
      return new WorkspaceShellSearchController(
        nextUiState,
        nextUnifiedSearchQuery,
      );
    });

    const controller = createSearchController({
      createController,
      uiState,
      unifiedSearchQuery,
    });

    expect(controller).toBeInstanceOf(WorkspaceShellSearchController);
    expect(receivedUiState).toBe(uiState);
    expect(receivedUnifiedSearchQuery).toBe(unifiedSearchQuery);
  });
});
