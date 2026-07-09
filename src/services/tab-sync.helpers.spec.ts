import { describe, expect, it } from 'vitest';

import type { TabEditLock } from './tab-sync.service';
import {
  countActiveProjectTabs,
  findStaleTabIds,
  findStaleRemoteLockKeys,
  filterActiveRemoteLocksForTask,
  hasActiveRemoteEditLock,
  type TabSyncActiveTab,
} from './tab-sync.helpers';

const now = Date.parse('2026-01-01T00:00:00.000Z');
const timeoutMs = 1000;

function createTab(overrides: Partial<TabSyncActiveTab>): TabSyncActiveTab {
  return {
    tabId: 'tab-a',
    projectId: 'project-a',
    projectName: 'Project A',
    lastSeen: now,
    ...overrides,
  };
}

function createLock(overrides: Partial<TabEditLock>): TabEditLock {
  return {
    taskId: 'task-a',
    tabId: 'tab-a',
    field: 'content',
    lockedAt: now - 100,
    expiresAt: now + 100,
    ...overrides,
  };
}

describe('tab sync helpers', () => {
  it('counts active tabs for the same project while excluding the current tab and stale tabs', () => {
    const tabs = new Map([
      ['own-tab', createTab({ tabId: 'own-tab', projectId: 'project-a' })],
      ['fresh-tab', createTab({ tabId: 'fresh-tab', projectId: 'project-a', lastSeen: now - 500 })],
      ['other-project', createTab({ tabId: 'other-project', projectId: 'project-b', lastSeen: now - 500 })],
      ['stale-tab', createTab({ tabId: 'stale-tab', projectId: 'project-a', lastSeen: now - 1001 })],
    ]);

    expect(countActiveProjectTabs({
      tabs,
      ownTabId: 'own-tab',
      projectId: 'project-a',
      now,
      timeoutMs,
    })).toBe(1);
  });

  it('finds stale active tabs and expired remote locks', () => {
    const tabs = new Map([
      ['fresh-tab', createTab({ tabId: 'fresh-tab', lastSeen: now - 1000 })],
      ['stale-tab', createTab({ tabId: 'stale-tab', lastSeen: now - 1001 })],
    ]);
    const locks = new Map([
      ['fresh-lock', createLock({ expiresAt: now + 1 })],
      ['expired-lock', createLock({ expiresAt: now })],
    ]);

    expect(findStaleTabIds(tabs, now, timeoutMs)).toEqual(['stale-tab']);
    expect(findStaleRemoteLockKeys(locks, now)).toEqual(['expired-lock']);
  });

  it('filters active remote locks by task and optional field', () => {
    const locks = new Map([
      ['content', createLock({ taskId: 'task-a', field: 'content', expiresAt: now + 100 })],
      ['title', createLock({ taskId: 'task-a', field: 'title', expiresAt: now + 100 })],
      ['other-task', createLock({ taskId: 'task-b', field: 'content', expiresAt: now + 100 })],
      ['expired', createLock({ taskId: 'task-a', field: 'content', expiresAt: now })],
    ]);

    expect(hasActiveRemoteEditLock(locks, 'task-a', undefined, now)).toBe(true);
    expect(hasActiveRemoteEditLock(locks, 'task-a', 'content', now)).toBe(true);
    expect(hasActiveRemoteEditLock(locks, 'task-a', 'description', now)).toBe(false);
    expect(filterActiveRemoteLocksForTask(locks, 'task-a', now)).toEqual([
      createLock({ taskId: 'task-a', field: 'content', expiresAt: now + 100 }),
      createLock({ taskId: 'task-a', field: 'title', expiresAt: now + 100 }),
    ]);
  });
});
