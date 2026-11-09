import type {
  WorkspaceShellLazyLifecycleDelegate,
} from './workspace-shell-lazy-lifecycle-host.controller';
import type {
  WorkspaceShellLazyLifecycleGroupMember,
} from './workspace-shell-lazy-lifecycle-hosts.factory';
import {
  createWorkspaceShellNoopLifecycleHost,
} from './workspace-shell-noop-lifecycle-host.factory';

export interface WorkspaceShellLazyLifecycleControllerHostOptions<
  TController extends WorkspaceShellLazyLifecycleDelegate =
    WorkspaceShellLazyLifecycleDelegate,
> {
  readonly destroyed: () => boolean;
  readonly loadController: () => Promise<TController>;
}

export function createWorkspaceShellLazyLifecycleControllerHost<
  TController extends WorkspaceShellLazyLifecycleDelegate,
>(
  options: WorkspaceShellLazyLifecycleControllerHostOptions<TController>,
): Promise<WorkspaceShellLazyLifecycleGroupMember> {
  if (options.destroyed()) {
    return Promise.resolve(createWorkspaceShellNoopLifecycleHost());
  }

  return options.loadController();
}
