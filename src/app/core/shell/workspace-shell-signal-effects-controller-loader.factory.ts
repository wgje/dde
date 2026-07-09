import type {
  WorkspaceShellSignalEffectsControllerOptions,
} from './workspace-shell-signal-effects.controller';
import type {
  WorkspaceShellSignalEffectsHostDelegate,
} from './workspace-shell-signal-effects-lazy-load-host.controller';

export interface WorkspaceShellSignalEffectsControllerLoaderOptions
  extends Partial<WorkspaceShellSignalEffectsControllerOptions> {
  createSignalEffectsController?: () => Promise<WorkspaceShellSignalEffectsHostDelegate>;
  warn?: (message: string, error: unknown) => void;
}

export function createWorkspaceShellSignalEffectsControllerLoader(
  options: WorkspaceShellSignalEffectsControllerLoaderOptions,
): () => Promise<WorkspaceShellSignalEffectsHostDelegate> {
  if (options.createSignalEffectsController) {
    return options.createSignalEffectsController;
  }

  return () => import('./workspace-shell-signal-effects.controller')
    .then(({ WorkspaceShellSignalEffectsController }) =>
      new WorkspaceShellSignalEffectsController(
        options as WorkspaceShellSignalEffectsControllerOptions,
      ));
}
