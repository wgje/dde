import type {
  WorkspaceShellAfterViewInitControllerOptions,
} from './workspace-shell-after-view-init.controller';

export type WorkspaceShellLifecycleAfterViewInitOptions = Omit<
  WorkspaceShellAfterViewInitControllerOptions,
  'flowPrewarm'
>;

export interface WorkspaceShellLifecycleAfterViewInitOptionsFactoryOptions {
  readonly handoffControllers: {
    readonly readiness:
      WorkspaceShellLifecycleAfterViewInitOptions['handoffReadiness'];
  };
}

export function createWorkspaceShellLifecycleAfterViewInitOptions(
  options: WorkspaceShellLifecycleAfterViewInitOptionsFactoryOptions,
): WorkspaceShellLifecycleAfterViewInitOptions {
  return {
    handoffReadiness: options.handoffControllers.readiness,
  };
}
