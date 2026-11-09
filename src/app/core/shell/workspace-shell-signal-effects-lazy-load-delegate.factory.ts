import { createWorkspaceShellDeferredController } from './workspace-shell-deferred-controller.helpers';
import type {
  WorkspaceShellSignalEffectsHostDelegate,
  WorkspaceShellSignalEffectsLazyLoadHostOptions,
} from './workspace-shell-signal-effects-lazy-load-host.controller';
import {
  createWorkspaceShellSignalEffectsLazyLoadHostLoader,
} from './workspace-shell-signal-effects-lazy-load-host-loader.factory';

export interface WorkspaceShellSignalEffectsLazyLoadDelegate
  extends WorkspaceShellSignalEffectsHostDelegate {
  teardown(): void;
}

export interface WorkspaceShellSignalEffectsLazyLoadDelegateOptions
  extends WorkspaceShellSignalEffectsLazyLoadHostOptions {
  createSignalEffectsLazyLoadHost?: () => Promise<WorkspaceShellSignalEffectsLazyLoadDelegate>;
}

export function createWorkspaceShellSignalEffectsLazyLoadDelegate(
  options: WorkspaceShellSignalEffectsLazyLoadDelegateOptions,
): WorkspaceShellSignalEffectsLazyLoadDelegate {
  const loadSignalEffectsLazyLoadHost =
    createWorkspaceShellSignalEffectsLazyLoadHostLoader({
      createSignalEffectsLazyLoadHost: options.createSignalEffectsLazyLoadHost,
      options,
    });

  return createWorkspaceShellDeferredController<WorkspaceShellSignalEffectsLazyLoadDelegate>(
    loadSignalEffectsLazyLoadHost,
    {
      failureMessage: 'Workspace shell signal effects lazy-load host failed',
      warn: options.warn,
    },
  );
}
