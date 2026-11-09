import {
  WorkspaceShellModalEffectsController,
  type WorkspaceShellModalEffectsControllerOptions,
  type WorkspaceShellRecoverableModalError,
} from './workspace-shell-modal-effects.controller';

type WorkspaceShellModalEffectsModalType = 'login' | 'migration';

interface WorkspaceShellModalEffectsModalService {
  isOpen(type: WorkspaceShellModalEffectsModalType): boolean;
  getData(type: 'login'): { returnUrl?: string | null } | undefined;
  closeByType(type: WorkspaceShellModalEffectsModalType): void;
}

interface WorkspaceShellModalEffectsCoordinator {
  loginReturnUrl: string | null;
  loginModalRef: unknown | null;
  openErrorRecoveryModal: WorkspaceShellModalEffectsControllerOptions['openErrorRecoveryModal'];
  openLoginModal: () => Promise<void> | void;
  openMigrationModal: () => Promise<void> | void;
}

export interface WorkspaceShellModalEffectsFactoryOptions {
  errorHandler: {
    recoverableError: () => WorkspaceShellRecoverableModalError | null;
  };
  modal: WorkspaceShellModalEffectsModalService;
  modalCoord: WorkspaceShellModalEffectsCoordinator;
  warn: WorkspaceShellModalEffectsControllerOptions['warn'];
}

export function createWorkspaceShellModalEffectsController(
  options: WorkspaceShellModalEffectsFactoryOptions,
): WorkspaceShellModalEffectsController {
  return new WorkspaceShellModalEffectsController({
    recoverableError: () => options.errorHandler.recoverableError(),
    isModalOpen: type => options.modal.isOpen(type),
    getLoginData: () => options.modal.getData('login'),
    closeByType: type => options.modal.closeByType(type),
    getLoginReturnUrl: () => options.modalCoord.loginReturnUrl,
    setLoginReturnUrl: url => {
      options.modalCoord.loginReturnUrl = url;
    },
    hasLoginModalRef: () => !!options.modalCoord.loginModalRef,
    openErrorRecoveryModal: error =>
      options.modalCoord.openErrorRecoveryModal(error),
    openLoginModal: () => options.modalCoord.openLoginModal(),
    openMigrationModal: () => options.modalCoord.openMigrationModal(),
    warn: options.warn,
  });
}
