import type { TabEditLock } from './tab-sync.service';

export interface TabSyncActiveTab {
  tabId: string;
  projectId: string;
  projectName: string;
  lastSeen: number;
}

export interface CountActiveProjectTabsInput {
  tabs: ReadonlyMap<string, TabSyncActiveTab>;
  ownTabId: string;
  projectId: string;
  now: number;
  timeoutMs: number;
}

export function countActiveProjectTabs(input: CountActiveProjectTabsInput): number {
  let count = 0;

  input.tabs.forEach((tab, tabId) => {
    if (
      tabId !== input.ownTabId
      && tab.projectId === input.projectId
      && input.now - tab.lastSeen <= input.timeoutMs
    ) {
      count += 1;
    }
  });

  return count;
}

export function findStaleTabIds(
  tabs: ReadonlyMap<string, TabSyncActiveTab>,
  now: number,
  timeoutMs: number,
): string[] {
  const staleTabIds: string[] = [];

  tabs.forEach((tab, tabId) => {
    if (now - tab.lastSeen > timeoutMs) {
      staleTabIds.push(tabId);
    }
  });

  return staleTabIds;
}

export function findStaleRemoteLockKeys(
  locks: ReadonlyMap<string, TabEditLock>,
  now: number,
): string[] {
  const staleLockKeys: string[] = [];

  locks.forEach((lock, key) => {
    if (lock.expiresAt <= now) {
      staleLockKeys.push(key);
    }
  });

  return staleLockKeys;
}

export function hasActiveRemoteEditLock(
  locks: ReadonlyMap<string, TabEditLock>,
  taskId: string,
  field: string | undefined,
  now: number,
): boolean {
  return filterActiveRemoteLocksForTask(locks, taskId, now, field).length > 0;
}

export function filterActiveRemoteLocksForTask(
  locks: ReadonlyMap<string, TabEditLock>,
  taskId: string,
  now: number,
  field?: string,
): TabEditLock[] {
  const activeLocks: TabEditLock[] = [];

  locks.forEach(lock => {
    if (
      lock.taskId === taskId
      && (!field || lock.field === field)
      && lock.expiresAt > now
    ) {
      activeLocks.push(lock);
    }
  });

  return activeLocks;
}
