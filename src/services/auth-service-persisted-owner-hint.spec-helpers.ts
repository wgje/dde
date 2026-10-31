import { describe, expect, it } from 'vitest';

import type { AuthService } from './auth.service';

interface AuthPersistedOwnerHintSpecContext {
  recreateService: () => AuthService;
  service: () => AuthService;
}

export function registerAuthServicePersistedOwnerHintSpecs(
  context: AuthPersistedOwnerHintSpecContext,
): void {
  describe('persisted owner hint', () => {
    it('access token 即将过期时仍应返回 owner hint，但不应命中 fast-path identity', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      localStorage.setItem('sb-test-auth-token', JSON.stringify({
        access_token: 'expired-soon-token',
        refresh_token: 'refresh-token',
        expires_at: nowSec + 30,
        user: {
          id: 'user-1',
          email: 'user-1@example.com',
        },
      }));

      expect(context.service().peekPersistedSessionIdentity()).toBeNull();
      expect(context.service().peekPersistedOwnerHint()).toBe('user-1');
    });

    it('应兼容 currentSession 包裹的持久化 auth 结构', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      localStorage.setItem('sb-test-auth-token', JSON.stringify({
        currentSession: {
          access_token: 'expired-soon-token',
          refresh_token: 'refresh-token',
          expires_at: nowSec + 30,
          user: {
            id: 'wrapped-user',
            email: 'wrapped@example.com',
          },
        },
      }));

      expect(context.service().peekPersistedOwnerHint()).toBe('wrapped-user');
    });

    it('fresh currentSession 结构应命中 confirmed session fast-path', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      localStorage.setItem('sb-test-auth-token', JSON.stringify({
        currentSession: {
          access_token: 'fresh-token',
          refresh_token: 'refresh-token',
          expires_at: nowSec + 3600,
          user: {
            id: 'fresh-wrapped-user',
            email: 'fresh@example.com',
          },
        },
      }));

      expect(context.service().peekPersistedSessionIdentity()).toEqual({
        userId: 'fresh-wrapped-user',
        email: 'fresh@example.com',
      });
    });

    it('signOut 应立即清空 persisted owner hint signal', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      localStorage.setItem('sb-test-auth-token', JSON.stringify({
        access_token: 'fresh-token',
        refresh_token: 'refresh-token',
        expires_at: nowSec + 3600,
        user: {
          id: 'signal-user',
          email: 'signal@example.com',
        },
      }));
      context.service().reset();
      const service = context.recreateService();

      expect(service.persistedOwnerHint()).toBe('signal-user');

      await service.signOut();

      expect(service.persistedOwnerHint()).toBeNull();
    });
  });
}
