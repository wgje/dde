import type {
  WorkspaceShellCriticalFeatureFlagsDelegate,
  WorkspaceShellCriticalFeatureFlagsLazyLoadDelegateOptions,
} from './workspace-shell-critical-feature-flags-lazy-load-delegate.factory';
import {
  WorkspaceShellCriticalFeatureFlagsDelegateLoaderController,
} from './workspace-shell-critical-feature-flags-delegate-loader.controller';

type WorkspaceShellCriticalFeatureFlagsWarning =
  WorkspaceShellCriticalFeatureFlagsLazyLoadDelegateOptions['warning'];

interface WorkspaceShellCriticalFeatureFlagsToastLike {
  warning: WorkspaceShellCriticalFeatureFlagsWarning;
}

export interface WorkspaceShellCriticalFeatureFlagsDelegatesOptions {
  toast: WorkspaceShellCriticalFeatureFlagsToastLike;
  warn: (message: string, context: unknown) => void;
  getHostname?: WorkspaceShellCriticalFeatureFlagsLazyLoadDelegateOptions['getHostname'];
  createCriticalFeatureFlagsLazyLoad?: (
    options: WorkspaceShellCriticalFeatureFlagsLazyLoadDelegateOptions,
  ) => WorkspaceShellCriticalFeatureFlagsDelegate;
}

export function createWorkspaceShellCriticalFeatureFlagsDelegates(
  options: WorkspaceShellCriticalFeatureFlagsDelegatesOptions,
): WorkspaceShellCriticalFeatureFlagsDelegate {
  const lazyOptions: WorkspaceShellCriticalFeatureFlagsLazyLoadDelegateOptions = {
    warn: options.warn,
    warning: (title, message, warningOptions) =>
      options.toast.warning(title, message, warningOptions),
    getHostname: options.getHostname ?? readBrowserHostname,
  };
  if (options.createCriticalFeatureFlagsLazyLoad) {
    return options.createCriticalFeatureFlagsLazyLoad(lazyOptions);
  }

  return new WorkspaceShellCriticalFeatureFlagsDelegateLoaderController({
    loadDelegate: () => import('./workspace-shell-critical-feature-flags-lazy-load-delegate.factory')
      .then(({ createWorkspaceShellCriticalFeatureFlagsLazyLoadDelegate }) =>
        createWorkspaceShellCriticalFeatureFlagsLazyLoadDelegate(lazyOptions)),
    warn: options.warn,
  });
}

function readBrowserHostname(): string | undefined {
  return typeof window === 'undefined' ? undefined : window.location?.hostname;
}
