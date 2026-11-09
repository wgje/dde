import type {
  WorkspaceShellInteractionLazyLoadDelegates,
} from './workspace-shell-interaction-lazy-load-delegates.factory';

export type WorkspaceShellInteractionTemplateSurface = Pick<
  WorkspaceShellInteractionLazyLoadDelegates,
  'actions' | 'sidebarResize' | 'touchGestures'
>;

export function createWorkspaceShellInteractionTemplateSurface(
  delegates: WorkspaceShellInteractionLazyLoadDelegates,
): WorkspaceShellInteractionTemplateSurface {
  return {
    actions: delegates.actions,
    sidebarResize: delegates.sidebarResize,
    touchGestures: delegates.touchGestures,
  };
}
