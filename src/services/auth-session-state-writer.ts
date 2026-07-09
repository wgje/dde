import type { WritableSignal } from '@angular/core';
import type { AuthState } from './auth.service';

type RuntimeAuthState = 'idle' | 'pending' | 'ready' | 'failed';

interface SentryUser {
  id: string;
  email?: string;
}

export interface AuthSessionStateWriterContext {
  currentUserId: WritableSignal<string | null>;
  persistedOwnerHint: WritableSignal<string | null>;
  persistedSessionUserId: WritableSignal<string | null>;
  sessionEmail: WritableSignal<string | null>;
  sessionExpired: WritableSignal<boolean>;
  sessionInitialized: WritableSignal<boolean>;
  runtimeState: WritableSignal<RuntimeAuthState>;
  authState: WritableSignal<AuthState>;
  setSentryUser: (user: SentryUser | null) => void;
  clearCachedSessionArtifacts: () => void;
}

export interface ApplyAuthenticatedIdentityOptions {
  isCheckingSession?: boolean;
  syncSentryUser?: boolean;
}

export class AuthSessionStateWriter {
  constructor(private readonly context: AuthSessionStateWriterContext) {}

  applyAuthenticatedIdentity(
    userId: string,
    email: string | null,
    options: ApplyAuthenticatedIdentityOptions = {}
  ): void {
    this.context.currentUserId.set(userId);
    this.context.persistedOwnerHint.set(userId);
    this.context.persistedSessionUserId.set(userId);
    this.context.sessionEmail.set(email);
    this.context.authState.update(s => ({
      ...s,
      userId,
      email,
      error: null,
      ...(options.isCheckingSession !== undefined ? { isCheckingSession: options.isCheckingSession } : {}),
    }));

    if (options.syncSentryUser) {
      this.context.setSentryUser({ id: userId, email: email ?? undefined });
    }
  }

  clearInvalidatedSession(options: {
    keepLocalModeUser: boolean;
    localModeUserId: string;
  }): void {
    if (!options.keepLocalModeUser) {
      this.context.currentUserId.set(null);
    }
    this.context.persistedOwnerHint.set(null);
    this.context.persistedSessionUserId.set(null);
    this.context.sessionEmail.set(null);
    this.context.authState.update(state => ({
      ...state,
      userId: options.keepLocalModeUser ? options.localModeUserId : null,
      email: null,
      error: null,
      isCheckingSession: false,
    }));
    this.context.clearCachedSessionArtifacts();
    this.context.setSentryUser(null);
  }

  reset(options: { runtimeState: RuntimeAuthState }): void {
    this.context.currentUserId.set(null);
    this.context.persistedOwnerHint.set(null);
    this.context.persistedSessionUserId.set(null);
    this.context.sessionEmail.set(null);
    this.context.sessionExpired.set(false);
    this.context.sessionInitialized.set(false);
    this.context.runtimeState.set(options.runtimeState);
    this.context.authState.set({
      isCheckingSession: false,
      isLoading: false,
      userId: null,
      email: null,
      error: null,
    });
  }
}
