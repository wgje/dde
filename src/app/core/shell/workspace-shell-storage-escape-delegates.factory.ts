import type { StorageEscapeData } from '../../shared/modals';
import {
  createWorkspaceShellStorageEscapeLazyLoadDelegate,
  type WorkspaceShellStorageEscapeLazyLoadDelegate,
  type WorkspaceShellStorageEscapeLazyLoadDelegateOptions,
} from './workspace-shell-storage-escape-lazy-load-delegate.factory';
import type { WorkspaceShellStorageFailureData } from './workspace-shell-storage-escape.controller';

interface WorkspaceShellStorageEscapeActionQueueLike {
  onStorageFailure(callback: (data: WorkspaceShellStorageFailureData) => void): void;
}

interface WorkspaceShellStorageEscapeProjectStateLike {
  projects(): unknown[];
}

interface WorkspaceShellStorageEscapeModalCoordinatorLike {
  storageEscapeData: {
    set(data: StorageEscapeData): void;
  };
  openStorageEscapeModalImperative(): Promise<void> | void;
  closeStorageEscapeModal(): void;
}

export interface WorkspaceShellStorageEscapeDelegatesOptions {
  actionQueue: WorkspaceShellStorageEscapeActionQueueLike;
  projectState: WorkspaceShellStorageEscapeProjectStateLike;
  modalCoord: WorkspaceShellStorageEscapeModalCoordinatorLike;
  nowIso?: () => string;
  warn: (message: string, error: unknown) => void;
  createStorageEscapeLazyLoad?: (
    options: WorkspaceShellStorageEscapeLazyLoadDelegateOptions,
  ) => WorkspaceShellStorageEscapeLazyLoadDelegate;
}

export function createWorkspaceShellStorageEscapeDelegates(
  options: WorkspaceShellStorageEscapeDelegatesOptions,
): WorkspaceShellStorageEscapeLazyLoadDelegate {
  return (options.createStorageEscapeLazyLoad ?? createWorkspaceShellStorageEscapeLazyLoadDelegate)({
    onStorageFailure: callback => options.actionQueue.onStorageFailure(callback),
    getProjects: () => options.projectState.projects(),
    setStorageEscapeData: data => options.modalCoord.storageEscapeData.set(data),
    openStorageEscapeModalImperative: () =>
      options.modalCoord.openStorageEscapeModalImperative(),
    closeStorageEscapeModal: () => options.modalCoord.closeStorageEscapeModal(),
    nowIso: options.nowIso ?? (() => new Date().toISOString()),
    warn: options.warn,
  });
}
