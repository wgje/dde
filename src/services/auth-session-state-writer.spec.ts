import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import type { AuthState } from './auth.service';
import { AuthSessionStateWriter } from './auth-session-state-writer';

describe('AuthSessionStateWriter', () => {
  it('applies authenticated identity to auth signals and sentry context', () => {
    const ctx = createContext();
    const writer = new AuthSessionStateWriter(ctx);

    writer.applyAuthenticatedIdentity('user-1', 'user@example.com', {
      isCheckingSession: false,
      syncSentryUser: true,
    });

    expect(ctx.currentUserId()).toBe('user-1');
    expect(ctx.persistedOwnerHint()).toBe('user-1');
    expect(ctx.persistedSessionUserId()).toBe('user-1');
    expect(ctx.sessionEmail()).toBe('user@example.com');
    expect(ctx.authState()).toMatchObject({
      userId: 'user-1',
      email: 'user@example.com',
      error: null,
      isCheckingSession: false,
    });
    expect(ctx.setSentryUser).toHaveBeenCalledWith({ id: 'user-1', email: 'user@example.com' });
  });

  it('clears local session while optionally preserving local mode user id', () => {
    const ctx = createContext();
    const writer = new AuthSessionStateWriter(ctx);
    ctx.currentUserId.set('local-user');

    writer.clearInvalidatedSession({ keepLocalModeUser: true, localModeUserId: 'local-user' });

    expect(ctx.currentUserId()).toBe('local-user');
    expect(ctx.authState()).toMatchObject({ userId: 'local-user', email: null, error: null });
    expect(ctx.persistedOwnerHint()).toBeNull();
    expect(ctx.persistedSessionUserId()).toBeNull();
    expect(ctx.sessionEmail()).toBeNull();
    expect(ctx.clearCachedSessionArtifacts).toHaveBeenCalled();
    expect(ctx.setSentryUser).toHaveBeenCalledWith(null);
  });

  it('resets runtime and session state for tests and HMR', () => {
    const ctx = createContext();
    const writer = new AuthSessionStateWriter(ctx);

    writer.reset({ runtimeState: 'ready' });

    expect(ctx.currentUserId()).toBeNull();
    expect(ctx.persistedOwnerHint()).toBeNull();
    expect(ctx.persistedSessionUserId()).toBeNull();
    expect(ctx.sessionEmail()).toBeNull();
    expect(ctx.sessionExpired()).toBe(false);
    expect(ctx.sessionInitialized()).toBe(false);
    expect(ctx.runtimeState()).toBe('ready');
    expect(ctx.authState()).toEqual({
      isCheckingSession: false,
      isLoading: false,
      userId: null,
      email: null,
      error: null,
    });
  });
});

function createContext() {
  const authState = signal<AuthState>({
    isCheckingSession: true,
    isLoading: true,
    userId: 'old-user',
    email: 'old@example.com',
    error: 'old error',
  });
  return {
    currentUserId: signal<string | null>('old-user'),
    persistedOwnerHint: signal<string | null>('old-user'),
    persistedSessionUserId: signal<string | null>('old-user'),
    sessionEmail: signal<string | null>('old@example.com'),
    sessionExpired: signal(true),
    sessionInitialized: signal(true),
    runtimeState: signal<'idle' | 'pending' | 'ready' | 'failed'>('pending'),
    authState,
    setSentryUser: vi.fn(),
    clearCachedSessionArtifacts: vi.fn(),
  };
}
