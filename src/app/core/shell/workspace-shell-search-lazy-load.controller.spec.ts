import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import type { Project, Task } from '../../../models';
import {
  WorkspaceShellSearchLazyLoadController,
  type WorkspaceShellSearchServiceLike,
  type WorkspaceShellSearchTask,
} from './workspace-shell-search-lazy-load.controller';

const SEARCH_TASK = { id: 'task-1', title: 'Match' } as Task & WorkspaceShellSearchTask;
const FALLBACK_PROJECT = { id: 'project-fallback', name: 'Fallback' } as Project;
const SEARCH_PROJECT = { id: 'project-1', name: 'Project' } as Project;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

function createSearchService(): WorkspaceShellSearchServiceLike {
  return {
    filteredProjects: signal<Project[]>([SEARCH_PROJECT]),
    searchResults: signal<WorkspaceShellSearchTask[]>([SEARCH_TASK]),
  };
}

function readSearchLazyLoadControllerSource(): string {
  return readFileSync(
    join(process.cwd(), 'src/app/core/shell/workspace-shell-search-lazy-load.controller.ts'),
    'utf8',
  );
}

function createController(overrides: {
  destroyed?: () => boolean;
  hasActiveSearchQuery?: () => boolean;
  loadSearchService?: () => Promise<WorkspaceShellSearchServiceLike>;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const service = createSearchService();
  const warn = overrides.warn ?? vi.fn();
  const loadSearchService = overrides.loadSearchService ?? vi.fn().mockResolvedValue(service);
  const controller = new WorkspaceShellSearchLazyLoadController({
    destroyed: overrides.destroyed ?? (() => false),
    fallbackProjects: signal<Project[]>([FALLBACK_PROJECT]),
    hasActiveSearchQuery: overrides.hasActiveSearchQuery ?? (() => true),
    loadSearchService,
    warn,
  });

  return { controller, loadSearchService, service, warn };
}

describe('WorkspaceShellSearchLazyLoadController', () => {
  it('delegates SearchService loading to the search service loader factory', () => {
    const source = readSearchLazyLoadControllerSource();

    expect(source).toContain('createWorkspaceShellSearchServiceLoader');
    expect(source).not.toContain("import('../../../services/search.service')");
    expect(source).not.toContain('injector.get(SearchService)');
  });

  it('returns fallback signals without loading the search service when no search is active', () => {
    const { controller, loadSearchService } = createController({
      hasActiveSearchQuery: () => false,
    });

    expect(controller.searchResults()).toEqual([]);
    expect(controller.filteredProjects()).toEqual([FALLBACK_PROJECT]);
    expect(loadSearchService).not.toHaveBeenCalled();
  });

  it('loads the search service once while search result signals are requested', async () => {
    const service = createSearchService();
    const deferred = createDeferred<WorkspaceShellSearchServiceLike>();
    const { controller, loadSearchService } = createController({
      loadSearchService: vi.fn(() => deferred.promise),
    });

    expect(controller.searchResults()).toEqual([]);
    expect(controller.filteredProjects()).toEqual([FALLBACK_PROJECT]);
    expect(loadSearchService).toHaveBeenCalledTimes(1);

    deferred.resolve(service);
    await flushMicrotasks();

    expect(controller.searchResults()).toEqual([SEARCH_TASK]);
    expect(controller.filteredProjects()).toEqual([SEARCH_PROJECT]);
  });

  it('warns and allows retrying after the search service load fails', async () => {
    const error = { message: 'chunk unavailable' };
    const service = createSearchService();
    const { controller, loadSearchService, warn } = createController({
      loadSearchService: vi.fn()
        .mockImplementationOnce(() => Promise.resolve().then(() => {
          throw error;
        }))
        .mockResolvedValueOnce(service),
    });

    controller.ensureLoaded();
    await flushMicrotasks();
    controller.ensureLoaded();
    await flushMicrotasks();

    expect(loadSearchService).toHaveBeenCalledTimes(2);
    expect(controller.searchResults()).toEqual([SEARCH_TASK]);
    expect(warn).toHaveBeenCalledWith('搜索服务懒加载失败，搜索结果暂不可用', error);
  });

  it('warns and allows retrying after the search service loader throws synchronously', async () => {
    const error = new Error('search loader unavailable');
    const service = createSearchService();
    const { controller, loadSearchService, warn } = createController({
      loadSearchService: vi.fn()
        .mockImplementationOnce(() => {
          throw error;
        })
        .mockResolvedValueOnce(service),
    });

    expect(() => controller.ensureLoaded()).not.toThrow();
    await flushMicrotasks();

    controller.ensureLoaded();
    await flushMicrotasks();

    expect(loadSearchService).toHaveBeenCalledTimes(2);
    expect(controller.searchResults()).toEqual([SEARCH_TASK]);
    expect(warn).toHaveBeenCalledWith('搜索服务懒加载失败，搜索结果暂不可用', error);
  });

  it('keeps fallback signals when the search service resolves after shell destroy', async () => {
    let destroyed = false;
    const service = createSearchService();
    const deferred = createDeferred<WorkspaceShellSearchServiceLike>();
    const { controller, loadSearchService } = createController({
      destroyed: () => destroyed,
      loadSearchService: vi.fn(() => deferred.promise),
    });

    expect(controller.searchResults()).toEqual([]);
    destroyed = true;
    deferred.resolve(service);
    await flushMicrotasks();

    expect(loadSearchService).toHaveBeenCalledTimes(1);
    expect(controller.searchResults()).toEqual([]);
    expect(controller.filteredProjects()).toEqual([FALLBACK_PROJECT]);
  });
});
