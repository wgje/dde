import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createWorkspaceShellStartupEntryIntentController,
  type WorkspaceShellDeferredStartupEntryIntentSignal,
  type WorkspaceShellStartupEntryIntentFactoryOptions,
} from './workspace-shell-startup-entry-intent.factory';
import type { StartupEntryIntent } from '../../../utils/startup-entry-intent';

function createDeferredStartupEntryIntentSignal(
  initialValue: StartupEntryIntent | null,
): WorkspaceShellDeferredStartupEntryIntentSignal {
  let value = initialValue;
  const signal = (() => value) as WorkspaceShellDeferredStartupEntryIntentSignal;
  signal.set = (nextValue: StartupEntryIntent | null) => {
    value = nextValue;
  };
  return signal;
}

function createFactoryOptions(
  overrides: Partial<WorkspaceShellStartupEntryIntentFactoryOptions> = {},
): WorkspaceShellStartupEntryIntentFactoryOptions {
  return {
    routeUrl: () => '/projects/project-1/text?entry=shortcut&intent=open-focus-tools',
    deferredStartupEntryIntent: createDeferredStartupEntryIntentSignal(null),
    currentUserId: () => 'user-1',
    isApplicationReady: () => true,
    isBlackBoxEnabled: () => true,
    setSidebarOpen: vi.fn(),
    preloadSidebarTools: vi.fn(),
    loadBlackBoxRecorder: vi.fn(),
    applyWidgetGateMutation: vi.fn(),
    primeWidgetWorkspaceGateSync: vi.fn(),
    refreshFocusSessionFromCloud: vi.fn(),
    recheckGate: vi.fn(),
    persistDeferredStartupEntryIntent: vi.fn(),
    resolveMobileRootProjectId: () => 'project-root',
    navigate: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  };
}

async function flushLazyController(): Promise<void> {
  await vi.dynamicImportSettled();
  await Promise.resolve();
}

function readShellSource(fileName: string): string {
  try {
    return readFileSync(join(__dirname, fileName), 'utf8');
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

describe('createWorkspaceShellStartupEntryIntentController', () => {
  it('keeps the startup entry intent lazy-load host behind a named lazy host controller', () => {
    const factorySource = readFileSync(
      join(__dirname, 'workspace-shell-startup-entry-intent.factory.ts'),
      'utf8',
    );
    const delegateSource = readShellSource(
      'workspace-shell-startup-entry-intent-lazy-delegate.controller.ts',
    );
    const lazyHostSource = readShellSource(
      'workspace-shell-startup-entry-intent-lazy-host.controller.ts',
    );

    expect(factorySource).not.toContain('createWorkspaceShellStartupEntryIntentLazyLoadHostLoader');
    expect(factorySource).not.toContain('WorkspaceShellStartupEntryIntentLazyLoadHostController,');
    expect(factorySource).not.toContain("import('./workspace-shell-startup-entry-intent-lazy-load-host.controller')");
    expect(factorySource).not.toContain('new WorkspaceShellStartupEntryIntentLazyLoadHostController');
    expect(delegateSource).toContain('WorkspaceShellStartupEntryIntentLazyHostController');
    expect(delegateSource).not.toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(delegateSource).not.toContain('workspace-shell-lazy-delegate-call-host.controller');
    expect(delegateSource).not.toContain('createWorkspaceShellStartupEntryIntentLazyLoadHostLoader');
    expect(delegateSource).not.toContain("import('./workspace-shell-startup-entry-intent-lazy-load-host.controller')");
    expect(delegateSource).not.toContain('new WorkspaceShellStartupEntryIntentLazyLoadHostController');
    expect(lazyHostSource).toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(lazyHostSource).toContain('createWorkspaceShellStartupEntryIntentLazyLoadHostLoader');
  });

  it('delegates lazy host caching to a named lazy delegate controller', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-startup-entry-intent.factory.ts'),
      'utf8',
    );

    expect(source).toContain('WorkspaceShellStartupEntryIntentLazyDelegateController');
    expect(source).not.toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(source).not.toContain('new WorkspaceShellLazyDelegateCallHostController');
    expect(source).not.toContain('class WorkspaceShellStartupEntryIntentFactoryController');
    expect(source).not.toContain('hostInstance');
    expect(source).not.toContain('hostPromise');
  });

  it('resolves the current startup entry intent from routeUrl outside the workspace shell component', async () => {
    const setSidebarOpen = vi.fn();
    const preloadSidebarTools = vi.fn();
    const persistDeferredStartupEntryIntent = vi.fn();
    const host = createWorkspaceShellStartupEntryIntentController(createFactoryOptions({
      setSidebarOpen,
      preloadSidebarTools,
      persistDeferredStartupEntryIntent,
    }));

    host.sync();
    await flushLazyController();

    expect(setSidebarOpen).toHaveBeenCalledWith(true);
    expect(preloadSidebarTools).toHaveBeenCalledWith('intent');
    expect(persistDeferredStartupEntryIntent).toHaveBeenCalledWith(null);
  });

  it('clears deferred startup entry intent through the signal and widget storage persistence', async () => {
    const deferredStartupEntryIntent = createDeferredStartupEntryIntentSignal({
      entry: 'widget',
      intent: 'open-focus-tools',
      rawIntent: 'open-focus-tools',
      widgetGateEntryId: null,
    });
    const persistDeferredStartupEntryIntent = vi.fn();
    const host = createWorkspaceShellStartupEntryIntentController(createFactoryOptions({
      routeUrl: () => '/projects/project-1/text',
      deferredStartupEntryIntent,
      persistDeferredStartupEntryIntent,
    }));

    host.sync();
    await flushLazyController();

    expect(deferredStartupEntryIntent()).toBeNull();
    expect(persistDeferredStartupEntryIntent).toHaveBeenCalledWith(null);
  });

  it('tears down pending lazy startup entry actions before the controller resolves', async () => {
    const setSidebarOpen = vi.fn();
    const preloadSidebarTools = vi.fn();
    const host = createWorkspaceShellStartupEntryIntentController(createFactoryOptions({
      setSidebarOpen,
      preloadSidebarTools,
    }));

    host.sync();
    expect(typeof (host as { teardown?: () => void }).teardown).toBe('function');
    (host as { teardown: () => void }).teardown();
    await flushLazyController();

    expect(setSidebarOpen).not.toHaveBeenCalled();
    expect(preloadSidebarTools).not.toHaveBeenCalled();
  });
});
