import type { Injector } from '@angular/core';

import { FEATURE_FLAGS } from '../../../config/feature-flags.config';
import {
  createWorkspaceShellRemoteCallbacksDeferredDelegate,
  type WorkspaceShellRemoteCallbacksDeferredDelegateOptions,
} from './workspace-shell-remote-callbacks-deferred.factory';
import type {
  WorkspaceShellRemoteCallbacksLazyLoadDelegate,
} from './workspace-shell-remote-callbacks-lazy-load-delegate.factory';

export interface WorkspaceShellRemoteCallbacksDelegatesOptions {
  userSession: { currentUserId(): string | null };
  mountState: { coreDataLoaded(): boolean };
  injector: Injector;
  startupTier: { isTierReady(tier: 'p2'): boolean };
  syncCoordinator: {
    refreshActiveProjectSilent(reason: string): Promise<unknown>;
  };
  warn: WorkspaceShellRemoteCallbacksDeferredDelegateOptions['warn'];
  createRemoteCallbacksDeferredDelegate?: (
    options: WorkspaceShellRemoteCallbacksDeferredDelegateOptions,
  ) => WorkspaceShellRemoteCallbacksLazyLoadDelegate;
}

export function createWorkspaceShellRemoteCallbacksDelegates(
  options: WorkspaceShellRemoteCallbacksDelegatesOptions,
): WorkspaceShellRemoteCallbacksLazyLoadDelegate {
  const createDelegate =
    options.createRemoteCallbacksDeferredDelegate
    ?? createWorkspaceShellRemoteCallbacksDeferredDelegate;

  return createDelegate({
    isEnabled: () => FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1,
    currentUserId: () => options.userSession.currentUserId(),
    coreDataLoaded: () => options.mountState.coreDataLoaded(),
    injector: options.injector,
    isTieredStartupHydration: () => FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1,
    isStartupTierP2Ready: () => options.startupTier.isTierReady('p2'),
    refreshActiveProjectSilent: reason =>
      options.syncCoordinator.refreshActiveProjectSilent(reason),
    warn: options.warn,
  });
}
