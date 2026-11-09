import {
  WorkspaceShellProjectSubscriptionController,
  type WorkspaceShellProjectSubscriptionControllerOptions,
} from './workspace-shell-project-subscription.controller';

export interface WorkspaceShellProjectSubscriptionFactoryOptions
  extends Omit<WorkspaceShellProjectSubscriptionControllerOptions, 'isReady'> {
  coreDataLoaded: () => boolean;
  isStartupTierP2Ready: () => boolean;
  isTieredStartupHydration: () => boolean;
}

export function createWorkspaceShellProjectSubscriptionController(
  options: WorkspaceShellProjectSubscriptionFactoryOptions,
): WorkspaceShellProjectSubscriptionController {
  const {
    coreDataLoaded,
    isStartupTierP2Ready,
    isTieredStartupHydration,
    ...controllerOptions
  } = options;

  return new WorkspaceShellProjectSubscriptionController({
    ...controllerOptions,
    isReady: () => (
      coreDataLoaded() &&
      (!isTieredStartupHydration() || isStartupTierP2Ready())
    ),
  });
}
