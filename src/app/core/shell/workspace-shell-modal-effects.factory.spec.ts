import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellModalEffectsController,
} from './workspace-shell-modal-effects.factory';
import type {
  WorkspaceShellRecoverableModalError,
} from './workspace-shell-modal-effects.controller';

describe('createWorkspaceShellModalEffectsController', () => {
  it('wires modal effects through shell services outside the workspace shell component', () => {
    let recoverableError: WorkspaceShellRecoverableModalError | null = null;
    let loginOpen = false;
    let loginReturnUrl: string | null = null;
    const openErrorRecoveryModal = vi.fn();
    const openLoginModal = vi.fn();
    const openMigrationModal = vi.fn();
    const warn = vi.fn();
    const closeByType = vi.fn((type: 'login' | 'migration') => {
      if (type === 'login') loginOpen = false;
    });
    const controller = createWorkspaceShellModalEffectsController({
      errorHandler: {
        recoverableError: () => recoverableError,
      },
      modal: {
        isOpen: type => type === 'login' ? loginOpen : false,
        getData: () => ({ returnUrl: '/projects/project-1' }),
        closeByType,
      },
      modalCoord: {
        get loginReturnUrl() {
          return loginReturnUrl;
        },
        set loginReturnUrl(url: string | null) {
          loginReturnUrl = url;
        },
        loginModalRef: null,
        openErrorRecoveryModal,
        openLoginModal,
        openMigrationModal,
      },
      warn,
    });

    const resolve = vi.fn();
    recoverableError = {
      title: '恢复操作',
      message: '请选择恢复方式',
      options: [{ id: 'retry' }],
      resolve,
    };
    controller.syncRecoverableError();
    loginOpen = true;
    controller.syncLoginRequest();

    expect(openErrorRecoveryModal).toHaveBeenCalledWith({
      title: '恢复操作',
      message: '请选择恢复方式',
      details: undefined,
      options: [{ id: 'retry' }],
      defaultOptionId: undefined,
      autoSelectIn: undefined,
      resolve: expect.any(Function),
    });
    expect(loginReturnUrl).toBe('/projects/project-1');
    expect(closeByType).toHaveBeenCalledWith('login');
    expect(openLoginModal).toHaveBeenCalledOnce();
    expect(openMigrationModal).not.toHaveBeenCalled();
  });

  it('wires modal open failures to the shell warning channel', () => {
    let loginOpen = true;
    const error = new Error('login modal failed');
    const warn = vi.fn();
    const controller = createWorkspaceShellModalEffectsController({
      errorHandler: {
        recoverableError: () => null,
      },
      modal: {
        isOpen: type => type === 'login' ? loginOpen : false,
        getData: () => undefined,
        closeByType: vi.fn((type: 'login' | 'migration') => {
          if (type === 'login') loginOpen = false;
        }),
      },
      modalCoord: {
        loginReturnUrl: null,
        loginModalRef: null,
        openErrorRecoveryModal: vi.fn(),
        openLoginModal: vi.fn(() => {
          throw error;
        }),
        openMigrationModal: vi.fn(),
      },
      warn,
    });

    expect(() => controller.syncLoginRequest()).not.toThrow();

    expect(warn).toHaveBeenCalledWith('登录弹窗打开失败，已跳过本次展示', error);
  });
});
