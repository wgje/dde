import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceShellAuthModalLazyLoadDelegate,
  WorkspaceShellAuthModalLazyLoadDelegateOptions,
} from './workspace-shell-auth-modal-lazy-load-delegate.factory';
import {
  createWorkspaceShellAuthModalLazyLoadDelegateLoader,
} from './workspace-shell-auth-modal-lazy-load-delegate-loader.factory';

function createAuthModalDelegate(): WorkspaceShellAuthModalLazyLoadDelegate {
  return {
    handleLocalModeFromModal: vi.fn().mockResolvedValue(undefined),
    handleLoginFromModal: vi.fn().mockResolvedValue(undefined),
    handleResetPasswordFromModal: vi.fn().mockResolvedValue(undefined),
    handleSignupFromModal: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn(),
  };
}

function createOptions(
  overrides: Partial<WorkspaceShellAuthModalLazyLoadDelegateOptions> = {},
): WorkspaceShellAuthModalLazyLoadDelegateOptions {
  return {
    authCoord: {
      authError: vi.fn(() => null),
      resetPasswordSent: vi.fn(() => false),
      resolveSafePostAuthNavigationUrl: vi.fn((returnUrl: string | null) => returnUrl),
      handleLoginFromModal: vi.fn(async () => true),
      handleSignupFromModal: vi.fn(async () => true),
      handleResetPasswordFromModal: vi.fn(async () => undefined),
      handleLocalModeFromModal: vi.fn(async () => undefined),
    },
    modalCoord: {
      loginReturnUrl: null,
      closeLoginModal: vi.fn(),
    },
    currentUserId: vi.fn(() => 'user-1'),
    navigateByUrl: vi.fn(async () => undefined),
    warn: vi.fn(),
    ...overrides,
  };
}

describe('createWorkspaceShellAuthModalLazyLoadDelegateLoader', () => {
  it('uses the provided auth modal host delegate loader', async () => {
    const authModal = createAuthModalDelegate();
    const createAuthModalHostDelegate = vi.fn().mockResolvedValue(authModal);
    const loadDelegate = createWorkspaceShellAuthModalLazyLoadDelegateLoader(createOptions({
      createAuthModalHostDelegate,
    }));

    await expect(loadDelegate()).resolves.toBe(authModal);

    expect(createAuthModalHostDelegate).toHaveBeenCalledOnce();
  });
});
