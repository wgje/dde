import {
  WorkspaceShellLazyLifecycleHostController,
  type WorkspaceShellLazyLifecycleDelegate,
} from './workspace-shell-lazy-lifecycle-host.controller';

export interface WorkspaceShellLazyLifecycleHostMemberOptions {
  createController: () => Promise<WorkspaceShellLazyLifecycleDelegate>;
  initializeFailureMessage: string;
  teardownFailureMessage: string;
  warn: (message: string, error: unknown) => void;
}

export function createWorkspaceShellLazyLifecycleHostMember(
  options: WorkspaceShellLazyLifecycleHostMemberOptions,
): WorkspaceShellLazyLifecycleDelegate {
  return new WorkspaceShellLazyLifecycleHostController({
    createController: options.createController,
    initializeFailureMessage: options.initializeFailureMessage,
    initializeMode: 'latest-only',
    teardownFailureMessage: options.teardownFailureMessage,
    warn: options.warn,
  });
}
