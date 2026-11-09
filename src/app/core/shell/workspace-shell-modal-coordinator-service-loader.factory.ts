import type { Injector } from '@angular/core';

import type { WorkspaceModalCoordinatorService } from '../../../services/workspace-modal-coordinator.service';
import type {
  WorkspaceShellModalCoordinatorLike,
} from './workspace-shell-modal-coordinator-lazy-load.controller';

export interface WorkspaceShellModalCoordinatorServiceLoaderOptions<
  TModalCoord extends WorkspaceShellModalCoordinatorLike = WorkspaceModalCoordinatorService,
> {
  injector?: Injector;
  loadModalCoord?: () => Promise<TModalCoord>;
}

export function createWorkspaceShellModalCoordinatorServiceLoader<
  TModalCoord extends WorkspaceShellModalCoordinatorLike = WorkspaceModalCoordinatorService,
>(
  options: WorkspaceShellModalCoordinatorServiceLoaderOptions<TModalCoord>,
): () => Promise<TModalCoord> {
  if (options.loadModalCoord) {
    return options.loadModalCoord;
  }

  return () => import('../../../services/workspace-modal-coordinator.service')
    .then(({ WorkspaceModalCoordinatorService }) => {
      if (!options.injector) {
        throw new Error('WorkspaceShellModalCoordinatorServiceLoader requires an injector');
      }

      return options.injector.get(WorkspaceModalCoordinatorService) as unknown as TModalCoord;
    });
}
