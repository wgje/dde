import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellToolLazyLoadHosts,
  type WorkspaceShellToolLazyLoadHostsOptions,
} from './workspace-shell-tool-lazy-load-hosts.factory';

function createBaseOptions(
  overrides: Partial<WorkspaceShellToolLazyLoadHostsOptions> = {},
): WorkspaceShellToolLazyLoadHostsOptions {
  return {
    injector: {} as never,
    focusSessionTriggerComponent: signal<unknown | null>(null) as never,
    blackBoxRecorderComponent: signal<unknown | null>(null) as never,
    createBlackBoxEntry: vi.fn().mockResolvedValue({ ok: true } as const),
    warning: vi.fn(),
    dynamicLoadEnabled: () => true,
    isBlackBoxEnabled: () => true,
    addBreadcrumb: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  } as WorkspaceShellToolLazyLoadHostsOptions;
}

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

describe('createWorkspaceShellToolLazyLoadHosts', () => {
  it('delegates focus tools default host creation out of the tool hosts factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-tool-lazy-load-hosts.factory.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellFocusToolsLazyLoadHost');
    expect(source).not.toContain('workspace-shell-focus-tools-lazy-load-host.controller');
    expect(source).not.toContain('WorkspaceShellFocusToolsLazyLoadHostController');
    expect(source).not.toContain('WorkspaceShellFocusToolsLazyLoadHostOptions');
    expect(source).not.toContain('workspace-shell-focus-tools-lazy-load-resolver.controller');
    expect(source).not.toContain('WorkspaceShellFocusToolsLazyLoadResolverController');
    expect(source).not.toContain("import('./workspace-shell-focus-tools-lazy-load.controller')");
    expect(source).not.toMatch(/\bnew\s+WorkspaceShellFocusToolsLazyLoadController\b/);
  });

  it('delegates sidebar tools default host creation out of the tool hosts factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-tool-lazy-load-hosts.factory.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellSidebarToolsLazyLoadHost');
    expect(source).not.toContain("import('./workspace-shell-sidebar-tools-lazy-load-host.controller')");
    expect(source).not.toContain('WorkspaceShellSidebarToolsLazyLoadHostController');
  });

  it('keeps focus and sidebar host creation lazy while wiring sidebar through focus tools', async () => {
    const focusTools = {
      loadFocusSessionTriggerComponent: vi.fn().mockResolvedValue('focus-trigger'),
      loadBlackBoxRecorderComponent: vi.fn().mockResolvedValue('black-box-recorder'),
      preloadFocusMode: vi.fn().mockResolvedValue(undefined),
      scheduleFocusModePreload: vi.fn(),
      teardown: vi.fn(),
    };
    const sidebarTools = {
      loadFocusSessionTriggerComponent: vi.fn(),
      loadBlackBoxRecorderComponent: vi.fn(),
      onToolsIntent: vi.fn(),
      onVoiceTranscribed: vi.fn(),
      preload: vi.fn(),
      preloadFocusModeAssets: vi.fn(),
      scheduleFocusModePreload: vi.fn(),
      teardown: vi.fn(),
    };
    const createFocusToolsHost = vi.fn().mockResolvedValue(focusTools);
    const createSidebarToolsHost = vi.fn().mockResolvedValue(sidebarTools);
    const hosts = createWorkspaceShellToolLazyLoadHosts(createBaseOptions({
      createFocusToolsHost,
      createSidebarToolsHost,
    }));

    expect(createFocusToolsHost).not.toHaveBeenCalled();
    expect(createSidebarToolsHost).not.toHaveBeenCalled();

    await expect(hosts.sidebarToolsLazyLoad.loadFocusSessionTriggerComponent())
      .resolves.toBeUndefined();
    await flushMicrotasks();

    expect(createSidebarToolsHost).toHaveBeenCalledTimes(1);
    expect(createFocusToolsHost).not.toHaveBeenCalled();

    await expect(hosts.focusToolsLazyLoad.loadFocusSessionTriggerComponent())
      .resolves.toBe('focus-trigger');

    expect(createFocusToolsHost).toHaveBeenCalledTimes(1);
    expect(focusTools.loadFocusSessionTriggerComponent).toHaveBeenCalledTimes(1);
  });
});
