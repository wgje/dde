import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellSidebarToolsController } from './workspace-shell-sidebar-tools.controller';

function createController(options: {
  blackBoxEnabled?: boolean;
  dynamicLoadEnabled?: boolean;
  createResult?: { ok: true } | { ok: false; error: { message: string } };
} = {}) {
  const createBlackBoxEntry = vi.fn().mockResolvedValue(options.createResult ?? ({ ok: true } as const));
  const warning = vi.fn();
  const loadFocusSessionTrigger = vi.fn().mockResolvedValue(null);
  const loadBlackBoxRecorder = vi.fn().mockResolvedValue(null);
  const preloadFocusMode = vi.fn().mockResolvedValue(undefined);
  const scheduleFocusModePreload = vi.fn();
  const addBreadcrumb = vi.fn();
  const controller = new WorkspaceShellSidebarToolsController({
    createBlackBoxEntry,
    warning,
    dynamicLoadEnabled: () => options.dynamicLoadEnabled ?? true,
    isBlackBoxEnabled: () => options.blackBoxEnabled ?? false,
    loadFocusSessionTrigger,
    loadBlackBoxRecorder,
    preloadFocusMode,
    scheduleFocusModePreload,
    addBreadcrumb,
  });

  return {
    addBreadcrumb,
    controller,
    createBlackBoxEntry,
    loadBlackBoxRecorder,
    loadFocusSessionTrigger,
    preloadFocusMode,
    scheduleFocusModePreload,
    warning,
  };
}

describe('WorkspaceShellSidebarToolsController', () => {
  it('saves trimmed sidebar voice transcription into black box', async () => {
    const { controller, createBlackBoxEntry, warning } = createController();

    await controller.onVoiceTranscribed('  capture this  ');

    expect(createBlackBoxEntry).toHaveBeenCalledWith('capture this');
    expect(warning).not.toHaveBeenCalled();
  });

  it('skips blank sidebar voice transcription', () => {
    const { controller, createBlackBoxEntry } = createController();

    controller.onVoiceTranscribed('   ');

    expect(createBlackBoxEntry).not.toHaveBeenCalled();
  });

  it('shows a warning when sidebar transcription cannot be saved', async () => {
    const { controller, warning } = createController({
      createResult: { ok: false, error: { message: 'idb unavailable' } },
    });

    await controller.onVoiceTranscribed('note');

    expect(warning).toHaveBeenCalledWith('录音保存失败', 'idb unavailable');
  });

  it('ignores sidebar tools intent when dynamic loading is disabled', () => {
    const { controller, loadFocusSessionTrigger, preloadFocusMode } = createController({
      dynamicLoadEnabled: false,
    });

    controller.onToolsIntent();

    expect(loadFocusSessionTrigger).not.toHaveBeenCalled();
    expect(preloadFocusMode).not.toHaveBeenCalled();
  });

  it('preloads focus tools and optional black box recorder with a breadcrumb', () => {
    const {
      addBreadcrumb,
      controller,
      loadBlackBoxRecorder,
      loadFocusSessionTrigger,
      preloadFocusMode,
    } = createController({
      blackBoxEnabled: true,
    });

    controller.preload('intent');

    expect(loadFocusSessionTrigger).toHaveBeenCalled();
    expect(preloadFocusMode).toHaveBeenCalledWith('intent');
    expect(loadBlackBoxRecorder).toHaveBeenCalled();
    expect(addBreadcrumb).toHaveBeenCalledWith({
      category: 'startup',
      message: 'sidebar.tools.preload',
      level: 'info',
      data: { reason: 'intent' },
    });
  });

  it('delegates scheduled focus mode preload', () => {
    const { controller, scheduleFocusModePreload } = createController();

    controller.scheduleFocusModePreload('startup');

    expect(scheduleFocusModePreload).toHaveBeenCalledWith('startup');
  });
});
