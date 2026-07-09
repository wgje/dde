import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellProjectSubscriptionController,
} from './workspace-shell-project-subscription.factory';

describe('createWorkspaceShellProjectSubscriptionController', () => {
  it('builds subscription readiness from core data and startup tier state outside the workspace shell component', () => {
    let coreDataLoaded = false;
    let tierReady = false;
    const subscribeToProject = vi.fn<(projectId: string, userId: string) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const unsubscribeFromProject = vi.fn<() => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const controller = createWorkspaceShellProjectSubscriptionController({
      isEnabled: () => true,
      coreDataLoaded: () => coreDataLoaded,
      isTieredStartupHydration: () => true,
      isStartupTierP2Ready: () => tierReady,
      currentUserId: () => 'user-1',
      activeProjectId: () => 'project-1',
      subscribeToProject,
      unsubscribeFromProject,
    });

    controller.sync();
    coreDataLoaded = true;
    controller.sync();
    tierReady = true;
    controller.sync();

    expect(subscribeToProject).toHaveBeenCalledTimes(1);
    expect(subscribeToProject).toHaveBeenCalledWith('project-1', 'user-1');
    expect(unsubscribeFromProject).not.toHaveBeenCalled();
  });
});
