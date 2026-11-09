import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import type { Project, Task } from '../../../models';
import {
  createWorkspaceShellSearchLazyLoadControllerLoader,
  type WorkspaceShellSearchLazyLoadControllerLike,
} from './workspace-shell-search-lazy-load-controller-loader.factory';
import type {
  WorkspaceShellSearchServiceLike,
  WorkspaceShellSearchTask,
} from './workspace-shell-search-lazy-load.controller';

const FALLBACK_PROJECT = { id: 'project-fallback', name: 'Fallback' } as Project;
const SEARCH_PROJECT = { id: 'project-1', name: 'Project' } as Project;
const SEARCH_TASK = { id: 'task-1', title: 'Match' } as Task & WorkspaceShellSearchTask;

function createSearchLazyLoadController(): WorkspaceShellSearchLazyLoadControllerLike {
  return {
    filteredProjects: signal<Project[]>([SEARCH_PROJECT]),
    searchResults: signal<WorkspaceShellSearchTask[]>([SEARCH_TASK]),
    ensureLoaded: vi.fn(),
  };
}

function createSearchService(): WorkspaceShellSearchServiceLike {
  return {
    filteredProjects: signal<Project[]>([SEARCH_PROJECT]),
    searchResults: signal<WorkspaceShellSearchTask[]>([SEARCH_TASK]),
  };
}

describe('createWorkspaceShellSearchLazyLoadControllerLoader', () => {
  it('uses the provided search lazy-load controller factory', async () => {
    const controller = createSearchLazyLoadController();
    const loadSearchDelegate = vi.fn(() => controller);
    const loadController = createWorkspaceShellSearchLazyLoadControllerLoader({
      loadSearchDelegate,
      options: {
        fallbackProjects: signal<Project[]>([FALLBACK_PROJECT]),
        hasActiveSearchQuery: () => true,
        warn: vi.fn(),
      },
    });

    await expect(loadController()).resolves.toBe(controller);

    expect(loadSearchDelegate).toHaveBeenCalledOnce();
  });

  it('converts synchronous search delegate failures to rejected promises and retries later', async () => {
    const failure = new Error('search delegate factory failed');
    const controller = createSearchLazyLoadController();
    const loadSearchDelegate = vi.fn()
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockReturnValueOnce(controller);
    const loadController = createWorkspaceShellSearchLazyLoadControllerLoader({
      loadSearchDelegate,
      options: {
        fallbackProjects: signal<Project[]>([FALLBACK_PROJECT]),
        hasActiveSearchQuery: () => true,
        warn: vi.fn(),
      },
    });

    const loadPromise = loadController();

    await expect(loadPromise).rejects.toBe(failure);
    await expect(loadController()).resolves.toBe(controller);
    expect(loadSearchDelegate).toHaveBeenCalledTimes(2);
  });

  it('creates the default search lazy-load controller lazily', async () => {
    const searchService = createSearchService();
    const loadSearchService = vi.fn().mockResolvedValue(searchService);
    const loadController = createWorkspaceShellSearchLazyLoadControllerLoader({
      options: {
        fallbackProjects: signal<Project[]>([FALLBACK_PROJECT]),
        hasActiveSearchQuery: () => true,
        loadSearchService,
        warn: vi.fn(),
      },
    });

    expect(loadSearchService).not.toHaveBeenCalled();

    const controller = await loadController();
    controller.ensureLoaded();

    await vi.waitFor(() => {
      expect(controller.searchResults()).toEqual([SEARCH_TASK]);
      expect(controller.filteredProjects()).toEqual([SEARCH_PROJECT]);
    });
    expect(loadSearchService).toHaveBeenCalledOnce();
  });
});
