import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import type { AuthState } from './auth.service';
import { AuthCredentialFlowController } from './auth-credential-flow.controller';

describe('AuthCredentialFlowController', () => {
  it('sets loading state and applies credential identities on success', async () => {
    const ctx = createContext();
    const controller = new AuthCredentialFlowController(ctx);

    const result = await controller.run(async () => ({
      ok: true,
      value: { userId: 'user-1', email: 'user@example.com' },
    }));

    expect(result.ok).toBe(true);
    expect(ctx.applyCredentialIdentity).toHaveBeenCalledWith({ userId: 'user-1', email: 'user@example.com' });
    expect(ctx.authState()).toMatchObject({
      isLoading: false,
      error: null,
    });
  });

  it('stores operation errors without applying identity', async () => {
    const ctx = createContext();
    const controller = new AuthCredentialFlowController(ctx);

    const result = await controller.run(async () => ({
      ok: false,
      error: { code: 'UNKNOWN', message: 'bad credentials' },
    }));

    expect(result.ok).toBe(false);
    expect(ctx.authState()).toMatchObject({
      isLoading: false,
      error: 'bad credentials',
    });
    expect(ctx.applyCredentialIdentity).not.toHaveBeenCalled();
  });

  it('does not apply credential identity for successful flows without a user id', async () => {
    const ctx = createContext();
    const controller = new AuthCredentialFlowController(ctx);

    const result = await controller.run(async () => ({
      ok: true,
      value: { needsConfirmation: true },
    }));

    expect(result.ok).toBe(true);
    expect(ctx.applyCredentialIdentity).not.toHaveBeenCalled();
    expect(ctx.authState()).toMatchObject({
      isLoading: false,
      error: null,
    });
  });

  it('converts thrown errors into unknown failures', async () => {
    const ctx = createContext();
    const controller = new AuthCredentialFlowController(ctx);

    const result = await controller.run(async () => {
      throw new Error('raw failure');
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('raw failure');
    }
    expect(ctx.authState().isLoading).toBe(false);
  });
});

function createContext() {
  return {
    authState: signal<AuthState>({
      isCheckingSession: false,
      isLoading: false,
      userId: null,
      email: null,
      error: 'old',
    }),
    applyCredentialIdentity: vi.fn(),
  };
}
