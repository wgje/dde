import {
  createWorkspaceShellDerivedUiStateController,
  type WorkspaceShellDerivedUiStateFactoryOptions,
} from './workspace-shell-derived-ui-state.factory';
import {
  createWorkspaceShellHandoffSurface,
  type WorkspaceShellHandoffSurfaceOptions,
} from './workspace-shell-handoff-controllers.factory';
import {
  createWorkspaceShellInteractionBoundarySurface,
  type WorkspaceShellInteractionBoundarySurfaceOptions,
} from './workspace-shell-interaction-surface.factory';

export type WorkspaceShellInteractionSurfacesOptions =
  WorkspaceShellDerivedUiStateFactoryOptions &
  WorkspaceShellHandoffSurfaceOptions &
  Omit<
    WorkspaceShellInteractionBoundarySurfaceOptions,
    'derivedUiState' | 'destroyed' | 'session'
  > & {
    readonly runtime: WorkspaceShellInteractionBoundarySurfaceOptions['destroyed'];
    readonly authService:
      WorkspaceShellInteractionBoundarySurfaceOptions['session']['authService'];
  };

export interface WorkspaceShellInteractionSurfaces {
  readonly derivedUiState:
    ReturnType<typeof createWorkspaceShellDerivedUiStateController>;
  readonly handoffControllers: ReturnType<typeof createWorkspaceShellHandoffSurface>;
  readonly interactionSurface:
    ReturnType<typeof createWorkspaceShellInteractionBoundarySurface>;
}

export function createWorkspaceShellInteractionSurfaces(
  options: WorkspaceShellInteractionSurfacesOptions,
): WorkspaceShellInteractionSurfaces {
  const derivedUiState = createWorkspaceShellDerivedUiStateController({
    ...options,
  });
  const handoffControllers = createWorkspaceShellHandoffSurface({
    ...options,
  });

  return {
    derivedUiState,
    handoffControllers,
    interactionSurface: createWorkspaceShellInteractionBoundarySurface({
      ...options,
      derivedUiState,
      destroyed: options.runtime,
      session: { authService: options.authService },
    }),
  };
}
