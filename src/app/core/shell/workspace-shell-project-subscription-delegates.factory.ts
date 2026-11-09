import { FEATURE_FLAGS } from '../../../config/feature-flags.config';
import {
  createWorkspaceShellProjectSubscriptionController,
  type WorkspaceShellProjectSubscriptionFactoryOptions,
} from './workspace-shell-project-subscription.factory';
import type {
  WorkspaceShellProjectSubscriptionController,
} from './workspace-shell-project-subscription.controller';

export interface WorkspaceShellProjectSubscriptionDelegatesOptions {
  mountState: { coreDataLoaded(): boolean };
  startupTier: { isTierReady(tier: 'p2'): boolean };
  userSession: { currentUserId(): string | null };
  projectState: { activeProjectId(): string | null };
  lazyServiceRefs: {
    simpleSync: {
      subscribeToProject(projectId: string, userId: string): Promise<unknown>;
      unsubscribeFromProject(): Promise<unknown>;
    };
  };
  warn?: WorkspaceShellProjectSubscriptionFactoryOptions['warn'];
  createProjectSubscriptionController?: (
    options: WorkspaceShellProjectSubscriptionFactoryOptions,
  ) => WorkspaceShellProjectSubscriptionController;
}

export function createWorkspaceShellProjectSubscriptionDelegates(
  options: WorkspaceShellProjectSubscriptionDelegatesOptions,
): WorkspaceShellProjectSubscriptionController {
  const createController =
    options.createProjectSubscriptionController
    ?? createWorkspaceShellProjectSubscriptionController;

  return createController({
    isEnabled: () => FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1,
    coreDataLoaded: () => options.mountState.coreDataLoaded(),
    isTieredStartupHydration: () => FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1,
    isStartupTierP2Ready: () => options.startupTier.isTierReady('p2'),
    currentUserId: () => options.userSession.currentUserId(),
    activeProjectId: () => options.projectState.activeProjectId(),
    subscribeToProject: (projectId, userId) =>
      options.lazyServiceRefs.simpleSync.subscribeToProject(projectId, userId),
    unsubscribeFromProject: () =>
      options.lazyServiceRefs.simpleSync.unsubscribeFromProject(),
    warn: options.warn,
  });
}
