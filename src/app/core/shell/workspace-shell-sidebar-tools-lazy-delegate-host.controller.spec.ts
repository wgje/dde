import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellSidebarToolsLazyDelegateHostController,
  type WorkspaceShellSidebarToolsLazyDelegate,
} from './workspace-shell-sidebar-tools-lazy-delegate-host.controller';
import {
  createWorkspaceShellSidebarToolsDeferred,
  createWorkspaceShellSidebarToolsSpecDelegate,
  flushWorkspaceShellSidebarToolsMicrotasks,
} from './workspace-shell-sidebar-tools.spec-helpers';

function createHost(options: {
  createDelegate?: () => Promise<WorkspaceShellSidebarToolsLazyDelegate>;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const delegate = createWorkspaceShellSidebarToolsSpecDelegate();
  const createDelegate = options.createDelegate ?? vi.fn().mockResolvedValue(delegate);
  const warn = options.warn ?? vi.fn();
  const host = new WorkspaceShellSidebarToolsLazyDelegateHostController({
    createDelegate,
    loadFailureMessage: 'load failed',
    operationFailureMessage: 'operation failed',
    teardownFailureMessage: 'teardown failed',
    warn,
  });

  return { createDelegate, delegate, host, warn };
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

describe('WorkspaceShellSidebarToolsLazyDelegateHostController', () => {
  it('keeps the generic lazy call host behind a sidebar tools action host', () => {
    const source = readShellSource(
      'workspace-shell-sidebar-tools-lazy-delegate-host.controller.ts',
    );
    const actionHostSource = readShellSource(
      'workspace-shell-sidebar-tools-lazy-action-host.controller.ts',
    );

    expect(source).toContain('WorkspaceShellSidebarToolsLazyActionHostController');
    expect(source).not.toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(source).not.toContain('workspace-shell-lazy-delegate-call-host.controller');
    expect(actionHostSource).toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(actionHostSource).toContain('operationFailureMessage');
    expect(actionHostSource).toContain('loadFailureMessage');
  });

  it('loads one delegate for all sidebar tool operations in flight', async () => {
    const delegate = createWorkspaceShellSidebarToolsSpecDelegate();
    const deferred =
      createWorkspaceShellSidebarToolsDeferred<WorkspaceShellSidebarToolsLazyDelegate>();
    const createDelegate = vi.fn(() => deferred.promise);
    const { host } = createHost({ createDelegate });

    const preloadAssets = host.preloadFocusModeAssets('startup');
    const loadRecorder = host.loadBlackBoxRecorderComponent();
    host.onVoiceTranscribed(' capture ');
    host.onToolsIntent();
    host.preload('p1');
    host.scheduleFocusModePreload('startup');

    expect(createDelegate).toHaveBeenCalledOnce();

    deferred.resolve(delegate);
    await Promise.all([preloadAssets, loadRecorder]);
    await flushWorkspaceShellSidebarToolsMicrotasks();

    expect(delegate.preloadFocusModeAssets).toHaveBeenCalledWith('startup');
    expect(delegate.loadBlackBoxRecorderComponent).toHaveBeenCalledOnce();
    expect(delegate.onVoiceTranscribed).toHaveBeenCalledWith(' capture ');
    expect(delegate.onToolsIntent).toHaveBeenCalledOnce();
    expect(delegate.preload).toHaveBeenCalledWith('p1');
    expect(delegate.scheduleFocusModePreload).toHaveBeenCalledWith('startup');
  });

  it('warns with operation failure and resolves component calls to undefined', async () => {
    const error = new Error('load recorder failed');
    const delegate = createWorkspaceShellSidebarToolsSpecDelegate();
    vi.mocked(delegate.loadBlackBoxRecorderComponent).mockRejectedValue(error);
    const { host, warn } = createHost({
      createDelegate: vi.fn().mockResolvedValue(delegate),
    });

    await expect(host.loadBlackBoxRecorderComponent()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('operation failed', error);
    expect(warn).not.toHaveBeenCalledWith('load failed', error);
  });

  it('tears down pending delegates without running late operations', async () => {
    const delegate = createWorkspaceShellSidebarToolsSpecDelegate();
    const deferred =
      createWorkspaceShellSidebarToolsDeferred<WorkspaceShellSidebarToolsLazyDelegate>();
    const { host } = createHost({
      createDelegate: vi.fn(() => deferred.promise),
    });

    const pendingLoad = host.loadFocusSessionTriggerComponent();
    host.onVoiceTranscribed('late');
    host.teardown();
    deferred.resolve(delegate);
    await expect(pendingLoad).resolves.toBeUndefined();
    await flushWorkspaceShellSidebarToolsMicrotasks();

    expect(delegate.loadFocusSessionTriggerComponent).not.toHaveBeenCalled();
    expect(delegate.onVoiceTranscribed).not.toHaveBeenCalled();
    expect(delegate.teardown).toHaveBeenCalledOnce();
  });
});
