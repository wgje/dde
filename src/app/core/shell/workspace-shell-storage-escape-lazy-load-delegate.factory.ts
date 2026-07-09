import type {
  WorkspaceShellStorageEscapeControllerOptions,
} from './workspace-shell-storage-escape.controller';
import type {
  WorkspaceShellStorageEscapeControllerFactory,
} from './workspace-shell-storage-escape-controller-loader.factory';
import {
  WorkspaceShellStorageEscapeLazyLoadDelegateController,
} from './workspace-shell-storage-escape-lazy-load-delegate.controller';

export interface WorkspaceShellStorageEscapeLazyLoadDelegate {
  close(): void;
  setup(): void;
  teardown(): void;
}

export interface WorkspaceShellStorageEscapeLazyLoadDelegateOptions
  extends WorkspaceShellStorageEscapeControllerOptions {
  createStorageEscapeController?: WorkspaceShellStorageEscapeControllerFactory;
  warn: (message: string, error: unknown) => void;
}

export function createWorkspaceShellStorageEscapeLazyLoadDelegate(
  options: WorkspaceShellStorageEscapeLazyLoadDelegateOptions,
): WorkspaceShellStorageEscapeLazyLoadDelegate {
  return new WorkspaceShellStorageEscapeLazyLoadDelegateController(options);
}
