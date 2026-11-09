import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceShellProjectSubscriptionDelegatesOptions,
} from './workspace-shell-project-subscription-delegates.factory';
import type {
  WorkspaceShellProjectSubscriptionController,
} from './workspace-shell-project-subscription.controller';
import type {
  WorkspaceShellProjectSubscriptionFactoryOptions,
} from './workspace-shell-project-subscription.factory';
import {
  readWorkspaceShellControllerGraphCallOptions,
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellLifecycleGraphCallOptions,
  readWorkspaceShellLifecycleGraphSource,
  readWorkspaceShellSessionLifecycleSurfaceCallOptions,
  readWorkspaceShellSessionLifecycleSurfaceSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

type WorkspaceShellProjectSubscriptionOptionsFactory = (
  options: Record<string, unknown>,
) => WorkspaceShellProjectSubscriptionDelegatesOptions;
type WorkspaceShellProjectSubscriptionDelegateFactory = (
  options: Record<string, unknown>,
) => WorkspaceShellProjectSubscriptionController;

async function loadFactories(): Promise<{
  createWorkspaceShellProjectSubscriptionDelegate?:
    WorkspaceShellProjectSubscriptionDelegateFactory;
  createWorkspaceShellProjectSubscriptionOptions?:
    WorkspaceShellProjectSubscriptionOptionsFactory;
}> {
  const modulePath = './workspace-shell-project-subscription-options.factory';
  const module = await import(/* @vite-ignore */ modulePath)
    .catch(() => ({}));

  return module as {
    createWorkspaceShellProjectSubscriptionDelegate?:
      WorkspaceShellProjectSubscriptionDelegateFactory;
    createWorkspaceShellProjectSubscriptionOptions?:
      WorkspaceShellProjectSubscriptionOptionsFactory;
  };
}

function createProjectSubscriptionController(): WorkspaceShellProjectSubscriptionController {
  return {
    clear: vi.fn(),
    sync: vi.fn(),
  } as unknown as WorkspaceShellProjectSubscriptionController;
}

describe('workspace shell project subscription options', () => {
  it('builds project subscription delegate options from shell dependencies', async () => {
    const { createWorkspaceShellProjectSubscriptionOptions } = await loadFactories();

    expect(createWorkspaceShellProjectSubscriptionOptions).toEqual(
      expect.any(Function),
    );

    const mountState = { coreDataLoaded: vi.fn(() => true) };
    const focusSyncControllers = { mountState };
    const startupTier = { isTierReady: vi.fn(() => true) };
    const userSession = { currentUserId: vi.fn(() => 'user-1') };
    const projectState = { activeProjectId: vi.fn(() => 'project-1') };
    const lazyServiceRefs = {
      simpleSync: {
        subscribeToProject: vi.fn(),
        unsubscribeFromProject: vi.fn(),
      },
    };
    const warn = vi.fn();

    const options = createWorkspaceShellProjectSubscriptionOptions?.({
      focusSyncControllers,
      startupTier,
      userSession,
      projectState,
      lazyServiceRefs,
      warn,
    });

    expect(options).toEqual({
      mountState,
      startupTier,
      userSession,
      projectState,
      lazyServiceRefs,
      warn,
    });
  });

  it('creates the project subscription delegate from shell dependencies in one factory call', async () => {
    const { createWorkspaceShellProjectSubscriptionDelegate } = await loadFactories();

    expect(createWorkspaceShellProjectSubscriptionDelegate).toEqual(
      expect.any(Function),
    );

    let mappedOptions!: WorkspaceShellProjectSubscriptionFactoryOptions;
    const controller = createProjectSubscriptionController();
    const mountState = { coreDataLoaded: vi.fn(() => true) };
    const focusSyncControllers = { mountState };
    const startupTier = { isTierReady: vi.fn(() => true) };
    const userSession = { currentUserId: vi.fn(() => 'user-1') };
    const projectState = { activeProjectId: vi.fn(() => 'project-1') };
    const lazyServiceRefs = {
      simpleSync: {
        subscribeToProject: vi.fn(),
        unsubscribeFromProject: vi.fn(),
      },
    };

    const delegate = createWorkspaceShellProjectSubscriptionDelegate?.({
      focusSyncControllers,
      startupTier,
      userSession,
      projectState,
      lazyServiceRefs,
      createProjectSubscriptionController: (
        options: WorkspaceShellProjectSubscriptionFactoryOptions,
      ) => {
        mappedOptions = options;
        return controller;
      },
    });

    expect(delegate).toBe(controller);
    expect(mappedOptions.coreDataLoaded()).toBe(true);
    expect(mountState.coreDataLoaded).toHaveBeenCalledOnce();
  });

  it('keeps project subscription option wiring outside WorkspaceShellComponent', () => {
    const source = readWorkspaceShellSource();
    const graphSource = readWorkspaceShellControllerGraphSource();
    const lifecycleGraphSource = readWorkspaceShellLifecycleGraphSource();
    const lifecycleGraphOptions = readWorkspaceShellControllerGraphCallOptions(
      'createWorkspaceShellLifecycleGraph',
    );
    const sessionLifecycleSource =
      readWorkspaceShellSessionLifecycleSurfaceSource();
    const sessionLifecycleBlock = readWorkspaceShellLifecycleGraphCallOptions(
      'createWorkspaceShellSessionLifecycleSurface',
    );
    const projectSubscriptionBlock =
      readWorkspaceShellSessionLifecycleSurfaceCallOptions(
      'createWorkspaceShellProjectSubscriptionDelegate',
    );

    expect(graphSource).toContain('createWorkspaceShellLifecycleGraph');
    expect(lifecycleGraphSource)
      .toContain('createWorkspaceShellSessionLifecycleSurface');
    expect(graphSource).not.toContain('createWorkspaceShellProjectSubscriptionDelegate');
    expect(sessionLifecycleSource)
      .toContain('createWorkspaceShellProjectSubscriptionDelegate');
    expect(source).not.toContain('createWorkspaceShellProjectSubscriptionOptions');
    expect(source).not.toContain('private readonly projectSubscriptionOptions');
    expect(source).not.toContain('createWorkspaceShellProjectSubscriptionDelegates');

    expect(lifecycleGraphOptions).toContain('...sessionRouting');
    expect(sessionLifecycleBlock).toContain('...options');
    expect(projectSubscriptionBlock).toContain('...options');
    expect(projectSubscriptionBlock).not.toContain(
      'mountState: this.focusSyncControllers.mountState',
    );
    expect(source).not.toMatch(
      /createWorkspaceShellProjectSubscriptionDelegates\(\{\s*mountState:/s,
    );
  });
});
