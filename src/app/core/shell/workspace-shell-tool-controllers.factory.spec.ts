import { describe, expect, it, vi } from 'vitest';

import { createWorkspaceShellToolControllers } from './workspace-shell-tool-controllers.factory';
import type {
  WorkspaceShellToolLazyLoadDelegateOptions,
  WorkspaceShellToolLazyLoadDelegates,
} from './workspace-shell-tool-lazy-load-delegates.factory';

describe('createWorkspaceShellToolControllers', () => {
  it('wires tool lazy-load delegates and widget gate mutations through one shell boundary', async () => {
    const sidebarOpen = { set: vi.fn() };
    const sidebarPreload = vi.fn();
    const blackBoxService = {
      createDurably: vi.fn().mockResolvedValue({ ok: true } as const),
      markAsRead: vi.fn(() => ({ ok: true } as const)),
      markAsReadDurably: vi.fn().mockResolvedValue({ ok: true } as const),
      markAsCompleted: vi.fn(() => ({ ok: true } as const)),
      markAsCompletedDurably: vi.fn().mockResolvedValue({ ok: true } as const),
    };
    const logger = {
      info: vi.fn(),
    };
    const toast = {
      warning: vi.fn(),
    };
    const focusPrefs = {
      isBlackBoxEnabled: vi.fn(() => true),
    };
    const sentryLazyLoader = {
      addBreadcrumb: vi.fn(),
    };

    const controllers = createWorkspaceShellToolControllers({
      injector: {} as never,
      sidebarOpen,
      blackBoxService,
      toast,
      focusPrefs,
      sentryLazyLoader,
      logger,
      warn: vi.fn(),
      createSidebarToolsHost: async () => ({
        loadFocusSessionTriggerComponent: vi.fn(),
        loadBlackBoxRecorderComponent: vi.fn(),
        onToolsIntent: vi.fn(),
        onVoiceTranscribed: vi.fn(),
        preload: sidebarPreload,
        preloadFocusModeAssets: vi.fn(),
        scheduleFocusModePreload: vi.fn(),
        teardown: vi.fn(),
      }),
    });

    expect(controllers.toolTemplateBindings).toBe(
      controllers.toolLazyLoad.templateBindings,
    );
    expect(controllers.sidebarToolsLazyLoad).toBe(
      controllers.toolLazyLoad.sidebarToolsLazyLoad,
    );

    await controllers.widgetGateMutation.apply({
      intent: 'mark-gate-read',
      widgetGateEntryId: null,
    });

    await vi.waitFor(() => {
      expect(sidebarOpen.set).toHaveBeenCalledWith(true);
      expect(sidebarPreload).toHaveBeenCalledWith('intent');
    });
  });

  it('adapts shell services into tool lazy-load options', async () => {
    const toolLazyLoad = {
      focusToolsLazyLoad: { preload: vi.fn() },
      sidebarToolsLazyLoad: {
        loadFocusSessionTriggerComponent: vi.fn(),
        loadBlackBoxRecorderComponent: vi.fn(),
        onToolsIntent: vi.fn(),
        onVoiceTranscribed: vi.fn(),
        preload: vi.fn(),
        preloadFocusModeAssets: vi.fn(),
        scheduleFocusModePreload: vi.fn(),
        teardown: vi.fn(),
      },
      templateBindings: {
        focusSessionTriggerHost: vi.fn(),
        blackBoxRecorderHost: vi.fn(),
      },
    } as unknown as WorkspaceShellToolLazyLoadDelegates;
    let lazyOptions!: WorkspaceShellToolLazyLoadDelegateOptions;
    const toast = {
      warning: vi.fn(),
    };
    const focusPrefs = {
      isBlackBoxEnabled: vi.fn(() => true),
    };
    const sentryLazyLoader = {
      addBreadcrumb: vi.fn(),
    };

    createWorkspaceShellToolControllers({
      injector: {} as never,
      sidebarOpen: { set: vi.fn() },
      blackBoxService: {
        createDurably: vi.fn().mockResolvedValue({ ok: true } as const),
        markAsRead: vi.fn(() => ({ ok: true } as const)),
        markAsReadDurably: vi.fn().mockResolvedValue({ ok: true } as const),
        markAsCompleted: vi.fn(() => ({ ok: true } as const)),
        markAsCompletedDurably: vi.fn().mockResolvedValue({ ok: true } as const),
      },
      toast,
      focusPrefs,
      sentryLazyLoader,
      logger: { info: vi.fn() },
      warn: vi.fn(),
      createToolLazyLoadDelegates: vi.fn(options => {
        lazyOptions = options;
        return toolLazyLoad;
      }),
    });

    lazyOptions.warning('Tools', 'preload skipped');
    const breadcrumb = {
      category: 'tools',
      message: 'preload',
      level: 'info' as const,
      data: { reason: 'intent' as const },
    };

    lazyOptions.addBreadcrumb(breadcrumb);

    expect(toast.warning).toHaveBeenCalledWith('Tools', 'preload skipped');
    expect(lazyOptions.dynamicLoadEnabled()).toBe(true);
    expect(lazyOptions.isBlackBoxEnabled()).toBe(true);
    expect(focusPrefs.isBlackBoxEnabled).toHaveBeenCalledTimes(1);
    expect(sentryLazyLoader.addBreadcrumb).toHaveBeenCalledWith(breadcrumb);
  });
});
