import type { Injector } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceShellRemoteCallbacksDelegatesOptions,
} from './workspace-shell-remote-callbacks-delegates.factory';
import type {
  WorkspaceShellRemoteCallbacksDeferredDelegateOptions,
} from './workspace-shell-remote-callbacks-deferred.factory';
import type {
  WorkspaceShellRemoteCallbacksLazyLoadDelegate,
} from './workspace-shell-remote-callbacks-lazy-load-delegate.factory';
import {
  readWorkspaceShellControllerGraphCallOptions,
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellLifecycleGraphCallOptions,
  readWorkspaceShellLifecycleGraphSource,
  readWorkspaceShellSessionLifecycleSurfaceCallOptions,
  readWorkspaceShellSessionLifecycleSurfaceSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

type WorkspaceShellRemoteCallbacksOptionsFactory = (
  options: Record<string, unknown>,
) => WorkspaceShellRemoteCallbacksDelegatesOptions;
type WorkspaceShellRemoteCallbacksDelegateFactory = (
  options: Record<string, unknown>,
) => WorkspaceShellRemoteCallbacksLazyLoadDelegate;

async function loadFactories(): Promise<{
  createWorkspaceShellRemoteCallbacksDelegate?:
    WorkspaceShellRemoteCallbacksDelegateFactory;
  createWorkspaceShellRemoteCallbacksOptions?:
    WorkspaceShellRemoteCallbacksOptionsFactory;
}> {
  const modulePath = './workspace-shell-remote-callbacks-options.factory';
  const module = await import(/* @vite-ignore */ modulePath)
    .catch(() => ({}));

  return module as {
    createWorkspaceShellRemoteCallbacksDelegate?:
      WorkspaceShellRemoteCallbacksDelegateFactory;
    createWorkspaceShellRemoteCallbacksOptions?:
      WorkspaceShellRemoteCallbacksOptionsFactory;
  };
}

function createRemoteCallbacksDelegate(): WorkspaceShellRemoteCallbacksLazyLoadDelegate {
  return {
    registerIfReady: vi.fn(),
    teardown: vi.fn(),
  };
}

describe('workspace shell remote callbacks options', () => {
  it('builds remote-callback delegate options from shell dependencies', async () => {
    const { createWorkspaceShellRemoteCallbacksOptions } = await loadFactories();

    expect(createWorkspaceShellRemoteCallbacksOptions).toEqual(
      expect.any(Function),
    );

    const userSession = { currentUserId: vi.fn(() => 'user-1') };
    const mountState = { coreDataLoaded: vi.fn(() => true) };
    const focusSyncControllers = { mountState };
    const injector = { get: vi.fn() } as unknown as Injector;
    const startupTier = { isTierReady: vi.fn(() => true) };
    const syncCoordinator = {
      refreshActiveProjectSilent: vi.fn().mockResolvedValue(undefined),
    };
    const warn = vi.fn();

    const options = createWorkspaceShellRemoteCallbacksOptions?.({
      userSession,
      focusSyncControllers,
      injector,
      startupTier,
      syncCoordinator,
      warn,
    });

    expect(options).toEqual({
      userSession,
      mountState,
      injector,
      startupTier,
      syncCoordinator,
      warn,
    });
  });

  it('creates remote-callback delegates from shell dependencies in one factory call', async () => {
    const { createWorkspaceShellRemoteCallbacksDelegate } = await loadFactories();

    expect(createWorkspaceShellRemoteCallbacksDelegate).toEqual(
      expect.any(Function),
    );

    let mappedOptions!: WorkspaceShellRemoteCallbacksDeferredDelegateOptions;
    const remoteCallbacks = createRemoteCallbacksDelegate();
    const mountState = { coreDataLoaded: vi.fn(() => true) };
    const userSession = { currentUserId: vi.fn(() => 'user-1') };
    const syncCoordinator = {
      refreshActiveProjectSilent: vi.fn().mockResolvedValue(undefined),
    };

    const delegate = createWorkspaceShellRemoteCallbacksDelegate?.({
      userSession,
      focusSyncControllers: { mountState },
      injector: { get: vi.fn() } as unknown as Injector,
      startupTier: { isTierReady: vi.fn(() => true) },
      syncCoordinator,
      warn: vi.fn(),
      createRemoteCallbacksDeferredDelegate: (
        options: WorkspaceShellRemoteCallbacksDeferredDelegateOptions,
      ) => {
        mappedOptions = options;
        return remoteCallbacks;
      },
    });

    expect(delegate).toBe(remoteCallbacks);
    expect(mappedOptions.coreDataLoaded()).toBe(true);
    expect(mountState.coreDataLoaded).toHaveBeenCalledOnce();
  });

  it('keeps remote-callback option wiring outside WorkspaceShellComponent', () => {
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
    const remoteCallbacksBlock =
      readWorkspaceShellSessionLifecycleSurfaceCallOptions(
      'createWorkspaceShellRemoteCallbacksDelegate',
    );

    expect(graphSource).toContain('createWorkspaceShellLifecycleGraph');
    expect(lifecycleGraphSource)
      .toContain('createWorkspaceShellSessionLifecycleSurface');
    expect(graphSource).not.toContain('createWorkspaceShellRemoteCallbacksDelegate');
    expect(sessionLifecycleSource)
      .toContain('createWorkspaceShellRemoteCallbacksDelegate');
    expect(source).not.toContain('createWorkspaceShellRemoteCallbacksOptions');
    expect(source).not.toContain('private readonly remoteCallbacksOptions');
    expect(source).not.toContain('createWorkspaceShellRemoteCallbacksDelegates');

    expect(lifecycleGraphOptions).toContain('...sessionRouting');
    expect(sessionLifecycleBlock).toContain('...options');
    expect(remoteCallbacksBlock).toContain('...options');
    expect(remoteCallbacksBlock).not.toContain(
      'mountState: this.focusSyncControllers.mountState',
    );
    expect(source).not.toMatch(
      /createWorkspaceShellRemoteCallbacksDelegates\(\{\s*userSession:/s,
    );
  });
});
