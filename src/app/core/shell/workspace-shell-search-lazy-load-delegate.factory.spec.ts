import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Project, Task } from '../../../models';

import {
  createWorkspaceShellSearchLazyLoadDelegate,
  type WorkspaceShellSearchLazyLoadDelegate,
} from './workspace-shell-search-lazy-load-delegate.factory';
import type {
  WorkspaceShellSearchServiceLike,
  WorkspaceShellSearchTask,
} from './workspace-shell-search-lazy-load.controller';

const FALLBACK_PROJECT = { id: 'project-fallback', name: 'Fallback' } as Project;
const SEARCH_PROJECT = { id: 'project-1', name: 'Project' } as Project;
const SEARCH_TASK = { id: 'task-1', title: 'Match' } as Task & WorkspaceShellSearchTask;

function createSearchDelegate(): WorkspaceShellSearchLazyLoadDelegate {
  return {
    filteredProjects: signal<Project[]>([SEARCH_PROJECT]),
    searchResults: signal<WorkspaceShellSearchTask[]>([SEARCH_TASK]),
    ensureLoaded: vi.fn(),
  };
}

function createSearchService(): WorkspaceShellSearchServiceLike {
  return {
    filteredProjects: signal<Project[]>([SEARCH_PROJECT]),
    searchResults: signal<WorkspaceShellSearchTask[]>([SEARCH_TASK]),
  };
}

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

describe('createWorkspaceShellSearchLazyLoadDelegate', () => {
  it('keeps search lazy-load state inside the delegate controller', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-search-lazy-load-delegate.factory.ts'),
      'utf8',
    );

    expect(source).toContain("from './workspace-shell-search-lazy-load-delegate.controller'");
    expect(source).toContain('new WorkspaceShellSearchLazyLoadDelegateController(options)');
    expect(source).not.toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(source).not.toContain('createWorkspaceShellSearchLazyLoadControllerLoader');
    expect(source).not.toContain("import('./workspace-shell-search-lazy-load.controller')");
    expect(source).not.toContain('new WorkspaceShellSearchLazyLoadController');
    expect(source).not.toContain('const delegate = signal');
    expect(source).not.toContain('function ensureLoaded');
    expect(source).not.toContain('delegatePromise');
  });

  it('keeps fallback signals synchronous before search is active', () => {
    const loadSearchDelegate = vi.fn().mockResolvedValue(createSearchDelegate());
    const delegate = createWorkspaceShellSearchLazyLoadDelegate({
      fallbackProjects: signal<Project[]>([FALLBACK_PROJECT]),
      hasActiveSearchQuery: () => false,
      loadSearchDelegate,
      warn: vi.fn(),
    });

    expect(delegate.searchResults()).toEqual([]);
    expect(delegate.filteredProjects()).toEqual([FALLBACK_PROJECT]);
    expect(loadSearchDelegate).not.toHaveBeenCalled();
  });

  it('keeps fallback signals without lazy loading after shell destroy', () => {
    const loadSearchDelegate = vi.fn().mockResolvedValue(createSearchDelegate());
    const delegate = createWorkspaceShellSearchLazyLoadDelegate({
      destroyed: () => true,
      fallbackProjects: signal<Project[]>([FALLBACK_PROJECT]),
      hasActiveSearchQuery: () => true,
      loadSearchDelegate,
      warn: vi.fn(),
    });

    expect(delegate.searchResults()).toEqual([]);
    expect(delegate.filteredProjects()).toEqual([FALLBACK_PROJECT]);
    delegate.ensureLoaded();

    expect(loadSearchDelegate).not.toHaveBeenCalled();
  });

  it('loads the real search delegate once when search becomes active', async () => {
    const searchDelegate = createSearchDelegate();
    const loadSearchDelegate = vi.fn().mockResolvedValue(searchDelegate);
    const delegate = createWorkspaceShellSearchLazyLoadDelegate({
      fallbackProjects: signal<Project[]>([FALLBACK_PROJECT]),
      hasActiveSearchQuery: () => true,
      loadSearchDelegate,
      warn: vi.fn(),
    });

    expect(delegate.searchResults()).toEqual([]);
    expect(delegate.filteredProjects()).toEqual([FALLBACK_PROJECT]);
    await flushMicrotasks();

    expect(loadSearchDelegate).toHaveBeenCalledTimes(1);
    expect(delegate.searchResults()).toEqual([SEARCH_TASK]);
    expect(delegate.filteredProjects()).toEqual([SEARCH_PROJECT]);
  });

  it('warns and allows retrying after the delegate chunk fails', async () => {
    const error = new Error('search delegate chunk missing');
    const loadSearchDelegate = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(createSearchDelegate());
    const warn = vi.fn();
    const delegate = createWorkspaceShellSearchLazyLoadDelegate({
      fallbackProjects: signal<Project[]>([FALLBACK_PROJECT]),
      hasActiveSearchQuery: () => true,
      loadSearchDelegate,
      warn,
    });

    delegate.ensureLoaded();
    await flushMicrotasks();
    delegate.ensureLoaded();
    await flushMicrotasks();

    expect(loadSearchDelegate).toHaveBeenCalledTimes(2);
    expect(delegate.searchResults()).toEqual([SEARCH_TASK]);
    expect(warn).toHaveBeenCalledWith(
      '搜索 lazy-load delegate 加载失败，搜索结果暂不可用',
      error,
    );
  });

  it('keeps fallback signals and retries when the loaded delegate ensureLoaded call fails', async () => {
    const error = new Error('search delegate ensureLoaded failed');
    const searchDelegate = createSearchDelegate();
    searchDelegate.ensureLoaded = vi.fn()
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockImplementationOnce(() => undefined);
    const loadSearchDelegate = vi.fn().mockResolvedValue(searchDelegate);
    const warn = vi.fn();
    let hasActiveSearchQuery = true;
    const delegate = createWorkspaceShellSearchLazyLoadDelegate({
      fallbackProjects: signal<Project[]>([FALLBACK_PROJECT]),
      hasActiveSearchQuery: () => hasActiveSearchQuery,
      loadSearchDelegate,
      warn,
    });

    delegate.ensureLoaded();
    await flushMicrotasks();
    hasActiveSearchQuery = false;

    expect(loadSearchDelegate).toHaveBeenCalledTimes(1);
    expect(searchDelegate.ensureLoaded).toHaveBeenCalledTimes(1);
    expect(delegate.searchResults()).toEqual([]);
    expect(delegate.filteredProjects()).toEqual([FALLBACK_PROJECT]);
    expect(warn).toHaveBeenCalledWith(
      '搜索 lazy-load delegate 初始化失败，搜索结果暂不可用',
      error,
    );
    expect(warn).not.toHaveBeenCalledWith(
      '搜索 lazy-load delegate 加载失败，搜索结果暂不可用',
      error,
    );

    hasActiveSearchQuery = true;
    delegate.ensureLoaded();
    await flushMicrotasks();

    expect(loadSearchDelegate).toHaveBeenCalledTimes(1);
    expect(searchDelegate.ensureLoaded).toHaveBeenCalledTimes(2);
    expect(delegate.searchResults()).toEqual([SEARCH_TASK]);
    expect(delegate.filteredProjects()).toEqual([SEARCH_PROJECT]);
  });

  it('can build the existing search controller behind the delegate boundary', async () => {
    const service = createSearchService();
    const delegate = createWorkspaceShellSearchLazyLoadDelegate({
      fallbackProjects: signal<Project[]>([FALLBACK_PROJECT]),
      hasActiveSearchQuery: () => true,
      loadSearchService: vi.fn().mockResolvedValue(service),
      warn: vi.fn(),
    });

    delegate.ensureLoaded();

    await vi.waitFor(() => {
      expect(delegate.searchResults()).toEqual([SEARCH_TASK]);
      expect(delegate.filteredProjects()).toEqual([SEARCH_PROJECT]);
    });
  });
});
