import { createWorkspaceShellDeferredController } from './workspace-shell-deferred-controller.helpers';
import {
  createWorkspaceShellInteractionTouchGesturesHostLoader,
  type WorkspaceShellInteractionTouchGesturesHostLike,
  type WorkspaceShellInteractionTouchGesturesHostOptions,
} from './workspace-shell-interaction-touch-gestures-host-loader.factory';

export type {
  WorkspaceShellInteractionTouchGesturesHostOptions,
} from './workspace-shell-interaction-touch-gestures-host-loader.factory';

export function createWorkspaceShellInteractionTouchGesturesHost(
  options: WorkspaceShellInteractionTouchGesturesHostOptions,
): WorkspaceShellInteractionTouchGesturesHostLike {
  const loadTouchGesturesHost = createWorkspaceShellInteractionTouchGesturesHostLoader({
    createTouchGesturesHost: options.createTouchGesturesHost,
    options: {
      activeView: options.activeView,
      isMobile: options.isMobile,
      setSidebarOpen: options.setSidebarOpen,
      warn: options.warn,
    },
  });

  return createWorkspaceShellDeferredController<WorkspaceShellInteractionTouchGesturesHostLike>(
    () => loadTouchGesturesHost(),
    {
      failureMessage: '触摸手势 lazy-load host 加载失败，已跳过本次手势',
      warn: options.warn,
    },
  );
}
