import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellModalEffectsController,
  type WorkspaceShellModalEffectsControllerOptions,
} from './workspace-shell-modal-effects.controller';

type RecoverableError = {
  title: string;
  message: string;
  details?: string;
  options: unknown[];
  defaultOptionId?: string;
  autoSelectIn?: number | null;
  resolve: (optionId: string) => void;
};

function createController(overrides: Partial<WorkspaceShellModalEffectsControllerOptions> = {}) {
  let recoverableError: RecoverableError | null = null;
  let loginOpen = false;
  let migrationOpen = false;
  let loginData: { returnUrl?: string | null } | undefined;
  let loginModalOpen = false;
  const closeByType = vi.fn((type: 'login' | 'migration') => {
    if (type === 'login') loginOpen = false;
    if (type === 'migration') migrationOpen = false;
  });
  const openErrorRecoveryModal = vi.fn();
  const openLoginModal = vi.fn();
  const openMigrationModal = vi.fn();
  const warn = vi.fn();
  let loginReturnUrl: string | null = null;
  const controller = new WorkspaceShellModalEffectsController({
    recoverableError: () => recoverableError,
    isModalOpen: type => type === 'login' ? loginOpen : migrationOpen,
    getLoginData: () => loginData,
    closeByType,
    getLoginReturnUrl: () => loginReturnUrl,
    setLoginReturnUrl: url => {
      loginReturnUrl = url;
    },
    hasLoginModalRef: () => loginModalOpen,
    openErrorRecoveryModal,
    openLoginModal,
    openMigrationModal,
    warn,
    ...overrides,
  });

  return {
    closeByType,
    controller,
    openErrorRecoveryModal,
    openLoginModal,
    openMigrationModal,
    warn,
    setLoginData: (data: { returnUrl?: string | null } | undefined) => {
      loginData = data;
    },
    setLoginModalOpen: (open: boolean) => {
      loginModalOpen = open;
    },
    setLoginOpen: (open: boolean) => {
      loginOpen = open;
    },
    setMigrationOpen: (open: boolean) => {
      migrationOpen = open;
    },
    setRecoverableError: (error: RecoverableError | null) => {
      recoverableError = error;
    },
    loginReturnUrl: () => loginReturnUrl,
  };
}

describe('WorkspaceShellModalEffectsController', () => {
  it('opens the recovery modal for the active recoverable error', () => {
    const resolve = vi.fn();
    const {
      controller,
      openErrorRecoveryModal,
      setRecoverableError,
    } = createController();
    setRecoverableError({
      title: '恢复操作',
      message: '请选择恢复方式',
      details: 'detail',
      options: [{ id: 'retry' }],
      defaultOptionId: 'retry',
      autoSelectIn: 3000,
      resolve,
    });

    controller.syncRecoverableError();

    expect(openErrorRecoveryModal).toHaveBeenCalledWith({
      title: '恢复操作',
      message: '请选择恢复方式',
      details: 'detail',
      options: [{ id: 'retry' }],
      defaultOptionId: 'retry',
      autoSelectIn: 3000,
      resolve: expect.any(Function),
    });

    const modalInput = openErrorRecoveryModal.mock.calls[0]?.[0];
    modalInput.resolve({ optionId: 'retry' });
    expect(resolve).toHaveBeenCalledWith('retry');
  });

  it('warns instead of throwing when recovery modal open fails', () => {
    const error = new Error('recovery modal failed');
    const {
      controller,
      openErrorRecoveryModal,
      setRecoverableError,
      warn,
    } = createController();
    openErrorRecoveryModal.mockImplementationOnce(() => {
      throw error;
    });
    setRecoverableError({
      title: '恢复操作',
      message: '请选择恢复方式',
      options: [{ id: 'retry' }],
      resolve: vi.fn(),
    });

    expect(() => controller.syncRecoverableError()).not.toThrow();

    expect(warn).toHaveBeenCalledWith('恢复操作弹窗打开失败，已跳过本次展示', error);
  });

  it('consumes a login modal request and opens login once', () => {
    const {
      closeByType,
      controller,
      loginReturnUrl,
      openLoginModal,
      setLoginData,
      setLoginOpen,
    } = createController();
    setLoginOpen(true);
    setLoginData({ returnUrl: '/projects/project-1' });

    controller.syncLoginRequest();

    expect(loginReturnUrl()).toBe('/projects/project-1');
    expect(closeByType).toHaveBeenCalledWith('login');
    expect(openLoginModal).toHaveBeenCalledTimes(1);
  });

  it('warns instead of throwing when login modal open fails after consuming the request', () => {
    const error = new Error('login modal failed');
    const {
      closeByType,
      controller,
      openLoginModal,
      setLoginOpen,
      warn,
    } = createController();
    openLoginModal.mockImplementationOnce(() => {
      throw error;
    });
    setLoginOpen(true);

    expect(() => controller.syncLoginRequest()).not.toThrow();

    expect(closeByType).toHaveBeenCalledWith('login');
    expect(warn).toHaveBeenCalledWith('登录弹窗打开失败，已跳过本次展示', error);
  });

  it('does not throw when warning a login modal open failure also fails', () => {
    const error = new Error('login modal failed');
    const warningError = new Error('warning sink failed');
    const {
      closeByType,
      controller,
      openLoginModal,
      setLoginOpen,
      warn,
    } = createController();
    openLoginModal.mockImplementationOnce(() => {
      throw error;
    });
    warn.mockImplementationOnce(() => {
      throw warningError;
    });
    setLoginOpen(true);

    expect(() => controller.syncLoginRequest()).not.toThrow();

    expect(closeByType).toHaveBeenCalledWith('login');
    expect(warn).toHaveBeenCalledWith('登录弹窗打开失败，已跳过本次展示', error);
  });

  it('does not reopen login when a login modal ref already exists', () => {
    const {
      closeByType,
      controller,
      openLoginModal,
      setLoginModalOpen,
      setLoginOpen,
    } = createController();
    setLoginOpen(true);
    setLoginModalOpen(true);

    controller.syncLoginRequest();

    expect(closeByType).toHaveBeenCalledWith('login');
    expect(openLoginModal).not.toHaveBeenCalled();
  });

  it('consumes a migration modal request and opens migration', () => {
    const {
      closeByType,
      controller,
      openMigrationModal,
      setMigrationOpen,
    } = createController();
    setMigrationOpen(true);

    controller.syncMigrationRequest();

    expect(closeByType).toHaveBeenCalledWith('migration');
    expect(openMigrationModal).toHaveBeenCalledTimes(1);
  });

  it('warns instead of throwing when migration modal open fails after consuming the request', () => {
    const error = new Error('migration modal failed');
    const {
      closeByType,
      controller,
      openMigrationModal,
      setMigrationOpen,
      warn,
    } = createController();
    openMigrationModal.mockImplementationOnce(() => {
      throw error;
    });
    setMigrationOpen(true);

    expect(() => controller.syncMigrationRequest()).not.toThrow();

    expect(closeByType).toHaveBeenCalledWith('migration');
    expect(warn).toHaveBeenCalledWith('迁移弹窗打开失败，已跳过本次展示', error);
  });
});
