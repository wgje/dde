import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

interface ErrorRecoveryModalInput {
  autoSelectIn?: number | null;
  defaultOptionId?: string;
  details?: string;
  message: string;
  options: unknown[];
  resolve(result: { optionId: string }): void;
  title: string;
}

interface ModalCoordinator {
  cancelConflictResolution(): void;
  closeSettings(): void;
  openConfigHelpModal(): Promise<void>;
  openConflictCenterFromDashboard(): void;
  openDashboard(options?: { initialTab?: string }): Promise<void>;
  openDashboardFromSettings(): Promise<void>;
  openErrorRecoveryModal(error: ErrorRecoveryModalInput): Promise<void>;
  openLoginModal(): Promise<void>;
  openMigrationModal(): Promise<void>;
  openNewProjectModal(): Promise<void>;
  openSettings(): Promise<void>;
  openStorageEscapeModalImperative(): Promise<void>;
  openTrashModal(): Promise<void>;
  resolveConflictLocal(): Promise<void>;
  resolveConflictMerge(): Promise<void>;
  resolveConflictRemote(): Promise<void>;
}

interface ModalActionsControllerOptions {
  modalCoord: ModalCoordinator;
  storageEscape: { close(): void };
}

interface ModalActionsController {
  cancelConflictResolution(): void;
  closeSettings(): void;
  closeStorageEscapeModal(): void;
  openConfigHelpModal(): Promise<void>;
  openConflictCenterFromDashboard(): void;
  openDashboard(): Promise<void>;
  openDashboardAtConflicts(): Promise<void>;
  openDashboardFromSettings(): Promise<void>;
  openErrorRecoveryModal(error: ErrorRecoveryModalInput): Promise<void>;
  openLoginModal(): Promise<void>;
  openMigrationModal(): Promise<void>;
  openNewProjectModal(): Promise<void>;
  openSettings(): Promise<void>;
  openStorageEscapeModalImperative(): Promise<void>;
  openTrashModal(): Promise<void>;
  resolveConflictLocal(): Promise<void>;
  resolveConflictMerge(): Promise<void>;
  resolveConflictRemote(): Promise<void>;
}

type ModalActionsControllerConstructor = new (
  options: ModalActionsControllerOptions,
) => ModalActionsController;

async function loadController(): Promise<ModalActionsControllerConstructor> {
  const modulePath = './workspace-shell-modal-actions.controller';
  const controllerModule = await import(/* @vite-ignore */ modulePath)
    .catch(() => ({}));
  const Controller = Reflect.get(
    controllerModule,
    'WorkspaceShellModalActionsController',
  ) as ModalActionsControllerConstructor | undefined;

  expect(Controller).toEqual(expect.any(Function));
  return Controller!;
}

function createContext(): {
  modalCoord: ModalCoordinator;
  options: ModalActionsControllerOptions;
  storageEscape: { close: ReturnType<typeof vi.fn> };
} {
  const modalCoord: ModalCoordinator = {
    resolveConflictLocal: vi.fn().mockResolvedValue(undefined),
    resolveConflictRemote: vi.fn().mockResolvedValue(undefined),
    resolveConflictMerge: vi.fn().mockResolvedValue(undefined),
    cancelConflictResolution: vi.fn(),
    openSettings: vi.fn().mockResolvedValue(undefined),
    closeSettings: vi.fn(),
    openDashboard: vi.fn().mockResolvedValue(undefined),
    openDashboardFromSettings: vi.fn().mockResolvedValue(undefined),
    openConflictCenterFromDashboard: vi.fn(),
    openLoginModal: vi.fn().mockResolvedValue(undefined),
    openTrashModal: vi.fn().mockResolvedValue(undefined),
    openConfigHelpModal: vi.fn().mockResolvedValue(undefined),
    openNewProjectModal: vi.fn().mockResolvedValue(undefined),
    openMigrationModal: vi.fn().mockResolvedValue(undefined),
    openErrorRecoveryModal: vi.fn().mockResolvedValue(undefined),
    openStorageEscapeModalImperative: vi.fn().mockResolvedValue(undefined),
  };
  const storageEscape = { close: vi.fn() };

  return {
    modalCoord,
    storageEscape,
    options: { modalCoord, storageEscape },
  };
}

describe('WorkspaceShellModalActionsController', () => {
  it('owns modal command forwarding outside Actions', async () => {
    await loadController();
    const source = readFileSync(
      join(__dirname, 'workspace-shell-actions.controller.ts'),
      'utf8',
    );

    expect(source).toContain('WorkspaceShellModalActionsController');
    expect(source).toContain('this.modalActions.openDashboardAtConflicts()');
    expect(source).not.toContain('type WorkspaceShellModalCoordinatorLike');
    expect(source).not.toContain('this.options.modalCoord');
    expect(source).not.toContain('this.options.storageEscape');
  });

  it('forwards storage escape and conflict commands', async () => {
    const Controller = await loadController();
    const context = createContext();
    const controller = new Controller(context.options);

    controller.closeStorageEscapeModal();
    await controller.resolveConflictLocal();
    await controller.resolveConflictRemote();
    await controller.resolveConflictMerge();
    controller.cancelConflictResolution();

    expect(context.storageEscape.close).toHaveBeenCalledTimes(1);
    expect(context.modalCoord.resolveConflictLocal).toHaveBeenCalledTimes(1);
    expect(context.modalCoord.resolveConflictRemote).toHaveBeenCalledTimes(1);
    expect(context.modalCoord.resolveConflictMerge).toHaveBeenCalledTimes(1);
    expect(context.modalCoord.cancelConflictResolution).toHaveBeenCalledTimes(1);
  });

  it('forwards settings and dashboard commands with the conflict tab option', async () => {
    const Controller = await loadController();
    const context = createContext();
    const controller = new Controller(context.options);

    await controller.openSettings();
    controller.closeSettings();
    await controller.openDashboardFromSettings();
    await controller.openDashboard();
    await controller.openDashboardAtConflicts();
    controller.openConflictCenterFromDashboard();

    expect(context.modalCoord.openSettings).toHaveBeenCalledTimes(1);
    expect(context.modalCoord.closeSettings).toHaveBeenCalledTimes(1);
    expect(context.modalCoord.openDashboardFromSettings).toHaveBeenCalledTimes(1);
    expect(context.modalCoord.openDashboard).toHaveBeenNthCalledWith(1);
    expect(context.modalCoord.openDashboard).toHaveBeenNthCalledWith(
      2,
      { initialTab: 'conflicts' },
    );
    expect(context.modalCoord.openConflictCenterFromDashboard).toHaveBeenCalledTimes(1);
  });

  it('forwards modal entry commands and error recovery input', async () => {
    const Controller = await loadController();
    const context = createContext();
    const controller = new Controller(context.options);
    const errorInput: ErrorRecoveryModalInput = {
      title: 'Recover',
      message: 'Choose an action',
      options: [],
      resolve: vi.fn(),
    };

    await controller.openLoginModal();
    await controller.openTrashModal();
    await controller.openConfigHelpModal();
    await controller.openNewProjectModal();
    await controller.openMigrationModal();
    await controller.openErrorRecoveryModal(errorInput);
    await controller.openStorageEscapeModalImperative();

    expect(context.modalCoord.openLoginModal).toHaveBeenCalledTimes(1);
    expect(context.modalCoord.openTrashModal).toHaveBeenCalledTimes(1);
    expect(context.modalCoord.openConfigHelpModal).toHaveBeenCalledTimes(1);
    expect(context.modalCoord.openNewProjectModal).toHaveBeenCalledTimes(1);
    expect(context.modalCoord.openMigrationModal).toHaveBeenCalledTimes(1);
    expect(context.modalCoord.openErrorRecoveryModal).toHaveBeenCalledWith(errorInput);
    expect(context.modalCoord.openStorageEscapeModalImperative).toHaveBeenCalledTimes(1);
  });
});
