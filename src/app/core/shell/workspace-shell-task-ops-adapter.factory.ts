import type { Injector } from '@angular/core';

import { TaskOperationAdapterService } from '../../../services/task-operation-adapter.service';

export interface WorkspaceShellTaskOpsAdapter {
  warmup: () => Promise<unknown>;
}

export interface WorkspaceShellTaskOpsAdapterFactoryOptions {
  readonly injector: Pick<Injector, 'get'>;
}

export function createWorkspaceShellTaskOpsAdapter(
  options: WorkspaceShellTaskOpsAdapterFactoryOptions,
): WorkspaceShellTaskOpsAdapter {
  return {
    warmup: () => options.injector.get(TaskOperationAdapterService).warmup(),
  };
}
