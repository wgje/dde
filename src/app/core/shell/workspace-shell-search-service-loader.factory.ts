import type { Injector } from '@angular/core';

import type { SearchService } from '../../../services/search.service';
import type {
  WorkspaceShellSearchServiceLike,
} from './workspace-shell-search-lazy-load.controller';

export interface WorkspaceShellSearchServiceLoaderOptions<
  TSearchService extends WorkspaceShellSearchServiceLike = SearchService,
> {
  injector?: Injector;
  loadSearchService?: () => Promise<TSearchService>;
}

export function createWorkspaceShellSearchServiceLoader<
  TSearchService extends WorkspaceShellSearchServiceLike = SearchService,
>(
  options: WorkspaceShellSearchServiceLoaderOptions<TSearchService>,
): () => Promise<TSearchService> {
  if (options.loadSearchService) {
    return options.loadSearchService;
  }

  return () => import('../../../services/search.service')
    .then(({ SearchService }) => {
      if (!options.injector) {
        throw new Error('WorkspaceShellSearchServiceLoader requires an injector');
      }

      return options.injector.get(SearchService) as unknown as TSearchService;
    });
}
