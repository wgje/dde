import type {
  WorkspaceShellCriticalFeatureFlagsControllerOptions,
} from './workspace-shell-critical-feature-flags.controller';
import {
  WorkspaceShellCriticalFeatureFlagsLazyLoadDelegateController,
} from './workspace-shell-critical-feature-flags-lazy-load-delegate.controller';

export interface WorkspaceShellCriticalFeatureFlagsDelegate {
  validate(): void;
}

export interface WorkspaceShellCriticalFeatureFlagsLazyLoadDelegateOptions
  extends Omit<
    WorkspaceShellCriticalFeatureFlagsControllerOptions,
    'validateCriticalFlags' | 'warn'
  > {
  warn: (message: string, context: unknown) => void;
  createCriticalFeatureFlagsController?: () => Promise<WorkspaceShellCriticalFeatureFlagsDelegate>;
}

export function createWorkspaceShellCriticalFeatureFlagsLazyLoadDelegate(
  options: WorkspaceShellCriticalFeatureFlagsLazyLoadDelegateOptions,
): WorkspaceShellCriticalFeatureFlagsDelegate {
  return new WorkspaceShellCriticalFeatureFlagsLazyLoadDelegateController(options);
}
