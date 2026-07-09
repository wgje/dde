import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Injector } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceShellFocusSyncControllers,
  WorkspaceShellFocusSyncControllersOptions,
} from './workspace-shell-focus-sync-controllers.factory';
import { createWorkspaceShellFocusSyncSurface } from './workspace-shell-focus-sync-surface.factory';
import {
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

function createFocusSyncControllers(): WorkspaceShellFocusSyncControllers {
  return {
    focusEntrySyncPulse: {
      clearRetry: vi.fn(),
      dispatchIfReady: vi.fn(),
      handleOwnerChange: vi.fn(),
      reset: vi.fn(),
    },
    focusMountIntent: { setup: vi.fn(), teardown: vi.fn() },
    focusProbeController: { sync: vi.fn() },
    mobileFocusGate: {
      checkGateForMobileProjectEntry: vi.fn(),
      flushPendingMobileProjectGateCheck: vi.fn(),
      warmMobileProjectGateSnapshot: vi.fn(),
    },
    mountState: {} as WorkspaceShellFocusSyncControllers['mountState'],
    startupTierHydration: {
      markAuthReadyIfReady: vi.fn(),
      startSyncHydrationIfReady: vi.fn(),
      warmupInteractionIfReady: vi.fn(),
    },
    syncPulseLifecycle: {
      clearFocusEntrySyncPulseRetry: vi.fn(),
      destroy: vi.fn(),
      dispatchFocusEntrySyncPulseIfReady: vi.fn(),
      initialize: vi.fn(),
      isReady: vi.fn(() => false),
      resetFocusEntrySyncPulse: vi.fn(),
      sync: vi.fn(),
      syncEffect: vi.fn(),
      trigger: vi.fn(async () => null),
    },
  };
}

async function flushLazyHosts(): Promise<void> {
  await vi.dynamicImportSettled();
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

function readSourceIfPresent(fileName: string): string {
  try {
    return readFileSync(join(__dirname, fileName), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

describe('workspace shell focus sync surface', () => {
  it('keeps the full focus sync controller factory behind a named lazy delegate controller', () => {
    const surfaceSource = readFileSync(
      join(__dirname, 'workspace-shell-focus-sync-surface.factory.ts'),
      'utf8',
    );
    const delegateSource = readSourceIfPresent(
      'workspace-shell-focus-sync-surface-lazy-delegate.controller.ts',
    );

    expect(surfaceSource).toContain('WorkspaceShellFocusSyncSurfaceLazyDelegateController');
    expect(surfaceSource).not.toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(surfaceSource).not.toContain(
      "import('./workspace-shell-focus-sync-controllers.factory')",
    );
    expect(delegateSource).toMatch(
      /import\(['"]\.\/workspace-shell-focus-sync-controllers\.factory['"]\)/,
    );
    expect(delegateSource).not.toMatch(
      /import\s+\{[\s\S]*createWorkspaceShellFocusSyncControllers[\s\S]*\}\s+from\s+['"]\.\/workspace-shell-focus-sync-controllers\.factory['"]/,
    );
  });

  it('maps shell lazy refs and tool controllers into focus sync controller options lazily', async () => {
    expect(createWorkspaceShellFocusSyncSurface).toEqual(expect.any(Function));

    let mappedOptions!: WorkspaceShellFocusSyncControllersOptions;
    const focusSyncControllers = createFocusSyncControllers();
    const focusStartupProbe = {
      hasPendingGateWork: vi.fn(() => false),
      checkGateForProjectEntry: vi.fn(),
      warmProjectEntryGateSnapshot: vi.fn(),
      initialize: vi.fn(),
    };
    const simpleSync = { startRuntime: vi.fn() };
    const sidebarToolsLazyLoad = {
      preloadFocusModeAssets: vi.fn(async () => undefined),
      preload: vi.fn(),
    };
    const taskOpsService = { warmup: vi.fn(async () => 'ready') };
    const injector = {
      get: vi.fn(() => taskOpsService),
    } as unknown as Injector;

    const createFocusSyncControllersSpy = vi.fn((
      options: WorkspaceShellFocusSyncControllersOptions,
    ) => {
      mappedOptions = options;
      return focusSyncControllers;
    });

    const result = createWorkspaceShellFocusSyncSurface({
      appLifecycle: {
        isResuming: vi.fn(() => false),
        isRecoveryCompensationInFlight: vi.fn(() => false),
        getCurrentRecoveryTicket: vi.fn(() => null),
      },
      authCoord: {
        isCheckingSession: vi.fn(() => false),
        isAuthLoading: vi.fn(() => false),
      },
      authService: { isConfigured: true },
      injector,
      isDestroyed: vi.fn(() => false),
      lazyServiceRefs: {
        focusStartupProbe,
        simpleSync,
      },
      startupEntryControllers: vi.fn(() => ({
        startupEntryIntentController: {
          flushWidgetWorkspaceGateRecheck: vi.fn(),
        },
      })),
      startupTier: {
        isTierReady: vi.fn(() => true),
        markAuthReady: vi.fn(),
      },
      syncCoordinator: {
        pendingActionsCount: vi.fn(() => 0),
        offlineMode: vi.fn(() => false),
        isOnline: vi.fn(() => true),
        syncError: vi.fn(() => null),
        initialize: vi.fn(),
      },
      toolControllers: {
        sidebarToolsLazyLoad,
      },
      userSession: { currentUserId: vi.fn(() => 'user-1') },
      uiState: { isMobile: vi.fn(() => false) },
      warn: vi.fn(),
      createFocusSyncControllers: createFocusSyncControllersSpy,
    });

    expect(result).not.toBe(focusSyncControllers);
    expect(createFocusSyncControllersSpy).not.toHaveBeenCalled();

    result.focusProbeController.sync();
    await flushLazyHosts();

    expect(createFocusSyncControllersSpy).toHaveBeenCalledTimes(1);
    expect(mappedOptions.focusStartupProbe).toBe(focusStartupProbe);
    expect(mappedOptions.isMobile()).toBe(false);
    expect(mappedOptions.sidebarToolsLazyLoad).toBe(sidebarToolsLazyLoad);
    expect(mappedOptions.simpleSync).toBe(simpleSync);
    expect(injector.get).not.toHaveBeenCalled();
    await expect(mappedOptions.taskOpsAdapter.warmup()).resolves.toBe('ready');
    expect(injector.get).toHaveBeenCalledTimes(1);
    expect(taskOpsService.warmup).toHaveBeenCalledTimes(1);
    expect(mappedOptions).not.toHaveProperty('lazyServiceRefs');
    expect(mappedOptions).not.toHaveProperty('toolControllers');
  });

  it('keeps focus sync option assembly outside WorkspaceShellComponent', () => {
    const source = readWorkspaceShellSource();
    const graphSource = readWorkspaceShellControllerGraphSource();
    const sessionRoutingSurfaceSource = readFileSync(
      join(
        process.cwd(),
        'src/app/core/shell/workspace-shell-session-routing-surface.factory.ts',
      ),
      'utf8',
    );
    const sessionRoutingBlock = graphSource.match(
      /createWorkspaceShellSessionRoutingSurface\(\{(?<body>[\s\S]*?)\n\s+\}\);/,
    )?.groups?.body;
    const focusSyncBlock = sessionRoutingSurfaceSource.match(
      /createWorkspaceShellFocusSyncSurface\(\{(?<body>[\s\S]*?)\n\s+\}\);/,
    )?.groups?.body;

    expect(graphSource).toContain('createWorkspaceShellSessionRoutingSurface');
    expect(sessionRoutingSurfaceSource)
      .toContain('createWorkspaceShellFocusSyncSurface');
    expect(sessionRoutingBlock).toBeDefined();
    expect(focusSyncBlock).toBeDefined();
    expect(source).not.toContain('createWorkspaceShellFocusSyncControllers');
    expect(source).not.toContain('createWorkspaceShellTaskOpsAdapter');
    expect(source).not.toContain('private readonly taskOpsAdapter =');
    expect(focusSyncBlock).not.toContain('taskOpsAdapter: this.taskOpsAdapter');
    expect(focusSyncBlock).not.toContain(
      'focusStartupProbe: this.lazyServiceRefs.focusStartupProbe',
    );
    expect(focusSyncBlock).not.toContain(
      'sidebarToolsLazyLoad: this.toolControllers.sidebarToolsLazyLoad',
    );
    expect(focusSyncBlock).not.toContain(
      'simpleSync: this.lazyServiceRefs.simpleSync',
    );
    expect(sessionRoutingBlock).toContain('...context');
    expect(sessionRoutingBlock).toContain('...base');
    expect(focusSyncBlock).toContain('...options');
    expect(focusSyncBlock).toContain('isDestroyed: options.runtime');
    expect(focusSyncBlock).not.toContain(
      'isMobile: () => this.uiState.isMobile()',
    );
  });

  it('splits focus sync surface assembly into helpers', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-focus-sync-surface.factory.ts'),
      'utf8',
    );

    expect(source).toContain('function createWorkspaceShellFocusSyncOptions(');
    expect(source).toContain('function createWorkspaceShellFocusSyncLazyControllers(');
    expect(source).toContain(
      'const focusSyncOptions = createWorkspaceShellFocusSyncOptions(options);',
    );
    expect(source).toContain(
      'const lazyControllers = createWorkspaceShellFocusSyncLazyControllers(',
    );
  });
});
