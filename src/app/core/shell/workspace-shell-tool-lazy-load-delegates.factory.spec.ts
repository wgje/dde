import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellToolLazyLoadDelegates,
  type WorkspaceShellToolLazyLoadDelegateOptions,
} from './workspace-shell-tool-lazy-load-delegates.factory';

function createBaseOptions(
  overrides: Partial<WorkspaceShellToolLazyLoadDelegateOptions> = {},
): WorkspaceShellToolLazyLoadDelegateOptions {
  return {
    injector: {} as never,
    createBlackBoxEntry: vi.fn().mockResolvedValue({ ok: true } as const),
    warning: vi.fn(),
    dynamicLoadEnabled: () => true,
    isBlackBoxEnabled: () => true,
    addBreadcrumb: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  } as WorkspaceShellToolLazyLoadDelegateOptions;
}

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

describe('createWorkspaceShellToolLazyLoadDelegates', () => {
  it('delegates focus and sidebar tools host loading out of the tool delegates factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-tool-lazy-load-delegates.factory.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellToolLazyLoadHostsLoader');
    expect(source).not.toMatch(
      /import\s*{[^}]*}\s*from\s*'\.\/workspace-shell-tool-lazy-load-hosts\.factory';/,
    );
    expect(source).not.toContain("import('./workspace-shell-tool-lazy-load-hosts.factory')");
    expect(source).not.toContain('function createToolLazyLoadHostsLoader');
    expect(source).not.toContain("import('./workspace-shell-focus-tools-lazy-load-host.controller')");
    expect(source).not.toContain("import('./workspace-shell-sidebar-tools-lazy-load-host.controller')");
    expect(source).not.toContain('new WorkspaceShellFocusToolsLazyLoadHostController');
    expect(source).not.toContain('new WorkspaceShellSidebarToolsLazyLoadHostController');
  });

  it('keeps sidebar focus tools wired through the focus lazy-load delegate', async () => {
    const setFocusSessionTrigger = vi.fn();
    const setBlackBoxRecorder = vi.fn();
    const addBreadcrumb = vi.fn();
    const warn = vi.fn();

    const delegates = createWorkspaceShellToolLazyLoadDelegates({
      injector: {} as never,
      focusSessionTriggerComponent: { set: setFocusSessionTrigger } as never,
      blackBoxRecorderComponent: { set: setBlackBoxRecorder } as never,
      createBlackBoxEntry: vi.fn().mockResolvedValue({ ok: true } as const),
      warning: vi.fn(),
      dynamicLoadEnabled: () => true,
      isBlackBoxEnabled: () => true,
      addBreadcrumb,
      warn,
      createFocusToolsHost: async () => ({
        loadFocusSessionTriggerComponent: vi.fn().mockResolvedValue('focus-trigger'),
        loadBlackBoxRecorderComponent: vi.fn().mockResolvedValue('black-box-recorder'),
        preloadFocusMode: vi.fn().mockResolvedValue(undefined),
        scheduleFocusModePreload: vi.fn(),
        teardown: vi.fn(),
      }),
      createSidebarToolsHost: undefined,
    });

    await expect(delegates.sidebarToolsLazyLoad.loadFocusSessionTriggerComponent())
      .resolves.toBe('focus-trigger');

    expect(setFocusSessionTrigger).not.toHaveBeenCalled();
    expect(addBreadcrumb).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('owns focus tool template signals and forwards recorder transcription', async () => {
    const onVoiceTranscribed = vi.fn();
    const delegates = createWorkspaceShellToolLazyLoadDelegates(createBaseOptions({
      createSidebarToolsHost: async () => ({
        loadFocusSessionTriggerComponent: vi.fn(),
        loadBlackBoxRecorderComponent: vi.fn(),
        onToolsIntent: vi.fn(),
        onVoiceTranscribed,
        preload: vi.fn(),
        preloadFocusModeAssets: vi.fn(),
        scheduleFocusModePreload: vi.fn(),
        teardown: vi.fn(),
      }),
    }));

    expect(delegates.focusSessionTriggerComponent()).toBeNull();
    expect(delegates.blackBoxRecorderComponent()).toBeNull();
    expect(delegates.blackBoxRecorderOutletInputs.appearance).toBe('obsidian');

    delegates.blackBoxRecorderOutletInputs.onTranscribed('captured note');

    await vi.waitFor(() => {
      expect(onVoiceTranscribed).toHaveBeenCalledWith('captured note');
    });
  });

  it('groups focus tool template bindings for the shell template', () => {
    const delegates = createWorkspaceShellToolLazyLoadDelegates(createBaseOptions());

    expect(delegates.templateBindings).toEqual({
      focusSessionTriggerComponent: delegates.focusSessionTriggerComponent,
      blackBoxRecorderComponent: delegates.blackBoxRecorderComponent,
      blackBoxRecorderOutletInputs: delegates.blackBoxRecorderOutletInputs,
    });
  });

  it('tears down focus and sidebar tool delegates', async () => {
    const focusTeardown = vi.fn();
    const sidebarTeardown = vi.fn();
    const delegates = createWorkspaceShellToolLazyLoadDelegates(createBaseOptions({
      createFocusToolsHost: async () => ({
        loadFocusSessionTriggerComponent: vi.fn(),
        loadBlackBoxRecorderComponent: vi.fn(),
        preloadFocusMode: vi.fn(),
        scheduleFocusModePreload: vi.fn(),
        teardown: focusTeardown,
      }),
      createSidebarToolsHost: async () => ({
        loadFocusSessionTriggerComponent: vi.fn(),
        loadBlackBoxRecorderComponent: vi.fn(),
        onToolsIntent: vi.fn(),
        onVoiceTranscribed: vi.fn(),
        preload: vi.fn(),
        preloadFocusModeAssets: vi.fn(),
        scheduleFocusModePreload: vi.fn(),
        teardown: sidebarTeardown,
      }),
    }));

    await delegates.focusToolsLazyLoad.loadFocusSessionTriggerComponent();
    await delegates.sidebarToolsLazyLoad.loadFocusSessionTriggerComponent();
    delegates.teardown();
    await flushMicrotasks();

    expect(focusTeardown).toHaveBeenCalledTimes(1);
    expect(sidebarTeardown).toHaveBeenCalledTimes(1);
  });

  it('continues tearing down sidebar tools when focus tools teardown fails', async () => {
    const error = new Error('focus teardown failed');
    const focusTeardown = vi.fn(() => {
      throw error;
    });
    const sidebarTeardown = vi.fn();
    const warn = vi.fn();
    const delegates = createWorkspaceShellToolLazyLoadDelegates(createBaseOptions({
      warn,
      createFocusToolsHost: async () => ({
        loadFocusSessionTriggerComponent: vi.fn(),
        loadBlackBoxRecorderComponent: vi.fn(),
        preloadFocusMode: vi.fn(),
        scheduleFocusModePreload: vi.fn(),
        teardown: focusTeardown,
      }),
      createSidebarToolsHost: async () => ({
        loadFocusSessionTriggerComponent: vi.fn(),
        loadBlackBoxRecorderComponent: vi.fn(),
        onToolsIntent: vi.fn(),
        onVoiceTranscribed: vi.fn(),
        preload: vi.fn(),
        preloadFocusModeAssets: vi.fn(),
        scheduleFocusModePreload: vi.fn(),
        teardown: sidebarTeardown,
      }),
    }));

    await delegates.focusToolsLazyLoad.loadFocusSessionTriggerComponent();
    await delegates.sidebarToolsLazyLoad.loadFocusSessionTriggerComponent();

    expect(() => delegates.teardown()).not.toThrow();
    await flushMicrotasks();

    expect(focusTeardown).toHaveBeenCalledTimes(1);
    expect(sidebarTeardown).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '工作区工具懒加载 focusToolsLazyLoad 清理失败，已继续清理后续工具',
      error,
    );
  });
});
