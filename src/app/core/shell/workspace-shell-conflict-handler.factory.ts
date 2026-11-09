import type { Subscription } from 'rxjs';
import type { ConflictEvent } from '../../../services/sync-coordinator-conflicts.service';

import { WorkspaceShellConflictHandlerController } from './workspace-shell-conflict-handler.controller';

export interface WorkspaceShellConflictHandlerFactoryOptions {
  syncCoordinator: {
    onConflict$: {
      subscribe(listener: (event: ConflictEvent) => void): Subscription;
    };
  };
  modalCoord: {
    setPendingConflict(event: ConflictEvent): void;
    openConflictModal(event: ConflictEvent): Promise<void> | void;
  };
  warn: (message: string, error: unknown) => void;
}

export function createWorkspaceShellConflictHandlerController(
  options: WorkspaceShellConflictHandlerFactoryOptions,
): WorkspaceShellConflictHandlerController {
  return new WorkspaceShellConflictHandlerController({
    subscribeToConflictEvents: (listener) =>
      options.syncCoordinator.onConflict$.subscribe(listener),
    setPendingConflict: (event) => options.modalCoord.setPendingConflict(event),
    openConflictModal: (event) => options.modalCoord.openConflictModal(event),
    warn: options.warn,
  });
}
