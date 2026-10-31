import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthService } from './auth.service';
import {
  AUTHORITY_KEY,
  installCanonicalAuthority,
} from './auth-service-signed-out-pending-bridge.spec-helpers';
import type { SignupSession } from './supabase-client.service.spec-helpers';

export function passwordResponse(accessToken: string): Response {
  return new Response(JSON.stringify({ access_token: accessToken }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function confirmationResponse(userId: string, email: string): Response {
  return new Response(JSON.stringify({ user: { id: userId, email } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function createSignupSession(
  owner: string,
  accessToken = `signup-token-${owner}`,
): SignupSession {
  return {
    access_token: accessToken,
    refresh_token: `signup-refresh-${owner}`,
    expires_in: 3600,
    user: { id: owner, email: `${owner}@example.com` },
  };
}

interface AuthServiceBackgroundSessionRefreshAuthoritySpecContext {
  service: AuthService;
  mockSupabaseClient: {
    getSession: ReturnType<typeof vi.fn>;
  };
  mockEventBus: {
    publishSessionInvalidated: ReturnType<typeof vi.fn>;
    publishSessionRestored: ReturnType<typeof vi.fn>;
  };
  ensureRuntimeAuthReady: () => Promise<void>;
  dispatchAuthStateChange: (event: string, session: unknown) => void;
  createPersistedSessionPayload: (
    userId: string,
    email: string | null,
    wrapped?: boolean,
    accessToken?: string,
  ) => string;
}

type CanonicalBundle = {
  session: string | null;
  codeVerifier: string | null;
  user: string | null;
};

export function registerAuthServiceBackgroundSessionRefreshAuthoritySpecs(
  getContext: () => AuthServiceBackgroundSessionRefreshAuthoritySpecContext,
): void {
  let context: AuthServiceBackgroundSessionRefreshAuthoritySpecContext;
  let restoreIdleCallback: (() => void) | null = null;

  beforeEach(() => {
    context = getContext();
    installCanonicalAuthority();
  });

  afterEach(() => {
    restoreIdleCallback?.();
    restoreIdleCallback = null;
    delete (globalThis as Record<string, unknown>)[AUTHORITY_KEY];
  });

  describe('background session refresh canonical authority', () => {
    it.each([
      ['different owner', 'user-b', 'b@example.com', 'token-b'],
      ['same owner newer token', 'user-a', 'a@example.com', 'token-a-new'],
    ] as const)('keeps canonical replacement inert: %s', async (
      _label,
      nextUserId,
      nextEmail,
      nextToken,
    ) => {
      const idle = captureIdleCallback();
      restoreIdleCallback = idle.restore;
      const session = createDeferred<{
        data: { session: { user: { id: string; email: string } } };
        error: null;
      }>();
      context.mockSupabaseClient.getSession.mockImplementation(() => session.promise);
      seedCanonical(context, 'user-a', 'a@example.com', 'token-a');

      await context.service.checkSession();
      const identityAfterFastPath = context.service.captureAuthIdentityFence();
      const replacement = seedCanonical(context, nextUserId, nextEmail, nextToken);
      idle.run();
      await flushMicrotasks();
      session.resolve({ data: { session: { user: { id: nextUserId, email: nextEmail } } }, error: null });
      await flushMicrotasks();

      expect(canonicalEquals(replacement)).toBe(true);
      expect(context.service.captureAuthIdentityFence()).toBe(identityAfterFastPath);
      expect(context.service.currentUserId()).toBe('user-a');
      expect(context.mockEventBus.publishSessionInvalidated).not.toHaveBeenCalled();
      expect(context.mockEventBus.publishSessionRestored).not.toHaveBeenCalled();
    });

    it('invalidates an exact-current empty session before clearing auth signals', async () => {
      const idle = captureIdleCallback();
      restoreIdleCallback = idle.restore;
      context.mockSupabaseClient.getSession.mockResolvedValue({
        data: { session: null },
        error: null,
      });
      seedCanonical(context, 'user-a', 'a@example.com', 'token-a');
      let userIdDuringInvalidation: string | null | undefined;
      context.mockEventBus.publishSessionInvalidated.mockImplementation(() => {
        userIdDuringInvalidation = context.service.currentUserId();
      });

      await context.service.checkSession();
      idle.run();
      await flushMicrotasks();

      expect(context.mockEventBus.publishSessionInvalidated)
        .toHaveBeenCalledWith('AuthService.backgroundRefresh', 'user-a');
      expect(userIdDuringInvalidation).toBe('user-a');
      expect(context.service.currentUserId()).toBeNull();
      expect(canonicalEquals(emptyCanonicalBundle())).toBe(true);
    });

    it('allows a same-tab login after exact background invalidation', async () => {
      const idle = captureIdleCallback();
      restoreIdleCallback = idle.restore;
      context.mockSupabaseClient.getSession.mockResolvedValue({ data: { session: null }, error: null });
      await context.ensureRuntimeAuthReady();
      seedCanonical(context, 'user-a', 'a@example.com', 'token-a');

      await context.service.checkSession();
      idle.run();
      await flushMicrotasks();
      context.mockEventBus.publishSessionRestored.mockClear();
      context.dispatchAuthStateChange('SIGNED_IN', {
        access_token: 'token-a-new',
        user: { id: 'user-a', email: 'a@example.com' },
      });

      expect(context.mockEventBus.publishSessionRestored)
        .toHaveBeenCalledWith('user-a', 'AuthService');
    });
  });
}

function captureIdleCallback() {
  const owner = window as Window & { requestIdleCallback?: (callback: () => void) => number };
  const original = owner.requestIdleCallback;
  let callback: (() => void) | null = null;
  Object.defineProperty(owner, 'requestIdleCallback', {
    configurable: true,
    value: vi.fn((next: () => void) => { callback = next; return 41; }),
  });
  return {
    run: () => {
      if (!callback) throw new Error('background refresh was not scheduled');
      callback();
    },
    restore: () => {
      if (original) owner.requestIdleCallback = original;
      else Reflect.deleteProperty(owner, 'requestIdleCallback');
    },
  };
}

function seedCanonical(
  context: AuthServiceBackgroundSessionRefreshAuthoritySpecContext,
  userId: string,
  email: string,
  accessToken: string,
): CanonicalBundle {
  const bundle = {
    session: context.createPersistedSessionPayload(userId, email, false, accessToken),
    codeVerifier: `verifier-${accessToken}`,
    user: JSON.stringify({ id: userId, email }),
  };
  localStorage.setItem('sb-test-auth-token', bundle.session);
  localStorage.setItem('sb-test-auth-token-code-verifier', bundle.codeVerifier);
  localStorage.setItem('sb-test-auth-token-user', bundle.user);
  return bundle;
}

function canonicalEquals(expected: CanonicalBundle): boolean {
  return localStorage.getItem('sb-test-auth-token') === expected.session
    && localStorage.getItem('sb-test-auth-token-code-verifier') === expected.codeVerifier
    && localStorage.getItem('sb-test-auth-token-user') === expected.user;
}

function emptyCanonicalBundle(): CanonicalBundle {
  return { session: null, codeVerifier: null, user: null };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
