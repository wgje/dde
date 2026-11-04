import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellStartupEntryIntentHostController,
} from './workspace-shell-startup-entry-intent-host.factory';
import type {
  WorkspaceShellStartupEntryIntentControllerOptions,
} from './workspace-shell-startup-entry-intent.controller';

function createControllerOptions(): WorkspaceShellStartupEntryIntentControllerOptions & {
  currentStartupEntryIntent: ReturnType<typeof vi.fn>;
  deferredStartupEntryIntent: ReturnType<typeof vi.fn>;
} {
  return {
    routeUrl: () => '/projects',
    currentStartupEntryIntent: vi.fn(() => null),
    deferredStartupEntryIntent: vi.fn(() => null),
    currentUserId: () => 'user-1',
    isApplicationReady: () => true,
    isBlackBoxEnabled: () => false,
    setSidebarOpen: vi.fn(),
    preloadSidebarTools: vi.fn(),
    loadBlackBoxRecorder: vi.fn(),
    applyWidgetGateMutation: vi.fn(),
    primeWidgetWorkspaceGateSync: vi.fn(),
    refreshFocusSessionFromCloud: vi.fn(),
    recheckGate: vi.fn(),
    clearDeferredStartupEntryIntent: vi.fn(),
    resolveMobileRootProjectId: () => null,
    navigate: vi.fn(),
    warn: vi.fn(),
  };
}

describe('createWorkspaceShellStartupEntryIntentHostController', () => {
  it('lazily constructs the concrete controller and exposes the host delegate surface', async () => {
    const delegate = await createWorkspaceShellStartupEntryIntentHostController(
      createControllerOptions(),
    );

    // host delegate 合同：flush/reset/sync 三个必备入口
    expect(typeof delegate.flushWidgetWorkspaceGateRecheck).toBe('function');
    expect(typeof delegate.resetPrimeState).toBe('function');
    expect(typeof delegate.sync).toBe('function');
  });

  it('wires the provided options into the constructed controller', async () => {
    const options = createControllerOptions();
    const delegate = await createWorkspaceShellStartupEntryIntentHostController(options);

    delegate.sync();

    // 无启动意图时 sync 立即读取 current + deferred 信号并直接返回
    expect(options.currentStartupEntryIntent).toHaveBeenCalledTimes(1);
    expect(options.deferredStartupEntryIntent).toHaveBeenCalledTimes(1);
  });

  it('creates an independent controller per invocation', async () => {
    const [first, second] = await Promise.all([
      createWorkspaceShellStartupEntryIntentHostController(createControllerOptions()),
      createWorkspaceShellStartupEntryIntentHostController(createControllerOptions()),
    ]);

    expect(first).not.toBe(second);
  });
});
