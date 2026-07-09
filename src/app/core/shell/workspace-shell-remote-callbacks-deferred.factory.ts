import { createWorkspaceShellDeferredController } from './workspace-shell-deferred-controller.helpers';
import type {
  WorkspaceShellRemoteCallbacksLazyLoadDelegate,
  WorkspaceShellRemoteCallbacksLazyLoadDelegateOptions,
} from './workspace-shell-remote-callbacks-lazy-load-delegate.factory';

export interface WorkspaceShellRemoteCallbacksDeferredDelegateOptions
  extends Omit<WorkspaceShellRemoteCallbacksLazyLoadDelegateOptions, 'isReady'> {
  coreDataLoaded: () => boolean;
  currentUserId: () => string | null;
  isStartupTierP2Ready: () => boolean;
  isTieredStartupHydration: () => boolean;
}

export function createWorkspaceShellRemoteCallbacksDeferredDelegate(
  options: WorkspaceShellRemoteCallbacksDeferredDelegateOptions,
): WorkspaceShellRemoteCallbacksLazyLoadDelegate {
  const {
    coreDataLoaded,
    currentUserId,
    isStartupTierP2Ready,
    isTieredStartupHydration,
    ...delegateOptions
  } = options;

  return createWorkspaceShellDeferredController<WorkspaceShellRemoteCallbacksLazyLoadDelegate>(
    () => import('./workspace-shell-remote-callbacks-lazy-load-delegate.factory')
      .then(({ createWorkspaceShellRemoteCallbacksLazyLoadDelegate }) =>
        createWorkspaceShellRemoteCallbacksLazyLoadDelegate({
          ...delegateOptions,
          isReady: () => resolveRemoteCallbacksReady({
            coreDataLoaded,
            currentUserId,
            isStartupTierP2Ready,
            isTieredStartupHydration,
          }),
        })),
    {
      failureMessage: '远程恢复回调 lazy-load delegate 加载失败，已跳过本次注册',
      warn: options.warn,
    },
  );
}

function resolveRemoteCallbacksReady(options: {
  coreDataLoaded: () => boolean;
  currentUserId: () => string | null;
  isStartupTierP2Ready: () => boolean;
  isTieredStartupHydration: () => boolean;
}): boolean {
  return (
    !!options.currentUserId() &&
    options.coreDataLoaded() &&
    (!options.isTieredStartupHydration() || options.isStartupTierP2Ready())
  );
}
