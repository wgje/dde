import { createWorkspaceShellDeferredController } from './workspace-shell-deferred-controller.helpers';
import type {
  WorkspaceShellViewportResizeLazyLoadHostOptions,
} from './workspace-shell-viewport-resize-lazy-load-host.controller';
import type {
  WorkspaceShellViewportResizeInteractionDelegate,
} from './workspace-shell-interaction-lazy-load-delegates.factory';
import {
  createWorkspaceShellInteractionViewportResizeHostLoader,
} from './workspace-shell-interaction-viewport-resize-host-loader.factory';

type WindowEventTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;

export type WorkspaceShellInteractionViewportResizeHostOptions =
  Omit<
    WorkspaceShellViewportResizeLazyLoadHostOptions,
    'createViewportResizeController' | 'getWindow' | 'isMobile' | 'listenToWindow' | 'setSidebarOpen' | 'warn'
  > & {
    getWindow?: () => Pick<Window, 'addEventListener' | 'innerWidth' | 'removeEventListener'> | undefined;
    isMobile: () => boolean;
    setSidebarOpen: (open: boolean) => void;
    warn: (message: string, error: unknown) => void;
    createViewportResizeHost?: () => Promise<WorkspaceShellViewportResizeInteractionDelegate>;
  };

export function createWorkspaceShellInteractionViewportResizeHost(
  options: WorkspaceShellInteractionViewportResizeHostOptions,
): WorkspaceShellViewportResizeInteractionDelegate {
  const loadViewportResizeHost = createWorkspaceShellInteractionViewportResizeHostLoader({
    options: {
      ...options,
      listenToWindow: createWindowListener(options),
    },
  });

  return createWorkspaceShellDeferredController<WorkspaceShellViewportResizeInteractionDelegate>(
    () => loadViewportResizeHost(),
    {
      failureMessage: '视口 resize lazy-load host 加载失败，已跳过本次操作',
      warn: options.warn,
    },
  );
}

function createWindowListener(
  options: WorkspaceShellInteractionViewportResizeHostOptions,
): (eventName: string, listener: EventListener) => () => void {
  return (eventName, listener) => {
    const targetWindow = (options.getWindow?.() as (WindowEventTarget | undefined))
      ?? (typeof window === 'undefined' ? undefined : window);
    if (!targetWindow) {
      return () => undefined;
    }

    targetWindow.addEventListener(eventName, listener);
    return () => targetWindow.removeEventListener(eventName, listener);
  };
}
