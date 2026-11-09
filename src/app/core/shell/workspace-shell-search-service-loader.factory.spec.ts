import type { Injector } from '@angular/core';
import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellSearchServiceLoader,
} from './workspace-shell-search-service-loader.factory';
import type {
  WorkspaceShellSearchServiceLike,
  WorkspaceShellSearchTask,
} from './workspace-shell-search-lazy-load.controller';
import type { Project } from '../../../models';

vi.mock('../../../services/search.service', () => ({
  SearchService: class SearchService {},
}));

function createSearchService(): WorkspaceShellSearchServiceLike {
  return {
    filteredProjects: signal<Project[]>([]),
    searchResults: signal<WorkspaceShellSearchTask[]>([]),
  };
}

describe('createWorkspaceShellSearchServiceLoader', () => {
  it('uses the provided search service loader', async () => {
    const searchService = createSearchService();
    const loadSearchService = vi.fn().mockResolvedValue(searchService);
    const loadService = createWorkspaceShellSearchServiceLoader({
      injector: {} as Injector,
      loadSearchService,
    });

    await expect(loadService()).resolves.toBe(searchService);

    expect(loadSearchService).toHaveBeenCalledOnce();
  });

  it('loads the search service through the injector by default', async () => {
    const searchService = createSearchService();
    const injectorGet = vi.fn().mockReturnValue(searchService);
    const injector = { get: injectorGet } as unknown as Injector;
    const loadService = createWorkspaceShellSearchServiceLoader({ injector });

    await expect(loadService()).resolves.toBe(searchService);

    expect(injectorGet).toHaveBeenCalledOnce();
    const [token] = injectorGet.mock.calls[0];
    expect((token as { name?: string }).name).toBe('SearchService');
  });
});
