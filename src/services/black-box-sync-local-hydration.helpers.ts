import { AUTH_CONFIG } from '../config/auth.config';
import { type BlackBoxEntry } from '../models/focus';
import { type LoadBlackBoxLocalOptions } from './black-box-sync.types';

export type BlackBoxLocalHydrationLogLevel = 'debug' | 'info' | 'warn';

export interface BlackBoxLocalHydrationLogEvent {
  level: BlackBoxLocalHydrationLogLevel;
  message: string;
  context: Record<string, unknown>;
}

export interface BlackBoxLocalHydrationResult {
  entries: BlackBoxEntry[];
  hydrationRepairs: BlackBoxEntry[];
  commitToStore: boolean;
  events: BlackBoxLocalHydrationLogEvent[];
}

export interface BlackBoxLocalVisibleUserInput {
  authConfigured: boolean;
  authSettling: boolean;
  currentUserId: string | null;
  isBrowser: boolean;
  localModeCacheKey: string | null;
  persistedOwnerHint: string | null;
  persistedSessionUserId: string | null;
}

export interface BlackBoxLocalHydrationInput {
  entries: BlackBoxEntry[];
  options: LoadBlackBoxLocalOptions;
  visibleUserId: string | null;
  currentUserId: string | null;
  sessionInitialized: boolean;
  authSettling: boolean;
  localModeCacheKey: string | null;
  inMemoryEntries: BlackBoxEntry[];
  isEntryNewer: (
    candidate: Pick<BlackBoxEntry, 'updatedAt'> | null | undefined,
    baseline: Pick<BlackBoxEntry, 'updatedAt'> | null | undefined,
  ) => boolean;
  hasEquivalentEntryState: (local: BlackBoxEntry, remote: BlackBoxEntry) => boolean;
  hasSameInstant: (left: string | null | undefined, right: string | null | undefined) => boolean;
}

export function resolveBlackBoxLocalVisibleUserId(input: BlackBoxLocalVisibleUserInput): string | null {
  if (input.currentUserId) {
    return input.currentUserId;
  }

  if (!input.authConfigured) {
    return AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  if (!input.isBrowser) {
    return null;
  }

  if (input.authSettling) {
    if (input.persistedSessionUserId) {
      return input.persistedSessionUserId;
    }

    if (input.persistedOwnerHint) {
      return input.persistedOwnerHint;
    }
  }

  return input.localModeCacheKey === 'true'
    ? AUTH_CONFIG.LOCAL_MODE_USER_ID
    : null;
}

export function normalizeBlackBoxLocalOnlySyncStatus(
  entry: BlackBoxEntry,
  visibleUserId: string,
): BlackBoxEntry {
  if (visibleUserId !== AUTH_CONFIG.LOCAL_MODE_USER_ID || entry.syncStatus !== 'pending') {
    return entry;
  }

  return {
    ...entry,
    syncStatus: 'synced',
  };
}

export function shouldKeepBlackBoxInMemoryEntryDuringHydration(
  hydrated: BlackBoxEntry,
  inMemory: BlackBoxEntry | undefined,
  checks: {
    isEntryNewer: BlackBoxLocalHydrationInput['isEntryNewer'];
    hasEquivalentEntryState: BlackBoxLocalHydrationInput['hasEquivalentEntryState'];
    hasSameInstant: BlackBoxLocalHydrationInput['hasSameInstant'];
  },
): inMemory is BlackBoxEntry {
  if (!inMemory) {
    return false;
  }

  if (hydrated.syncStatus !== 'pending' || inMemory.syncStatus === 'pending') {
    return false;
  }

  if (hydrated.userId !== inMemory.userId) {
    return false;
  }

  if (checks.hasEquivalentEntryState(hydrated, inMemory)) {
    return true;
  }

  if (checks.hasSameInstant(hydrated.updatedAt, inMemory.updatedAt)) {
    return true;
  }

  return !checks.isEntryNewer(hydrated, inMemory);
}

export function resolveBlackBoxLocalHydration(input: BlackBoxLocalHydrationInput): BlackBoxLocalHydrationResult {
  const events: BlackBoxLocalHydrationLogEvent[] = [];
  const inMemoryMap = new Map(input.inMemoryEntries.map(entry => [entry.id, entry]));

  if (!canCommitForExpectedUser(input, events)) {
    const entries = resolveExpectedUserMemorySnapshot(input.inMemoryEntries, input.options);
    return skipBlackBoxLocalHydration(entries, events);
  }

  if (!input.visibleUserId) {
    return deferBlackBoxLocalHydrationForPendingOwner(input, events);
  }

  const hydrationRepairs = new Map<string, BlackBoxEntry>();
  const visibleEntries = resolveVisibleHydratedEntries(input, input.visibleUserId, inMemoryMap, hydrationRepairs);
  if (shouldPreserveMemoryForFullyFilteredIdbEntries(input.entries, visibleEntries)) {
    return preserveBlackBoxMemoryForFilteredIdbEntries(input, events);
  }

  const inMemoryVisibleEntries = input.inMemoryEntries.filter(entry => entry.userId === input.visibleUserId);
  if (visibleEntries.length === 0 && inMemoryVisibleEntries.length > 0) {
    return preserveBlackBoxMemoryForOptimisticEntries(input.visibleUserId, inMemoryVisibleEntries, events);
  }

  return {
    entries: visibleEntries,
    hydrationRepairs: Array.from(hydrationRepairs.values()),
    commitToStore: true,
    events,
  };
}

function skipBlackBoxLocalHydration(
  entries: BlackBoxEntry[],
  events: BlackBoxLocalHydrationLogEvent[],
): BlackBoxLocalHydrationResult {
  return {
    entries,
    hydrationRepairs: [],
    commitToStore: false,
    events,
  };
}

function deferBlackBoxLocalHydrationForPendingOwner(
  input: BlackBoxLocalHydrationInput,
  events: BlackBoxLocalHydrationLogEvent[],
): BlackBoxLocalHydrationResult {
  events.push({
    level: 'info',
    message: '黑匣子本地水合延后：owner 未决，保留当前内存快照',
    context: {
      authSettling: input.authSettling,
      sessionInitialized: input.sessionInitialized,
      currentUserId: input.currentUserId,
      inMemoryEntryCount: input.inMemoryEntries.length,
    },
  });
  return skipBlackBoxLocalHydration(input.inMemoryEntries, events);
}

function preserveBlackBoxMemoryForFilteredIdbEntries(
  input: BlackBoxLocalHydrationInput,
  events: BlackBoxLocalHydrationLogEvent[],
): BlackBoxLocalHydrationResult {
  events.push({
    level: 'warn',
    message: '黑匣子 IDB 现存条目被当前 visibleUserId 全量滤除，保留内存快照以免误清',
    context: {
      visibleUserId: input.visibleUserId,
      idbEntryCount: input.entries.length,
      inMemoryEntryCount: input.inMemoryEntries.length,
      firstIdbEntryUserId: input.entries[0]?.userId,
      currentUserId: input.currentUserId,
      localModeCacheKey: input.localModeCacheKey,
    },
  });
  return skipBlackBoxLocalHydration(input.inMemoryEntries, events);
}

function preserveBlackBoxMemoryForOptimisticEntries(
  visibleUserId: string,
  inMemoryVisibleEntries: BlackBoxEntry[],
  events: BlackBoxLocalHydrationLogEvent[],
): BlackBoxLocalHydrationResult {
  events.push({
    level: 'info',
    message: '黑匣子本地水合遇到空 IDB，保留当前用户内存快照以避免覆盖乐观写入',
    context: {
      visibleUserId,
      inMemoryEntryCount: inMemoryVisibleEntries.length,
    },
  });
  return skipBlackBoxLocalHydration(inMemoryVisibleEntries, events);
}

function canCommitForExpectedUser(
  input: BlackBoxLocalHydrationInput,
  events: BlackBoxLocalHydrationLogEvent[],
): boolean {
  if (!input.options.expectedUserId) {
    return true;
  }

  if (input.visibleUserId !== input.options.expectedUserId) {
    events.push({
      level: 'info',
      message: '黑匣子本地水合跳过：可见用户与期望用户不一致',
      context: {
        expectedUserId: input.options.expectedUserId,
        visibleUserId: input.visibleUserId,
      },
    });
    return false;
  }

  if (input.options.requireCurrentUser && input.currentUserId !== input.options.expectedUserId) {
    events.push({
      level: 'info',
      message: '黑匣子本地水合跳过：当前用户已变化或尚未确认',
      context: {
        expectedUserId: input.options.expectedUserId,
        currentUserId: input.currentUserId,
      },
    });
    return false;
  }

  return true;
}

function resolveExpectedUserMemorySnapshot(
  inMemoryEntries: BlackBoxEntry[],
  options: LoadBlackBoxLocalOptions,
): BlackBoxEntry[] {
  if (!options.expectedUserId) {
    return inMemoryEntries;
  }

  return inMemoryEntries.filter(entry => entry.userId === options.expectedUserId);
}

function resolveVisibleHydratedEntries(
  input: BlackBoxLocalHydrationInput,
  visibleUserId: string,
  inMemoryMap: Map<string, BlackBoxEntry>,
  hydrationRepairs: Map<string, BlackBoxEntry>,
): BlackBoxEntry[] {
  const visibleEntries: BlackBoxEntry[] = [];

  for (const entry of input.entries) {
    if (entry.userId !== visibleUserId) {
      continue;
    }

    visibleEntries.push(resolveHydratedVisibleEntry(input, entry, visibleUserId, inMemoryMap, hydrationRepairs));
  }

  return visibleEntries;
}

function resolveHydratedVisibleEntry(
  input: BlackBoxLocalHydrationInput,
  entry: BlackBoxEntry,
  visibleUserId: string,
  inMemoryMap: Map<string, BlackBoxEntry>,
  hydrationRepairs: Map<string, BlackBoxEntry>,
): BlackBoxEntry {
  const normalized = normalizeBlackBoxLocalOnlySyncStatus(entry, visibleUserId);
  const inMemory = inMemoryMap.get(normalized.id);

  if (shouldKeepBlackBoxInMemoryEntryDuringHydration(normalized, inMemory, input)) {
    hydrationRepairs.set(inMemory.id, inMemory);
    return inMemory;
  }

  if (normalized !== entry) {
    hydrationRepairs.set(normalized.id, normalized);
  }

  return normalized;
}

function shouldPreserveMemoryForFullyFilteredIdbEntries(
  entries: BlackBoxEntry[],
  visibleEntries: BlackBoxEntry[],
): boolean {
  return entries.length > 0 && visibleEntries.length === 0;
}
