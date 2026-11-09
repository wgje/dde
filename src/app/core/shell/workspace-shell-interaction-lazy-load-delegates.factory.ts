import type { WorkspaceShellActionsLazyLoadHostDelegate } from './workspace-shell-actions-lazy-load-host.controller';
import {
  createWorkspaceShellInteractionActionsHost,
  type WorkspaceShellInteractionActionsHostOptions,
} from './workspace-shell-interaction-actions-host.factory';
import {
  createWorkspaceShellInteractionViewportResizeHost,
  type WorkspaceShellInteractionViewportResizeHostOptions,
} from './workspace-shell-interaction-viewport-resize-host.factory';
import {
  createWorkspaceShellInteractionModalCallbacks,
  type WorkspaceShellModalCallbacksDelegate,
} from './workspace-shell-interaction-modal-callbacks.factory';
import {
  createWorkspaceShellInteractionTouchGesturesHost,
  type WorkspaceShellInteractionTouchGesturesHostOptions,
} from './workspace-shell-interaction-touch-gestures-host.factory';
import {
  createWorkspaceShellInteractionLifecycleHost,
} from './workspace-shell-interaction-lifecycle-host.factory';
import {
  createWorkspaceShellInteractionAuthModalHost,
  type WorkspaceShellInteractionAuthModalHostOptions,
} from './workspace-shell-interaction-auth-modal-host.factory';
import type {
  WorkspaceShellModalCallbackActions,
} from './workspace-shell-modal-callbacks.controller';
import type {
  WorkspaceShellAuthModalFactoryDelegate,
} from './workspace-shell-auth-modal.factory';
import type {
  WorkspaceShellInteractionLifecycleController,
} from './workspace-shell-interaction-lifecycle.controller';
import {
  createWorkspaceShellInteractionSidebarResizeHost,
  type WorkspaceShellInteractionSidebarResizeDelegate,
  type WorkspaceShellInteractionSidebarResizeHostOptions,
} from './workspace-shell-interaction-sidebar-resize-host.factory';
import type {
  WorkspaceShellTouchGestureControllerLike,
} from './workspace-shell-touch-gesture-lazy-load.controller';
import type { WorkspaceShellViewportResizeHostDelegate } from './workspace-shell-viewport-resize-lazy-load-host.controller';

export interface WorkspaceShellViewportResizeInteractionDelegate
  extends WorkspaceShellViewportResizeHostDelegate {
  setup(): void;
}

export type WorkspaceShellActionsInteractionDelegate =
  WorkspaceShellActionsLazyLoadHostDelegate &
  WorkspaceShellModalCallbackActions;

export interface WorkspaceShellInteractionLazyLoadDelegates {
  readonly authModal: WorkspaceShellAuthModalFactoryDelegate;
  readonly touchGestures: WorkspaceShellTouchGestureControllerLike;
  readonly actions: WorkspaceShellActionsInteractionDelegate;
  readonly viewportResize: WorkspaceShellViewportResizeInteractionDelegate;
  readonly sidebarResize: WorkspaceShellInteractionSidebarResizeDelegate;
  readonly lifecycle: WorkspaceShellInteractionLifecycleController;
  readonly modalCallbacks: WorkspaceShellModalCallbacksDelegate;
}

export type WorkspaceShellInteractionLazyLoadDelegateOptions =
  Omit<WorkspaceShellInteractionTouchGesturesHostOptions, 'warn'> &
  Omit<WorkspaceShellInteractionActionsHostOptions, 'authModal' | 'warn'> &
  Omit<WorkspaceShellInteractionAuthModalHostOptions, 'warn'> &
  Omit<
    WorkspaceShellInteractionSidebarResizeHostOptions,
    'createSidebarResizeDelegate' | 'createSidebarResizeFactoryHost' | 'getDocument' | 'warn'
  > &
  Omit<WorkspaceShellInteractionViewportResizeHostOptions, 'warn'> & {
  getDocument?: () => Document | undefined;
  getWindow?: () => Pick<Window, 'addEventListener' | 'innerWidth' | 'removeEventListener'> | undefined;
  isMobile: () => boolean;
  setSidebarOpen: (open: boolean) => void;
  warn: (message: string, error: unknown) => void;
  createTouchGesturesHost?: () => Promise<WorkspaceShellTouchGestureControllerLike>;
  createActionsHost?: () => WorkspaceShellActionsInteractionDelegate;
  createViewportResizeHost?: () => Promise<WorkspaceShellViewportResizeInteractionDelegate>;
  createSidebarResizeFactoryHost?: () => Promise<WorkspaceShellInteractionSidebarResizeDelegate>;
  createSidebarResizeDelegate?: WorkspaceShellInteractionSidebarResizeHostOptions['createSidebarResizeDelegate'];
};

export function createWorkspaceShellInteractionLazyLoadDelegates(
  options: WorkspaceShellInteractionLazyLoadDelegateOptions,
): WorkspaceShellInteractionLazyLoadDelegates {
  const authModal = createWorkspaceShellInteractionAuthModalHost(options);
  const touchGestures = createWorkspaceShellInteractionTouchGesturesHost(options);
  const actions = createWorkspaceShellInteractionActionsHost({ ...options, authModal });
  const viewportResize = createWorkspaceShellInteractionViewportResizeHost(options);
  const sidebarResize = createWorkspaceShellInteractionSidebarResizeHost(options);
  const lifecycle = createWorkspaceShellInteractionLifecycleHost({
    sidebarResize,
    viewportResize,
    actions,
    authModal,
    warn: options.warn,
  });
  const modalCallbacks = createWorkspaceShellInteractionModalCallbacks({
    actions,
    warn: options.warn,
  });

  return { authModal, touchGestures, actions, viewportResize, sidebarResize, lifecycle, modalCallbacks };
}
