import { inject } from '@angular/core';

import { LoggerService } from '../../../services/logger.service';
import { WorkspaceShellRuntimeStateController } from './workspace-shell-runtime-state.controller';

export type WorkspaceShellGraphWarnFn = (
  message: string,
  context: unknown,
) => void;

export interface WorkspaceShellGraphRuntimeContext {
  readonly logger: ReturnType<LoggerService['category']>;
  readonly markDestroyed: () => void;
  readonly runtime: () => boolean;
  readonly warn: WorkspaceShellGraphWarnFn;
}

export function createWorkspaceShellGraphRuntimeContext(): WorkspaceShellGraphRuntimeContext {
  const logger = inject(LoggerService).category('App');
  const runtimeState = new WorkspaceShellRuntimeStateController();

  return {
    logger,
    markDestroyed: runtimeState.markDestroyedDelegate,
    runtime: runtimeState.destroyedDelegate,
    warn: (message, error) => logger.warn(message, error),
  };
}
