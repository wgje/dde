import type { ProjectUiOwner } from '../../../services/task-operation-trash-adapter.controller';

export interface WorkspaceShellErrorRecoveryModalInput {
  title: string;
  message: string;
  details?: string;
  options: unknown[];
  defaultOptionId?: string;
  autoSelectIn?: number | null;
  resolve(result: { optionId: string }): void;
}

export interface WorkspaceShellModalActionsCoordinator {
  resolveConflictLocal(): Promise<void>;
  resolveConflictRemote(): Promise<void>;
  resolveConflictMerge(): Promise<void>;
  cancelConflictResolution(): void;
  openSettings(): Promise<void>;
  closeSettings(): void;
  openDashboard(options?: { initialTab?: string }): Promise<void>;
  openDashboardFromSettings(): Promise<void>;
  openConflictCenterFromDashboard(): void;
  openLoginModal(): Promise<void>;
  captureProjectUiOwner(): ProjectUiOwner | null;
  openTrashModal(owner?: ProjectUiOwner | null): Promise<void>;
  openConfigHelpModal(): Promise<void>;
  openNewProjectModal(): Promise<void>;
  openMigrationModal(): Promise<void>;
  openErrorRecoveryModal(error: WorkspaceShellErrorRecoveryModalInput): Promise<void>;
  openStorageEscapeModalImperative(): Promise<void>;
}

export interface WorkspaceShellModalActionsControllerOptions {
  storageEscape: { close(): void };
  modalCoord: WorkspaceShellModalActionsCoordinator;
}

export class WorkspaceShellModalActionsController {
  constructor(private readonly options: WorkspaceShellModalActionsControllerOptions) {}

  closeStorageEscapeModal(): void {
    this.options.storageEscape.close();
  }

  resolveConflictLocal(): Promise<void> {
    return this.options.modalCoord.resolveConflictLocal();
  }

  resolveConflictRemote(): Promise<void> {
    return this.options.modalCoord.resolveConflictRemote();
  }

  resolveConflictMerge(): Promise<void> {
    return this.options.modalCoord.resolveConflictMerge();
  }

  cancelConflictResolution(): void {
    this.options.modalCoord.cancelConflictResolution();
  }

  openSettings(): Promise<void> {
    return this.options.modalCoord.openSettings();
  }

  closeSettings(): void {
    this.options.modalCoord.closeSettings();
  }

  openDashboardFromSettings(): Promise<void> {
    return this.options.modalCoord.openDashboardFromSettings();
  }

  openDashboard(): Promise<void> {
    return this.options.modalCoord.openDashboard();
  }

  openDashboardAtConflicts(): Promise<void> {
    return this.options.modalCoord.openDashboard({ initialTab: 'conflicts' });
  }

  openConflictCenterFromDashboard(): void {
    this.options.modalCoord.openConflictCenterFromDashboard();
  }

  openLoginModal(): Promise<void> {
    return this.options.modalCoord.openLoginModal();
  }

  openTrashModal(owner?: ProjectUiOwner | null): Promise<void> {
    return this.options.modalCoord.openTrashModal(owner);
  }

  openConfigHelpModal(): Promise<void> {
    return this.options.modalCoord.openConfigHelpModal();
  }

  openNewProjectModal(): Promise<void> {
    return this.options.modalCoord.openNewProjectModal();
  }

  openMigrationModal(): Promise<void> {
    return this.options.modalCoord.openMigrationModal();
  }

  openErrorRecoveryModal(error: WorkspaceShellErrorRecoveryModalInput): Promise<void> {
    return this.options.modalCoord.openErrorRecoveryModal(error);
  }

  openStorageEscapeModalImperative(): Promise<void> {
    return this.options.modalCoord.openStorageEscapeModalImperative();
  }
}
