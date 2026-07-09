import type { StorageEscapeData } from '../../shared/modals';
import type { DeadLetterItem, QueuedAction } from '../../../services/action-queue.types';

export interface WorkspaceShellStorageFailureData {
  queue: QueuedAction[];
  deadLetter: DeadLetterItem[];
}

export interface WorkspaceShellStorageEscapeControllerOptions {
  onStorageFailure: (callback: (data: WorkspaceShellStorageFailureData) => void) => void;
  getProjects: () => unknown[];
  setStorageEscapeData: (data: StorageEscapeData) => void;
  openStorageEscapeModalImperative: () => Promise<void> | void;
  closeStorageEscapeModal: () => void;
  nowIso: () => string;
}

export class WorkspaceShellStorageEscapeController {
  private setupGeneration = 0;
  private active = false;

  constructor(private readonly options: WorkspaceShellStorageEscapeControllerOptions) {}

  setup(): void {
    const setupGeneration = ++this.setupGeneration;
    this.active = true;
    this.options.onStorageFailure((data) => {
      if (!this.active || setupGeneration !== this.setupGeneration) {
        return;
      }

      const escapeData: StorageEscapeData = {
        queue: data.queue,
        deadLetter: data.deadLetter,
        projects: this.options.getProjects(),
        timestamp: this.options.nowIso(),
      };

      this.options.setStorageEscapeData(escapeData);
      void this.options.openStorageEscapeModalImperative();
    });
  }

  close(): void {
    this.options.closeStorageEscapeModal();
  }

  teardown(): void {
    this.active = false;
    this.setupGeneration += 1;
  }
}
