import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceShellAuthModalFactoryOptions,
} from './workspace-shell-auth-modal.factory';
import {
  createWorkspaceShellInteractionAuthModalHostLoader,
  type WorkspaceShellInteractionAuthModalHostLike,
} from './workspace-shell-interaction-auth-modal-host-loader.factory';

function createAuthModal(): WorkspaceShellInteractionAuthModalHostLike {
  return {
    handleLocalModeFromModal: vi.fn().mockResolvedValue(undefined),
    handleLoginFromModal: vi.fn().mockResolvedValue(undefined),
    handleResetPasswordFromModal: vi.fn().mockResolvedValue(undefined),
    handleSignupFromModal: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn(),
  };
}

function createOptions(
  overrides: Partial<WorkspaceShellAuthModalFactoryOptions> = {},
): WorkspaceShellAuthModalFactoryOptions {
  return {
    authCoord: {} as never,
    currentUserId: () => 'user-1',
    modalCoord: {} as never,
    navigateByUrl: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  };
}

describe('createWorkspaceShellInteractionAuthModalHostLoader', () => {
  it('creates the default auth modal lazy-load delegate lazily', async () => {
    const authModal = createAuthModal();
    const createAuthModalHostDelegate = vi.fn().mockResolvedValue(authModal);
    const loadHost = createWorkspaceShellInteractionAuthModalHostLoader({
      options: createOptions({ createAuthModalHostDelegate }),
    });
    const data = { email: 'u@example.com', password: 'pw' };

    expect(createAuthModalHostDelegate).not.toHaveBeenCalled();

    const host = await loadHost();

    expect(createAuthModalHostDelegate).not.toHaveBeenCalled();

    await host.handleLoginFromModal(data);

    expect(createAuthModalHostDelegate).toHaveBeenCalledTimes(1);
    expect(authModal.handleLoginFromModal).toHaveBeenCalledWith(data);
  });
});
