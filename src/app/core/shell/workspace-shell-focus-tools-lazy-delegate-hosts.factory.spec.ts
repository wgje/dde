import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { signal, type Type } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellFocusToolsLazyDelegateHosts,
} from './workspace-shell-focus-tools-lazy-delegate-hosts.factory';
import type {
  WorkspaceShellFocusModePreloadLike,
  WorkspaceShellFocusToolsLoaderLike,
} from './workspace-shell-focus-tools-lazy-load.controller';

class FocusSessionTriggerFixture {}

function createPreloadService(): WorkspaceShellFocusModePreloadLike {
  return {
    preload: vi.fn().mockResolvedValue(undefined),
    schedule: vi.fn(),
  };
}

function createLoaderService(): WorkspaceShellFocusToolsLoaderLike {
  return {
    focusSessionTriggerComponent: signal<Type<unknown> | null>(FocusSessionTriggerFixture),
    blackBoxRecorderComponent: signal<Type<unknown> | null>(null),
    loadFocusSessionTrigger: vi.fn().mockResolvedValue(FocusSessionTriggerFixture),
    loadBlackBoxRecorder: vi.fn().mockResolvedValue(null),
  };
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

describe('createWorkspaceShellFocusToolsLazyDelegateHosts', () => {
  it('delegates lazy host caching to a named focus tools host controller', () => {
    const factorySource = readFileSync(
      join(__dirname, 'workspace-shell-focus-tools-lazy-delegate-hosts.factory.ts'),
      'utf8',
    );
    const hostSource = readSourceIfPresent(
      'workspace-shell-focus-tools-lazy-delegate-host.controller.ts',
    );
    const actionHostSource = readSourceIfPresent(
      'workspace-shell-focus-tools-lazy-action-host.controller.ts',
    );

    expect(factorySource).toContain('WorkspaceShellFocusToolsLazyDelegateHostController');
    expect(factorySource).not.toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(factorySource).not.toContain('new WorkspaceShellLazyDelegateCallHostController');
    expect(hostSource).toContain('WorkspaceShellFocusToolsLazyActionHostController');
    expect(hostSource).not.toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(actionHostSource).toContain('WorkspaceShellLazyDelegateCallHostController');
  });

  it('loads focus tool delegates only when their host is used', async () => {
    const preloadService = createPreloadService();
    const loaderService = createLoaderService();
    const loadFocusModePreload = vi.fn().mockResolvedValue(preloadService);
    const loadFocusToolsLoader = vi.fn().mockResolvedValue(loaderService);
    const hosts = createWorkspaceShellFocusToolsLazyDelegateHosts({
      loadFocusModePreload,
      loadFocusToolsLoader,
      warn: vi.fn(),
    });

    expect(loadFocusModePreload).not.toHaveBeenCalled();
    expect(loadFocusToolsLoader).not.toHaveBeenCalled();

    await hosts.focusModePreloadHost.call(service => service.preload('intent'), undefined);
    await hosts.focusToolsLoaderHost.call(service => service.loadFocusSessionTrigger(), null);

    expect(loadFocusModePreload).toHaveBeenCalledTimes(1);
    expect(loadFocusToolsLoader).toHaveBeenCalledTimes(1);
    expect(preloadService.preload).toHaveBeenCalledWith('intent');
    expect(loaderService.loadFocusSessionTrigger).toHaveBeenCalledTimes(1);
  });

  it('warns with the focus tools failure message and falls back when loading fails', async () => {
    const error = new Error('load failed');
    const warn = vi.fn();
    const hosts = createWorkspaceShellFocusToolsLazyDelegateHosts({
      loadFocusModePreload: vi.fn().mockResolvedValue(createPreloadService()),
      loadFocusToolsLoader: vi.fn().mockRejectedValue(error),
      warn,
    });

    await expect(
      hosts.focusToolsLoaderHost.call(
        service => service.loadFocusSessionTrigger(),
        null,
      ),
    ).resolves.toBeNull();

    expect(warn).toHaveBeenCalledWith(
      'Focus 工具懒加载服务加载失败，侧栏工具暂不可用',
      error,
    );
  });
});
