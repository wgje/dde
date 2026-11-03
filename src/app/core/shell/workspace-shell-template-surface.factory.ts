import type {
  WorkspaceShellInteractionTemplateSurface,
} from './workspace-shell-interaction-template-surface.factory';
import type {
  WorkspaceShellInteractionModalCoord,
  WorkspaceShellInteractionSurface,
} from './workspace-shell-interaction-surface.factory';
import type {
  WorkspaceShellModalLazyLoadDelegates,
} from './workspace-shell-modal-lazy-load.factory';
import type {
  WorkspaceShellStartupEntryControllers,
} from './workspace-shell-startup-entry-controllers.factory';
import {
  createWorkspaceShellTemplateStateDependencies,
  createWorkspaceShellTemplateState,
  type WorkspaceShellTemplateState,
  type WorkspaceShellTemplateStateDependenciesFactoryOptions,
} from './workspace-shell-template-state.factory';
import type {
  WorkspaceShellToolControllers,
} from './workspace-shell-tool-controllers.factory';

type WorkspaceShellTemplateModalCoord = WorkspaceShellInteractionModalCoord;

export interface WorkspaceShellTemplateSurfaceOptions<
  TModalCoord extends WorkspaceShellTemplateModalCoord =
    WorkspaceShellTemplateModalCoord,
> extends WorkspaceShellTemplateStateDependenciesFactoryOptions {
  readonly interactionSurface: Pick<
    WorkspaceShellInteractionSurface<TModalCoord>,
    'interaction' | 'modalLazyLoad'
  >;
  readonly startupEntryControllers: Pick<
    WorkspaceShellStartupEntryControllers,
    'androidWidgetLazyLoad' | 'pendingAndroidWidgetManualCallback'
  >;
  readonly toolControllers: Pick<
    WorkspaceShellToolControllers,
    'sidebarToolsLazyLoad' | 'toolTemplateBindings' | 'panelToolsIntent'
  >;
}

export interface WorkspaceShellTemplateSurface<
  TModalCoord extends WorkspaceShellTemplateModalCoord =
    WorkspaceShellTemplateModalCoord,
> {
  readonly interaction: WorkspaceShellInteractionTemplateSurface;
  readonly modal: {
    readonly actions: WorkspaceShellModalLazyLoadDelegates<TModalCoord>['actions'];
  };
  readonly startup: Pick<
    WorkspaceShellStartupEntryControllers,
    'androidWidgetLazyLoad' | 'pendingAndroidWidgetManualCallback'
  >;
  readonly state: WorkspaceShellTemplateState;
  readonly tools: {
    readonly bindings: WorkspaceShellToolControllers['toolTemplateBindings'];
    readonly sidebar: WorkspaceShellToolControllers['sidebarToolsLazyLoad'];
    readonly panelToolsIntent?: WorkspaceShellToolControllers['panelToolsIntent'];
  };
}

export function createWorkspaceShellTemplateSurface<
  TModalCoord extends WorkspaceShellTemplateModalCoord,
>(
  options: WorkspaceShellTemplateSurfaceOptions<TModalCoord>,
): WorkspaceShellTemplateSurface<TModalCoord> {
  return {
    interaction: options.interactionSurface.interaction,
    modal: {
      actions: options.interactionSurface.modalLazyLoad.actions,
    },
    startup: {
      androidWidgetLazyLoad: options.startupEntryControllers.androidWidgetLazyLoad,
      pendingAndroidWidgetManualCallback:
        options.startupEntryControllers.pendingAndroidWidgetManualCallback,
    },
    state: createWorkspaceShellTemplateState(
      createWorkspaceShellTemplateStateDependencies(options),
    ),
    tools: {
      bindings: options.toolControllers.toolTemplateBindings,
      sidebar: options.toolControllers.sidebarToolsLazyLoad,
      ...(options.toolControllers.panelToolsIntent
        ? { panelToolsIntent: options.toolControllers.panelToolsIntent }
        : {}),
    },
  };
}
