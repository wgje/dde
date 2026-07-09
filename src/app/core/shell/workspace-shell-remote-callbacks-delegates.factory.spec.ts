import { describe, expect, it, vi } from 'vitest';
import type { Injector } from '@angular/core';

import {
  createWorkspaceShellRemoteCallbacksDelegates,
} from './workspace-shell-remote-callbacks-delegates.factory';
import type {
  WorkspaceShellRemoteCallbacksDeferredDelegateOptions,
} from './workspace-shell-remote-callbacks-deferred.factory';
import type {
  WorkspaceShellRemoteCallbacksLazyLoadDelegate,
} from './workspace-shell-remote-callbacks-lazy-load-delegate.factory';

function createRemoteCallbacksDelegate(): WorkspaceShellRemoteCallbacksLazyLoadDelegate {
  return {
    registerIfReady: vi.fn(),
    teardown: vi.fn(),
  };
}

describe('createWorkspaceShellRemoteCallbacksDelegates', () => {
  it('maps high-level shell dependencies into remote callbacks deferred options', async () => {
    let mappedOptions!: WorkspaceShellRemoteCallbacksDeferredDelegateOptions;
    const remoteCallbacks = createRemoteCallbacksDelegate();
    const syncCoordinator = { refreshActiveProjectSilent: vi.fn().mockResolvedValue(undefined) };
    const userSession = { currentUserId: vi.fn().mockReturnValue('user-1') };
    const mountState = { coreDataLoaded: vi.fn().mockReturnValue(true) };

    const delegate = createWorkspaceShellRemoteCallbacksDelegates({
      userSession,
      mountState,
      injector: {} as Injector,
      startupTier: { isTierReady: vi.fn().mockReturnValue(true) },
      syncCoordinator,
      warn: vi.fn(),
      createRemoteCallbacksDeferredDelegate: options => {
        mappedOptions = options;
        return remoteCallbacks;
      },
    });

    expect(delegate).toBe(remoteCallbacks);
    expect(mappedOptions.isEnabled()).toBe(true);
    expect(mappedOptions.currentUserId()).toBe('user-1');
    expect(mappedOptions.coreDataLoaded()).toBe(true);
    expect(mappedOptions.isTieredStartupHydration()).toBe(true);
    expect(mappedOptions.isStartupTierP2Ready()).toBe(true);

    await mappedOptions.refreshActiveProjectSilent('remote:test');

    expect(mappedOptions.injector).toBeDefined();
    expect(mappedOptions.warn).toEqual(expect.any(Function));
    expect(syncCoordinator.refreshActiveProjectSilent).toHaveBeenCalledWith('remote:test');
    expect('createRemoteCallbacksDeferredDelegate' in mappedOptions).toBe(false);
  });
});
