import { createWorkspaceShellDeferredController } from './workspace-shell-deferred-controller.helpers';
import type {
  WorkspaceShellInteractionLifecycleController,
  WorkspaceShellInteractionLifecycleControllerOptions,
} from './workspace-shell-interaction-lifecycle.controller';
import {
  createWorkspaceShellInteractionLifecycleHostLoader,
} from './workspace-shell-interaction-lifecycle-host-loader.factory';

export type WorkspaceShellInteractionLifecycleHostOptions =
  WorkspaceShellInteractionLifecycleControllerOptions & {
    warn: (message: string, error: unknown) => void;
  };

export function createWorkspaceShellInteractionLifecycleHost(
  options: WorkspaceShellInteractionLifecycleHostOptions,
): WorkspaceShellInteractionLifecycleController {
  const { warn, ...controllerOptions } = options;
  const loadLifecycleController = createWorkspaceShellInteractionLifecycleHostLoader({
    options: controllerOptions,
  });

  return createWorkspaceShellDeferredController<WorkspaceShellInteractionLifecycleController>(
    () => loadLifecycleController(),
    {
      failureMessage: '交互生命周期 lazy-load controller 加载失败，已跳过本次阶段',
      warn,
    },
  );
}
