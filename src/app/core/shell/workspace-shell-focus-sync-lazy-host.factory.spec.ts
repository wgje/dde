import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createWorkspaceShellFocusSyncLazyHost } from './workspace-shell-focus-sync-lazy-host.factory';
import type { WorkspaceShellMountStateController } from './workspace-shell-mount-state.controller';
import type { WorkspaceShellResolvedFocusSyncControllersOptions } from './workspace-shell-focus-sync-controllers.factory';

function createResolvedOptions(): WorkspaceShellResolvedFocusSyncControllersOptions {
  return {
    authCoord: {
      isCheckingSession: () => false,
      isAuthLoading: () => false,
    },
    authService: { isConfigured: true },
    userSession: { currentUserId: () => 'user-1' },
    focusStartupProbe: {
      hasPendingGateWork: () => false,
      checkGateForProjectEntry: vi.fn(),
      warmProjectEntryGateSnapshot: vi.fn(),
      initialize: vi.fn(),
    },
    syncCoordinator: {
      pendingActionsCount: () => 0,
      offlineMode: () => false,
      isOnline: () => true,
      syncError: () => null,
      initialize: vi.fn(),
    },
    startupTier: {
      isTierReady: () => true,
      markAuthReady: vi.fn(),
    },
    getWindow: () => undefined,
    isDestroyed: () => false,
    appLifecycle: {
      isResuming: () => false,
      isRecoveryCompensationInFlight: () => false,
      getCurrentRecoveryTicket: () => null,
    },
    injector: { get: vi.fn() } as WorkspaceShellResolvedFocusSyncControllersOptions['injector'],
    isMobile: () => true,
    sidebarToolsLazyLoad: {
      preloadFocusModeAssets: vi.fn().mockResolvedValue(undefined),
      preload: vi.fn(),
    },
    taskOpsAdapter: { warmup: vi.fn().mockResolvedValue(undefined) },
    simpleSync: { startRuntime: vi.fn() },
    warn: vi.fn(),
    flushWidgetWorkspaceGateRecheck: vi.fn(),
  };
}

describe('createWorkspaceShellFocusSyncLazyHost', () => {
  it('creates the focus sync lazy host without eagerly loading focus sync controllers', () => {
    const host = createWorkspaceShellFocusSyncLazyHost(
      createResolvedOptions(),
      {} as WorkspaceShellMountStateController,
    );

    expect(host.loadedDelegate).toBeNull();
  });

  it('keeps the concrete focus sync controller hosts behind a loader boundary', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-focus-sync-lazy-host.factory.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellFocusSyncControllerHostsLoader');
    expect(source).not.toContain("import('./workspace-shell-focus-sync-controller-hosts.factory')");
    expect(source).not.toMatch(/createWorkspaceShellFocusSyncControllerHosts\s*\(/);
  });

  it('keeps focus sync lazy host state inside its controller', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-focus-sync-lazy-host.factory.ts'),
      'utf8',
    );

    expect(source).toContain("from './workspace-shell-focus-sync-lazy-host.controller'");
    expect(source).toContain('new WorkspaceShellFocusSyncLazyHostController(');
    expect(source).toContain('createWorkspaceShellFocusSyncControllerHostsLoader');
    expect(source).not.toContain('WorkspaceShellLazyDelegateCallHostController');
  });
});
