import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellInteractionAuthModalHost,
  type WorkspaceShellInteractionAuthModalHostOptions,
} from './workspace-shell-interaction-auth-modal-host.factory';
import type {
  WorkspaceShellAuthModalFactoryDelegate,
} from './workspace-shell-auth-modal.factory';

function createAuthModal(): WorkspaceShellAuthModalFactoryDelegate {
  return {
    handleLocalModeFromModal: vi.fn().mockResolvedValue(undefined),
    handleLoginFromModal: vi.fn().mockResolvedValue(undefined),
    handleResetPasswordFromModal: vi.fn().mockResolvedValue(undefined),
    handleSignupFromModal: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn(),
  };
}

function createOptions(
  overrides: Partial<WorkspaceShellInteractionAuthModalHostOptions> = {},
): WorkspaceShellInteractionAuthModalHostOptions {
  return {
    authCoord: {} as never,
    currentUserId: () => 'user-1',
    modalCoord: {} as never,
    navigateByUrl: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  };
}

describe('createWorkspaceShellInteractionAuthModalHost', () => {
  it('uses the provided auth modal host lazily', async () => {
    const authModal = createAuthModal();
    const createAuthModalHostDelegate = vi.fn().mockResolvedValue(authModal);
    const host = createWorkspaceShellInteractionAuthModalHost(createOptions({
      createAuthModalHostDelegate,
    }));
    const data = { email: 'u@example.com', password: 'pw' };

    expect(createAuthModalHostDelegate).not.toHaveBeenCalled();

    await host.handleLoginFromModal(data);

    expect(createAuthModalHostDelegate).toHaveBeenCalledTimes(1);
    expect(authModal.handleLoginFromModal).toHaveBeenCalledWith(data);
  });

  it('preserves the auth modal host failure warn boundary', async () => {
    const error = new Error('auth host chunk failed');
    const warn = vi.fn();
    const host = createWorkspaceShellInteractionAuthModalHost(createOptions({
      createAuthModalHostDelegate: vi.fn().mockRejectedValue(error),
      warn,
    }));

    await host.handleLocalModeFromModal();

    expect(warn).toHaveBeenCalledWith(
      '认证模态框 lazy-load host 加载失败，认证表单暂不可用',
      error,
    );
  });

  it('keeps the concrete auth modal delegate factory behind a dynamic import', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-interaction-auth-modal-host.factory.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellInteractionAuthModalHostLoader');
    expect(source).not.toContain("import('./workspace-shell-auth-modal-lazy-load-delegate.factory')");
    expect(source).not.toContain('createWorkspaceShellAuthModalLazyLoadDelegate');
  });
});
