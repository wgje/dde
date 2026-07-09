import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellProjectSubscriptionDelegates,
} from './workspace-shell-project-subscription-delegates.factory';
import type {
  WorkspaceShellProjectSubscriptionFactoryOptions,
} from './workspace-shell-project-subscription.factory';
import type {
  WorkspaceShellProjectSubscriptionController,
} from './workspace-shell-project-subscription.controller';

function createProjectSubscriptionController(): WorkspaceShellProjectSubscriptionController {
  return {
    sync: vi.fn(),
    clear: vi.fn(),
  } as unknown as WorkspaceShellProjectSubscriptionController;
}

describe('createWorkspaceShellProjectSubscriptionDelegates', () => {
  it('maps high-level shell dependencies into project subscription options', async () => {
    let mappedOptions!: WorkspaceShellProjectSubscriptionFactoryOptions;
    const controller = createProjectSubscriptionController();
    const simpleSync = {
      subscribeToProject: vi.fn().mockResolvedValue(undefined),
      unsubscribeFromProject: vi.fn().mockResolvedValue(undefined),
    };
    const warn = vi.fn();
    const userSession = { currentUserId: vi.fn().mockReturnValue('user-1') };

    const delegate = createWorkspaceShellProjectSubscriptionDelegates({
      mountState: { coreDataLoaded: () => true },
      startupTier: { isTierReady: vi.fn().mockReturnValue(true) },
      userSession,
      projectState: { activeProjectId: () => 'project-1' },
      lazyServiceRefs: { simpleSync },
      warn,
      createProjectSubscriptionController: options => {
        mappedOptions = options;
        return controller;
      },
    });

    expect(delegate).toBe(controller);
    expect(mappedOptions.isEnabled()).toBe(true);
    expect(mappedOptions.coreDataLoaded()).toBe(true);
    expect(mappedOptions.isTieredStartupHydration()).toBe(true);
    expect(mappedOptions.isStartupTierP2Ready()).toBe(true);
    expect(mappedOptions.currentUserId()).toBe('user-1');
    expect(mappedOptions.activeProjectId()).toBe('project-1');
    expect(mappedOptions.warn).toBe(warn);

    await mappedOptions.subscribeToProject('project-1', 'user-1');
    await mappedOptions.unsubscribeFromProject();

    expect(simpleSync.subscribeToProject).toHaveBeenCalledWith('project-1', 'user-1');
    expect(simpleSync.unsubscribeFromProject).toHaveBeenCalledTimes(1);
    expect('createProjectSubscriptionController' in mappedOptions).toBe(false);
  });
});
