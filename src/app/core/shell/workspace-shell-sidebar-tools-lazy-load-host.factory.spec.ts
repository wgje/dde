import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellSidebarToolsLazyLoadHost,
} from './workspace-shell-sidebar-tools-lazy-load-host.factory';
import type {
  WorkspaceShellFocusToolsHostDelegate,
} from './workspace-shell-tool-lazy-load-hosts.factory';

function createFocusToolsHost(): WorkspaceShellFocusToolsHostDelegate {
  return {
    loadFocusSessionTriggerComponent: vi.fn().mockResolvedValue('focus-trigger'),
    loadBlackBoxRecorderComponent: vi.fn().mockResolvedValue('black-box-recorder'),
    preloadFocusMode: vi.fn().mockResolvedValue(undefined),
    scheduleFocusModePreload: vi.fn(),
    teardown: vi.fn(),
  };
}

describe('createWorkspaceShellSidebarToolsLazyLoadHost', () => {
  it('creates a sidebar host wired through focus tools delegates', async () => {
    const focusTools = createFocusToolsHost();
    const sidebarTools = {
      loadBlackBoxRecorderComponent: vi.fn().mockResolvedValue('sidebar-black-box'),
      loadFocusSessionTriggerComponent: vi.fn().mockResolvedValue('sidebar-focus-trigger'),
      onToolsIntent: vi.fn(),
      onVoiceTranscribed: vi.fn(),
      preload: vi.fn(),
      preloadFocusModeAssets: vi.fn().mockResolvedValue(undefined),
      scheduleFocusModePreload: vi.fn(),
      teardown: vi.fn(),
    };

    const host = await createWorkspaceShellSidebarToolsLazyLoadHost({
      createBlackBoxEntry: vi.fn().mockResolvedValue({ ok: true } as const),
      warning: vi.fn(),
      dynamicLoadEnabled: () => true,
      isBlackBoxEnabled: () => true,
      addBreadcrumb: vi.fn(),
      focusToolsLazyLoad: focusTools,
      createSidebarToolsController: vi.fn().mockResolvedValue(sidebarTools),
      warn: vi.fn(),
    });

    await host.preloadFocusModeAssets('intent');
    host.scheduleFocusModePreload('p1');
    await host.loadFocusSessionTriggerComponent();
    await host.loadBlackBoxRecorderComponent();

    expect(sidebarTools.preloadFocusModeAssets).toHaveBeenCalledWith('intent');
    expect(sidebarTools.scheduleFocusModePreload).toHaveBeenCalledWith('p1');
    expect(sidebarTools.loadFocusSessionTriggerComponent).toHaveBeenCalledTimes(1);
    expect(sidebarTools.loadBlackBoxRecorderComponent).toHaveBeenCalledTimes(1);
  });
});
