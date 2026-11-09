import { signal, type Injector } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../../../models';

import type { WorkspaceShellSearchController } from './workspace-shell-search.controller';
import type {
  WorkspaceShellSearchLazyLoadDelegate,
  WorkspaceShellSearchLazyLoadDelegateOptions,
} from './workspace-shell-search-lazy-load-delegate.factory';

type SearchDelegatesFactoryModule = {
  createWorkspaceShellSearchDelegates?: unknown;
};

async function loadFactoryModule(): Promise<SearchDelegatesFactoryModule> {
  try {
    const modulePath = './workspace-shell-search-delegates.factory';
    return await import(/* @vite-ignore */ modulePath) as SearchDelegatesFactoryModule;
  } catch {
    return {};
  }
}

describe('createWorkspaceShellSearchDelegates', () => {
  it('binds search lazy-load active-query checks to the created search controller', async () => {
    const { createWorkspaceShellSearchDelegates } = await loadFactoryModule();
    expect(createWorkspaceShellSearchDelegates).toBeTypeOf('function');
    const createSearchDelegates = createWorkspaceShellSearchDelegates as (options: {
      injector: Injector;
      uiState: {
        clearSearch: () => void;
        projectSearchQuery: ReturnType<typeof signal<string>>;
        searchQuery: ReturnType<typeof signal<string>>;
      };
      fallbackProjects: ReturnType<typeof signal<Project[]>>;
      runtime: {
        destroyed?: () => boolean;
      };
      warn: (message: string, error: unknown) => void;
      createSearchController: (options: {
        uiState: unknown;
        unifiedSearchQuery: ReturnType<typeof signal<string>>;
      }) => WorkspaceShellSearchController;
      createSearchLazyLoad: (
        options: WorkspaceShellSearchLazyLoadDelegateOptions,
      ) => WorkspaceShellSearchLazyLoadDelegate;
    }) => {
      searchController: WorkspaceShellSearchController;
      searchLazyLoad: WorkspaceShellSearchLazyLoadDelegate;
      unifiedSearchQuery: ReturnType<typeof signal<string>>;
    };
    const controller = {
      hasActiveQuery: vi.fn(() => true),
    } as unknown as WorkspaceShellSearchController;
    let lazyOptions!: WorkspaceShellSearchLazyLoadDelegateOptions;
    const searchLazyLoad = {
      filteredProjects: signal<Project[]>([]),
      searchResults: signal([]),
      ensureLoaded: vi.fn(),
    } satisfies WorkspaceShellSearchLazyLoadDelegate;
    const destroyed = vi.fn(() => false);

    const delegates = createSearchDelegates({
      runtime: { destroyed },
      injector: {} as Injector,
      uiState: {
        clearSearch: vi.fn(),
        projectSearchQuery: signal(''),
        searchQuery: signal(''),
      },
      fallbackProjects: signal<Project[]>([]),
      warn: vi.fn(),
      createSearchController: vi.fn(() => controller),
      createSearchLazyLoad: vi.fn(options => {
        lazyOptions = options;
        return searchLazyLoad;
      }),
    });

    expect(delegates.searchController).toBe(controller);
    expect(delegates.searchLazyLoad).toBe(searchLazyLoad);
    expect(lazyOptions.hasActiveSearchQuery()).toBe(true);
    expect(lazyOptions.destroyed?.()).toBe(false);
    expect(destroyed).toHaveBeenCalledOnce();
    expect(controller.hasActiveQuery).toHaveBeenCalledTimes(1);
  });
});
