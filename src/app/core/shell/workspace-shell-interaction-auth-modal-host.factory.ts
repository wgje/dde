import { createWorkspaceShellDeferredController } from './workspace-shell-deferred-controller.helpers';
import type {
  WorkspaceShellAuthModalFactoryDelegate,
  WorkspaceShellAuthModalFactoryOptions,
} from './workspace-shell-auth-modal.factory';
import {
  createWorkspaceShellInteractionAuthModalHostLoader,
} from './workspace-shell-interaction-auth-modal-host-loader.factory';

export interface WorkspaceShellInteractionAuthModalHostOptions
  extends WorkspaceShellAuthModalFactoryOptions {
  warn: (message: string, error: unknown) => void;
}

export function createWorkspaceShellInteractionAuthModalHost(
  options: WorkspaceShellInteractionAuthModalHostOptions,
): WorkspaceShellAuthModalFactoryDelegate {
  const loadAuthModalDelegate = createWorkspaceShellInteractionAuthModalHostLoader({
    options,
  });

  return createWorkspaceShellDeferredController<WorkspaceShellAuthModalFactoryDelegate>(
    () => loadAuthModalDelegate(),
    {
      failureMessage: '认证模态框 lazy-load delegate 加载失败，认证表单暂不可用',
      warn: options.warn,
    },
  );
}
