import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceShellAuthModalControllerLike,
  WorkspaceShellAuthModalLazyLoadControllerOptions,
} from './workspace-shell-auth-modal-lazy-load.controller';
import {
  createWorkspaceShellAuthModalControllerLoader,
} from './workspace-shell-auth-modal-controller-loader.factory';

function createAuthModalControllerLike(): WorkspaceShellAuthModalControllerLike {
  return {
    handleLocalModeFromModal: vi.fn().mockResolvedValue(undefined),
    handleLoginFromModal: vi.fn().mockResolvedValue(undefined),
    handleResetPasswordFromModal: vi.fn().mockResolvedValue(undefined),
    handleSignupFromModal: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn(),
  };
}

function createOptions(
  overrides: Partial<WorkspaceShellAuthModalLazyLoadControllerOptions> = {},
): WorkspaceShellAuthModalLazyLoadControllerOptions {
  return {
    authCoord: {
      authError: () => null,
      resetPasswordSent: () => false,
      resolveSafePostAuthNavigationUrl: () => null,
      handleLoginFromModal: vi.fn().mockResolvedValue(undefined),
      handleSignupFromModal: vi.fn().mockResolvedValue(undefined),
      handleResetPasswordFromModal: vi.fn().mockResolvedValue(undefined),
      handleLocalModeFromModal: vi.fn().mockResolvedValue(undefined),
    },
    modalCoord: {
      loginReturnUrl: null,
      closeLoginModal: vi.fn(),
    },
    currentUserId: () => null,
    navigateByUrl: vi.fn().mockResolvedValue(true),
    warn: vi.fn(),
    ...overrides,
  };
}

describe('createWorkspaceShellAuthModalControllerLoader', () => {
  it('uses the provided auth modal controller loader', async () => {
    const authModal = createAuthModalControllerLike();
    const createAuthModalController = vi.fn().mockResolvedValue(authModal);
    const loadController = createWorkspaceShellAuthModalControllerLoader(createOptions({
      createAuthModalController,
    }));

    await expect(loadController()).resolves.toBe(authModal);

    expect(createAuthModalController).toHaveBeenCalledOnce();
  });
});
