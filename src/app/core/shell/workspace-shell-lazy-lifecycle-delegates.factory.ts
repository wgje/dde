import type {
  WorkspaceShellLazyLifecycleGroupControllerOptions,
} from './workspace-shell-lazy-lifecycle-group.controller';
import {
  createWorkspaceShellLazyLifecycleGroupController,
  type WorkspaceShellLazyLifecycleGroupControllerLike,
} from './workspace-shell-lazy-lifecycle-group.factory';

export type WorkspaceShellLazyLifecycleDelegatesOptions =
  WorkspaceShellLazyLifecycleGroupControllerOptions & {
    createLazyLifecycleGroup?: (
      options: WorkspaceShellLazyLifecycleGroupControllerOptions,
    ) => WorkspaceShellLazyLifecycleGroupControllerLike;
  };

export function createWorkspaceShellLazyLifecycleDelegates(
  options: WorkspaceShellLazyLifecycleDelegatesOptions,
): WorkspaceShellLazyLifecycleGroupControllerLike {
  const {
    createLazyLifecycleGroup = createWorkspaceShellLazyLifecycleGroupController,
    ...groupOptions
  } = options;

  return createLazyLifecycleGroup(groupOptions);
}
