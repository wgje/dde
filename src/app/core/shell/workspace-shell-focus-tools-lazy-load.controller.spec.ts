import {
  Injector,
  runInInjectionContext,
  signal,
  type Type,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellFocusToolsLazyLoadController,
  type WorkspaceShellFocusModePreloadLike,
  type WorkspaceShellFocusToolsLoaderLike,
} from './workspace-shell-focus-tools-lazy-load.controller';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

class FocusSessionTriggerFixture {}
class BlackBoxRecorderFixture {}

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

async function flushReactiveEffects(): Promise<void> {
  await flushMicrotasks();
  TestBed.flushEffects();
  await flushMicrotasks();
}

function createPreloadService(): WorkspaceShellFocusModePreloadLike {
  return {
    preload: vi.fn().mockResolvedValue(undefined),
    schedule: vi.fn(),
  };
}

function createLoaderService(): WorkspaceShellFocusToolsLoaderLike & {
  setFocusSessionTriggerComponent(component: Type<unknown> | null): void;
  setBlackBoxRecorderComponent(component: Type<unknown> | null): void;
} {
  const focusSessionTriggerComponent = signal<Type<unknown> | null>(null);
  const blackBoxRecorderComponent = signal<Type<unknown> | null>(null);

  return {
    focusSessionTriggerComponent,
    blackBoxRecorderComponent,
    loadFocusSessionTrigger: vi.fn().mockImplementation(async () => {
      focusSessionTriggerComponent.set(FocusSessionTriggerFixture);
      return FocusSessionTriggerFixture;
    }),
    loadBlackBoxRecorder: vi.fn().mockImplementation(async () => {
      blackBoxRecorderComponent.set(BlackBoxRecorderFixture);
      return BlackBoxRecorderFixture;
    }),
    setFocusSessionTriggerComponent: component =>
      focusSessionTriggerComponent.set(component),
    setBlackBoxRecorderComponent: component =>
      blackBoxRecorderComponent.set(component),
  };
}

function readFocusToolsLazyLoadControllerSource(): string {
  return readFileSync(
    join(__dirname, 'workspace-shell-focus-tools-lazy-load.controller.ts'),
    'utf8',
  );
}

function readFocusToolsLazyLoadDelegateHostsFactorySource(): string {
  try {
    return readFileSync(
      join(__dirname, 'workspace-shell-focus-tools-lazy-load-delegate-hosts.factory.ts'),
      'utf8',
    );
  } catch (error) {
    if (
      error instanceof Error
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return '';
    }

    throw error;
  }
}

function createController(overrides: {
  loadFocusModePreloadService?: () => Promise<WorkspaceShellFocusModePreloadLike>;
  loadFocusToolsLoaderService?: () => Promise<WorkspaceShellFocusToolsLoaderLike>;
} = {}) {
  const injector = TestBed.inject(Injector);
  const focusSessionTriggerComponent = signal<Type<unknown> | null>(null);
  const blackBoxRecorderComponent = signal<Type<unknown> | null>(null);
  const preloadService = createPreloadService();
  const loaderService = createLoaderService();
  const warn = vi.fn();

  const controller = runInInjectionContext(
    injector,
    () => new WorkspaceShellFocusToolsLazyLoadController({
      injector,
      focusSessionTriggerComponent,
      blackBoxRecorderComponent,
      loadFocusModePreloadService: overrides.loadFocusModePreloadService
        ?? vi.fn().mockResolvedValue(preloadService),
      loadFocusToolsLoaderService: overrides.loadFocusToolsLoaderService
        ?? vi.fn().mockResolvedValue(loaderService),
      warn,
    }),
  );

  return {
    blackBoxRecorderComponent,
    controller,
    focusSessionTriggerComponent,
    loaderService,
    preloadService,
    warn,
  };
}

describe('WorkspaceShellFocusToolsLazyLoadController', () => {
  it('keeps focus tools lazy delegate host construction behind the named factory', () => {
    const lazyLoadSource = readFocusToolsLazyLoadControllerSource();
    const lazyLoadDelegateHostsFactorySource =
      readFocusToolsLazyLoadDelegateHostsFactorySource();

    expect(lazyLoadSource).toContain('createWorkspaceShellFocusToolsLazyLoadDelegateHosts');
    expect(lazyLoadSource).not.toContain('createWorkspaceShellFocusToolsLazyDelegateHosts');
    expect(lazyLoadSource).not.toContain('createWorkspaceShellFocusModePreloadServiceLoader');
    expect(lazyLoadSource).not.toContain('createWorkspaceShellFocusToolsLoaderServiceLoader');
    expect(lazyLoadSource).not.toContain('new WorkspaceShellLazyDelegateCallHostController');
    expect(lazyLoadDelegateHostsFactorySource)
      .toContain('createWorkspaceShellFocusToolsLazyDelegateHosts');
    expect(lazyLoadDelegateHostsFactorySource)
      .toContain('createWorkspaceShellFocusModePreloadServiceLoader');
    expect(lazyLoadDelegateHostsFactorySource)
      .toContain('createWorkspaceShellFocusToolsLoaderServiceLoader');
  });

  it('delegates focus tools service resolution out of the focus tools controller', () => {
    const lazyLoadSource = readFocusToolsLazyLoadControllerSource();
    const lazyLoadDelegateHostsFactorySource =
      readFocusToolsLazyLoadDelegateHostsFactorySource();

    expect(lazyLoadSource).not.toContain('createWorkspaceShellFocusModePreloadServiceLoader');
    expect(lazyLoadSource).not.toContain('createWorkspaceShellFocusToolsLoaderServiceLoader');
    expect(lazyLoadSource).not.toContain("import('../../features/focus/services/focus-mode-preload.service')");
    expect(lazyLoadSource).not.toContain("import('../../features/focus/services/focus-tools-loader.service')");
    expect(lazyLoadDelegateHostsFactorySource)
      .toContain('createWorkspaceShellFocusModePreloadServiceLoader');
    expect(lazyLoadDelegateHostsFactorySource)
      .toContain('createWorkspaceShellFocusToolsLoaderServiceLoader');
  });

  it('delegates focus preload requests to the lazy preload service', async () => {
    const { controller, preloadService } = createController();

    await controller.preloadFocusMode('intent');
    controller.scheduleFocusModePreload('startup');
    await flushMicrotasks();

    expect(preloadService.preload).toHaveBeenCalledWith('intent');
    expect(preloadService.schedule).toHaveBeenCalledWith('startup');
  });

  it('loads focus tool components and mirrors loader signals into shell signals', async () => {
    const {
      blackBoxRecorderComponent,
      controller,
      focusSessionTriggerComponent,
      loaderService,
    } = createController();

    await controller.loadFocusSessionTriggerComponent();
    await controller.loadBlackBoxRecorderComponent();
    loaderService.setFocusSessionTriggerComponent(null);
    loaderService.setBlackBoxRecorderComponent(null);
    await flushReactiveEffects();

    expect(focusSessionTriggerComponent()).toBeNull();
    expect(blackBoxRecorderComponent()).toBeNull();
  });

  it('stops mirroring loader signals after teardown', async () => {
    const {
      controller,
      focusSessionTriggerComponent,
      loaderService,
    } = createController();

    await controller.loadFocusSessionTriggerComponent();
    expect(focusSessionTriggerComponent()).toBe(FocusSessionTriggerFixture);

    controller.teardown();
    loaderService.setFocusSessionTriggerComponent(null);
    await flushReactiveEffects();

    expect(focusSessionTriggerComponent()).toBe(FocusSessionTriggerFixture);
  });

  it('does not mirror loader signals after teardown while the loader is resolving', async () => {
    let resolveLoader: (service: WorkspaceShellFocusToolsLoaderLike) => void = () => undefined;
    const loaderService = createLoaderService();
    const loadFocusToolsLoaderService = vi.fn<() => Promise<WorkspaceShellFocusToolsLoaderLike>>()
      .mockReturnValue(new Promise(resolve => {
        resolveLoader = resolve;
      }));
    const {
      blackBoxRecorderComponent,
      controller,
      focusSessionTriggerComponent,
    } = createController({ loadFocusToolsLoaderService });

    const loadPromise = controller.loadFocusSessionTriggerComponent();
    controller.teardown();
    loaderService.setFocusSessionTriggerComponent(FocusSessionTriggerFixture);
    loaderService.setBlackBoxRecorderComponent(BlackBoxRecorderFixture);
    resolveLoader(loaderService);

    await expect(loadPromise).resolves.toBeNull();
    await flushReactiveEffects();

    expect(focusSessionTriggerComponent()).toBeNull();
    expect(blackBoxRecorderComponent()).toBeNull();
  });

  it('does not set shell component signals after teardown while a component load is resolving', async () => {
    let resolveBlackBoxRecorder: (component: Type<unknown> | null) => void = () => undefined;
    const loaderService = createLoaderService();
    loaderService.loadBlackBoxRecorder = vi.fn<() => Promise<Type<unknown> | null>>()
      .mockReturnValue(new Promise(resolve => {
        resolveBlackBoxRecorder = resolve;
      }));
    const {
      blackBoxRecorderComponent,
      controller,
    } = createController({
      loadFocusToolsLoaderService: vi.fn().mockResolvedValue(loaderService),
    });

    const loadPromise = controller.loadBlackBoxRecorderComponent();
    await flushMicrotasks();

    controller.teardown();
    resolveBlackBoxRecorder(BlackBoxRecorderFixture);

    await expect(loadPromise).resolves.toBeNull();
    await flushReactiveEffects();

    expect(blackBoxRecorderComponent()).toBeNull();
  });
});
