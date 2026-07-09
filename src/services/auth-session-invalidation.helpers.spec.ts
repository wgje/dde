import { describe, expect, it } from 'vitest';

import { resolveInvalidatedOwnerUserId } from './auth-session-invalidation.helpers';

describe('auth-session-invalidation.helpers', () => {
  it('uses the first non-local owner candidate', () => {
    expect(resolveInvalidatedOwnerUserId({
      localModeUserId: 'local-user',
      currentUserId: 'user-current',
      persistedSessionUserId: 'user-session',
      persistedOwnerHint: 'user-owner',
    })).toBe('user-current');

    expect(resolveInvalidatedOwnerUserId({
      localModeUserId: 'local-user',
      currentUserId: null,
      persistedSessionUserId: 'user-session',
      persistedOwnerHint: 'user-owner',
    })).toBe('user-session');

    expect(resolveInvalidatedOwnerUserId({
      localModeUserId: 'local-user',
      currentUserId: 'local-user',
      persistedSessionUserId: 'user-session',
      persistedOwnerHint: 'user-owner',
    })).toBeNull();
  });

  it('ignores local-user placeholders from persisted hints', () => {
    expect(resolveInvalidatedOwnerUserId({
      localModeUserId: 'local-user',
      currentUserId: null,
      persistedSessionUserId: 'local-user',
      persistedOwnerHint: 'user-owner',
    })).toBe('user-owner');

    expect(resolveInvalidatedOwnerUserId({
      localModeUserId: 'local-user',
      currentUserId: null,
      persistedSessionUserId: 'local-user',
      persistedOwnerHint: 'local-user',
    })).toBeNull();
  });
});
