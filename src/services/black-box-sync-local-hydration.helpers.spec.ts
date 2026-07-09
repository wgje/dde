import { describe, expect, it } from 'vitest';

import { AUTH_CONFIG } from '../config/auth.config';
import { type BlackBoxEntry } from '../models/focus';
import {
  resolveBlackBoxLocalHydration,
  resolveBlackBoxLocalVisibleUserId,
} from './black-box-sync-local-hydration.helpers';

function createEntry(overrides: Partial<BlackBoxEntry> = {}): BlackBoxEntry {
  return {
    id: 'entry-1',
    projectId: null,
    userId: 'user-1',
    content: 'content',
    date: '2026-03-04',
    createdAt: '2026-03-04T00:00:00.000Z',
    updatedAt: '2026-03-04T00:00:00.000Z',
    isRead: false,
    isCompleted: false,
    isArchived: false,
    deletedAt: null,
    ...overrides,
  };
}

const defaultChecks = {
  isEntryNewer: (
    candidate: Pick<BlackBoxEntry, 'updatedAt'> | null | undefined,
    baseline: Pick<BlackBoxEntry, 'updatedAt'> | null | undefined,
  ) => {
    if (!candidate?.updatedAt || !baseline?.updatedAt) return false;
    return new Date(candidate.updatedAt).getTime() > new Date(baseline.updatedAt).getTime();
  },
  hasEquivalentEntryState: (local: BlackBoxEntry, remote: BlackBoxEntry) => {
    return local.id === remote.id
      && local.userId === remote.userId
      && local.content === remote.content
      && local.isRead === remote.isRead
      && local.isCompleted === remote.isCompleted
      && local.isArchived === remote.isArchived;
  },
  hasSameInstant: (left: string | null | undefined, right: string | null | undefined) => {
    return (left ?? null) === (right ?? null);
  },
};

describe('black-box-sync-local-hydration.helpers', () => {
  it('resolves visible user identity with persisted cloud identity before local mode fallback', () => {
    expect(resolveBlackBoxLocalVisibleUserId({
      authConfigured: true,
      authSettling: false,
      currentUserId: 'user-1',
      isBrowser: true,
      localModeCacheKey: 'true',
      persistedOwnerHint: null,
      persistedSessionUserId: null,
    })).toBe('user-1');

    expect(resolveBlackBoxLocalVisibleUserId({
      authConfigured: false,
      authSettling: false,
      currentUserId: null,
      isBrowser: true,
      localModeCacheKey: null,
      persistedOwnerHint: null,
      persistedSessionUserId: null,
    })).toBe(AUTH_CONFIG.LOCAL_MODE_USER_ID);

    expect(resolveBlackBoxLocalVisibleUserId({
      authConfigured: true,
      authSettling: true,
      currentUserId: null,
      isBrowser: true,
      localModeCacheKey: 'true',
      persistedOwnerHint: 'owner-hint-user',
      persistedSessionUserId: 'persisted-cloud-user',
    })).toBe('persisted-cloud-user');
  });

  it('returns the expected-user memory snapshot when current user confirmation is required', () => {
    const ownEntry = createEntry({ id: 'own', userId: 'user-1' });
    const foreignEntry = createEntry({ id: 'foreign', userId: 'user-2' });

    const result = resolveBlackBoxLocalHydration({
      entries: [ownEntry],
      options: { expectedUserId: 'user-1', requireCurrentUser: true },
      visibleUserId: 'user-1',
      currentUserId: null,
      sessionInitialized: false,
      authSettling: true,
      localModeCacheKey: null,
      inMemoryEntries: [ownEntry, foreignEntry],
      ...defaultChecks,
    });

    expect(result.commitToStore).toBe(false);
    expect(result.entries).toEqual([ownEntry]);
    expect(result.events[0]).toMatchObject({
      level: 'info',
      message: '黑匣子本地水合跳过：当前用户已变化或尚未确认',
    });
  });

  it('normalizes local-mode pending entries and returns a hydration repair', () => {
    const localPending = createEntry({
      id: 'local-pending',
      userId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
      syncStatus: 'pending',
    });

    const result = resolveBlackBoxLocalHydration({
      entries: [localPending],
      options: {},
      visibleUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
      currentUserId: null,
      sessionInitialized: true,
      authSettling: false,
      localModeCacheKey: 'true',
      inMemoryEntries: [],
      ...defaultChecks,
    });

    expect(result.commitToStore).toBe(true);
    expect(result.entries[0]?.syncStatus).toBe('synced');
    expect(result.hydrationRepairs).toEqual([expect.objectContaining({
      id: 'local-pending',
      syncStatus: 'synced',
    })]);
  });

  it('preserves memory when all IDB entries belong to another visible user', () => {
    const foreignIdbEntry = createEntry({ id: 'foreign', userId: 'user-2' });
    const inMemoryEntry = createEntry({ id: 'own', userId: 'user-1' });

    const result = resolveBlackBoxLocalHydration({
      entries: [foreignIdbEntry],
      options: {},
      visibleUserId: 'user-1',
      currentUserId: 'user-1',
      sessionInitialized: true,
      authSettling: false,
      localModeCacheKey: null,
      inMemoryEntries: [inMemoryEntry],
      ...defaultChecks,
    });

    expect(result.commitToStore).toBe(false);
    expect(result.entries).toEqual([inMemoryEntry]);
    expect(result.events[0]).toMatchObject({
      level: 'warn',
      message: '黑匣子 IDB 现存条目被当前 visibleUserId 全量滤除，保留内存快照以免误清',
    });
  });

  it('keeps converged in-memory entries when hydrated IDB still says pending', () => {
    const hydratedPending = createEntry({ id: 'entry-1', syncStatus: 'pending' });
    const inMemorySynced = createEntry({ id: 'entry-1', syncStatus: 'synced' });

    const result = resolveBlackBoxLocalHydration({
      entries: [hydratedPending],
      options: {},
      visibleUserId: 'user-1',
      currentUserId: 'user-1',
      sessionInitialized: true,
      authSettling: false,
      localModeCacheKey: null,
      inMemoryEntries: [inMemorySynced],
      ...defaultChecks,
    });

    expect(result.commitToStore).toBe(true);
    expect(result.entries).toEqual([inMemorySynced]);
    expect(result.hydrationRepairs).toEqual([inMemorySynced]);
  });
});
