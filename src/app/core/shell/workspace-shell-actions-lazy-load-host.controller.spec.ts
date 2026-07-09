import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createWorkspaceShellActionsLazyLoadHost,
  type WorkspaceShellActionsLazyLoadHostOptions,
} from './workspace-shell-actions-lazy-load-host.controller';

function createOptions(
  overrides: Partial<WorkspaceShellActionsLazyLoadHostOptions> = {},
): WorkspaceShellActionsLazyLoadHostOptions {
  return {
    activeProjectId: () => null,
    authCoord: {} as never,
    authModal: {} as never,
    checkGateForMobileProjectEntry: vi.fn(),
    createActionsController: vi.fn(),
    dockEngine: { setDockExpanded: vi.fn() },
    modalCoord: {} as never,
    parkingService: { previewTask: vi.fn() },
    preferenceService: {} as never,
    projectCoord: {
      cancelRenameProject: vi.fn(),
      confirmCreateProject: vi.fn(),
      confirmDeleteProject: vi.fn(),
      enterProject: vi.fn(),
      executeRenameProject: vi.fn(),
      handleGlobalClick: vi.fn(),
      handleImportComplete: vi.fn(),
      handleProjectDoubleClick: vi.fn(),
      isEditingDescription: { set: vi.fn() },
      onFocusFlowNode: vi.fn(),
      onProjectCardClick: vi.fn(),
      onRenameKeydown: vi.fn(),
      projectDraft: vi.fn(),
      renameProjectName: { set: vi.fn() },
      saveProjectDetails: vi.fn(),
      selectProject: vi.fn(),
      startRenameProject: vi.fn(),
      updateProjectDraft: vi.fn(),
    },
    searchController: {} as never,
    searchLazyLoad: {} as never,
    sidebarOpen: { set: vi.fn() },
    signOutController: {} as never,
    storageEscape: {} as never,
    taskStore: { getTaskProjectId: vi.fn() },
    toast: { info: vi.fn() },
    uiState: {} as never,
    userSession: {
      isHintOnlyStartupPlaceholderVisible: () => false,
      switchActiveProject: vi.fn(),
    },
    warn: vi.fn(),
    ...overrides,
  };
}

describe('createWorkspaceShellActionsLazyLoadHost', () => {
  it('delegates final actions controller resolution to the loader factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-actions-lazy-load-host.controller.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellActionsControllerLoader');
    expect(source).not.toContain("import('./workspace-shell-actions.controller')");
    expect(source).not.toContain('new WorkspaceShellActionsController');
  });

  it('keeps project action business rules in WorkspaceShellProjectActionsController', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-actions-lazy-load-host.controller.ts'),
      'utf8',
    );

    expect(source).toContain('extends WorkspaceShellProjectActionsController');
    expect(source).toContain("from './workspace-shell-project-actions.controller'");
    expect(source).not.toContain('private blockHintOnlyMutation');
    expect(source).not.toContain('owner 确认完成前保持只读');
  });

  it('keeps project edit actions synchronous without loading command controller', () => {
    const createActionsController = vi.fn();
    const options = createOptions({ createActionsController });
    const host = createWorkspaceShellActionsLazyLoadHost(options);
    const event = { stopPropagation: vi.fn() } as unknown as Event;

    host.startProjectDescriptionEdit(event);

    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(options.projectCoord.isEditingDescription.set).toHaveBeenCalledWith(true);
    expect(createActionsController).not.toHaveBeenCalled();
  });

  it('keeps create project read-only during hint-only startup without loading command controller', () => {
    const createActionsController = vi.fn();
    const options = createOptions({
      createActionsController,
      userSession: {
        isHintOnlyStartupPlaceholderVisible: () => true,
        switchActiveProject: vi.fn(),
      },
    });
    const host = createWorkspaceShellActionsLazyLoadHost(options);

    host.createNewProject();

    expect(createActionsController).not.toHaveBeenCalled();
    expect(options.toast.info).toHaveBeenCalledWith(
      '会话确认中',
      '创建项目暂不可用，owner 确认完成前保持只读',
    );
  });

  it('loads command controller only for deferred command methods', async () => {
    const openSettings = vi.fn();
    const createActionsController = vi.fn().mockResolvedValue({
      openSettings,
    });
    const host = createWorkspaceShellActionsLazyLoadHost(
      createOptions({ createActionsController }),
    );

    await host.openSettings();

    expect(createActionsController).toHaveBeenCalledTimes(1);
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it('warns and skips unknown deferred action names without lazy loading', async () => {
    const createActionsController = vi.fn().mockResolvedValue({
      openSettings: vi.fn(),
    });
    const options = createOptions({ createActionsController });
    const host = createWorkspaceShellActionsLazyLoadHost(options);

    await (host as unknown as Record<string, () => Promise<unknown>>).openSetings();

    expect(createActionsController).not.toHaveBeenCalled();
    expect(options.warn).toHaveBeenCalledWith(
      'Workspace shell actions controller 未知操作，已跳过本次操作',
      expect.objectContaining({
        method: 'openSetings',
      }),
    );
  });

  it('swallows warning sink failures while skipping unknown deferred action names', async () => {
    const createActionsController = vi.fn().mockResolvedValue({
      openSettings: vi.fn(),
    });
    const options = createOptions({ createActionsController });
    vi.mocked(options.warn).mockImplementationOnce(() => {
      throw new Error('warning sink failed');
    });
    const host = createWorkspaceShellActionsLazyLoadHost(options);

    await expect(
      (host as unknown as Record<string, () => Promise<unknown>>).openSetings(),
    ).resolves.toBeUndefined();

    expect(createActionsController).not.toHaveBeenCalled();
    expect(options.warn).toHaveBeenCalledWith(
      'Workspace shell actions controller 未知操作，已跳过本次操作',
      expect.objectContaining({
        method: 'openSetings',
      }),
    );
  });

  it('classifies loaded command action failures separately from lazy-load failures', async () => {
    const error = new Error('settings action failed');
    const openSettings = vi.fn().mockRejectedValue(error);
    const options = createOptions({
      createActionsController: vi.fn().mockResolvedValue({
        openSettings,
      }),
    });
    const host = createWorkspaceShellActionsLazyLoadHost(options);

    await host.openSettings();

    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(options.warn).toHaveBeenCalledWith(
      'Workspace shell actions controller 操作执行失败，已跳过本次操作',
      error,
    );
    expect(options.warn).not.toHaveBeenCalledWith(
      'Workspace shell actions controller 懒加载失败，已跳过本次操作',
      error,
    );
  });

  it('keeps lazy-load failures retryable and classified as load failures', async () => {
    const loadError = new Error('chunk failed');
    const openSettings = vi.fn();
    const createActionsController = vi.fn()
      .mockRejectedValueOnce(loadError)
      .mockResolvedValueOnce({ openSettings });
    const options = createOptions({ createActionsController });
    const host = createWorkspaceShellActionsLazyLoadHost(options);

    await host.openSettings();
    await host.openSettings();

    expect(createActionsController).toHaveBeenCalledTimes(2);
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(options.warn).toHaveBeenCalledWith(
      'Workspace shell actions controller 懒加载失败，已跳过本次操作',
      loadError,
    );
    expect(options.warn).not.toHaveBeenCalledWith(
      'Workspace shell actions controller 操作执行失败，已跳过本次操作',
      loadError,
    );
  });

  it('keeps synchronous lazy-load factory failures retryable and classified as load failures', async () => {
    const loadError = new Error('factory failed');
    const openSettings = vi.fn();
    const createActionsController = vi.fn()
      .mockImplementationOnce(() => {
        throw loadError;
      })
      .mockResolvedValueOnce({ openSettings });
    const options = createOptions({ createActionsController });
    const host = createWorkspaceShellActionsLazyLoadHost(options);

    await host.openSettings();
    await host.openSettings();

    expect(createActionsController).toHaveBeenCalledTimes(2);
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(options.warn).toHaveBeenCalledWith(
      'Workspace shell actions controller 懒加载失败，已跳过本次操作',
      loadError,
    );
    expect(options.warn).not.toHaveBeenCalledWith(
      'Workspace shell actions controller 操作执行失败，已跳过本次操作',
      loadError,
    );
  });

  it('does not run a pending deferred command after teardown', async () => {
    const openSettings = vi.fn();
    let resolveController!: (controller: { openSettings: typeof openSettings }) => void;
    const createActionsController = vi.fn().mockImplementation(() =>
      new Promise<{ openSettings: typeof openSettings }>(resolve => {
        resolveController = resolve;
      })
    );
    const host = createWorkspaceShellActionsLazyLoadHost(
      createOptions({ createActionsController }),
    );

    const command = host.openSettings();
    host.teardown();
    resolveController?.({ openSettings });
    await command;

    expect(openSettings).not.toHaveBeenCalled();
  });

  it('does not reuse or reload a deferred command controller that resolves after teardown', async () => {
    const openSettings = vi.fn();
    let resolveController!: (controller: { openSettings: typeof openSettings }) => void;
    const createActionsController = vi.fn().mockImplementation(() =>
      new Promise<{ openSettings: typeof openSettings }>(resolve => {
        resolveController = resolve;
      })
    );
    const host = createWorkspaceShellActionsLazyLoadHost(
      createOptions({ createActionsController }),
    );

    const command = host.openSettings();
    host.teardown();
    resolveController?.({ openSettings });
    await command;
    await host.openSettings();

    expect(openSettings).not.toHaveBeenCalled();
    expect(createActionsController).toHaveBeenCalledTimes(1);
  });

  it('classifies loaded command controller teardown failures separately from lazy-load failures', async () => {
    const teardownError = new Error('actions teardown failed');
    const openSettings = vi.fn();
    const teardown = vi.fn(() => {
      throw teardownError;
    });
    const options = createOptions({
      createActionsController: vi.fn().mockResolvedValue({
        openSettings,
        teardown,
      }),
    });
    const host = createWorkspaceShellActionsLazyLoadHost(options);

    await host.openSettings();
    host.teardown();

    expect(teardown).toHaveBeenCalledTimes(1);
    expect(options.warn).toHaveBeenCalledWith(
      'Workspace shell actions controller 清理失败，已跳过',
      teardownError,
    );
    expect(options.warn).not.toHaveBeenCalledWith(
      'Workspace shell actions controller 懒加载失败，已跳过本次操作',
      teardownError,
    );
  });

  it('continues teardown when removing the document click listener fails', async () => {
    const cleanupError = new Error('document click listener cleanup failed');
    const removeDocumentClickListener = vi.fn(() => {
      throw cleanupError;
    });
    const teardown = vi.fn();
    const openSettings = vi.fn();
    const options = createOptions({
      createActionsController: vi.fn().mockResolvedValue({ openSettings, teardown }),
      listenToDocument: vi.fn(() => removeDocumentClickListener),
    });
    const host = createWorkspaceShellActionsLazyLoadHost(options);

    host.setupDocumentClickListener();
    await host.openSettings();

    expect(() => host.teardown()).not.toThrow();

    expect(removeDocumentClickListener).toHaveBeenCalledTimes(1);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(options.warn).toHaveBeenCalledWith(
      'Workspace shell actions controller 文档点击监听清理失败，已继续清理',
      cleanupError,
    );
  });

  it('swallows warning sink failures while continuing document click listener teardown', async () => {
    const cleanupError = new Error('document click listener cleanup failed');
    const removeDocumentClickListener = vi.fn(() => {
      throw cleanupError;
    });
    const teardown = vi.fn();
    const openSettings = vi.fn();
    const options = createOptions({
      createActionsController: vi.fn().mockResolvedValue({ openSettings, teardown }),
      listenToDocument: vi.fn(() => removeDocumentClickListener),
    });
    vi.mocked(options.warn).mockImplementationOnce(() => {
      throw new Error('warning sink failed');
    });
    const host = createWorkspaceShellActionsLazyLoadHost(options);

    host.setupDocumentClickListener();
    await host.openSettings();

    expect(() => host.teardown()).not.toThrow();

    expect(removeDocumentClickListener).toHaveBeenCalledTimes(1);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(options.warn).toHaveBeenCalledWith(
      'Workspace shell actions controller 文档点击监听清理失败，已继续清理',
      cleanupError,
    );
  });

  it('replaces document click listener on repeated setup and removes it on teardown', () => {
    const removers: Array<ReturnType<typeof vi.fn>> = [];
    const listenToDocument = vi.fn((_eventName: string, _listener: EventListener) => {
      const remove = vi.fn();
      removers.push(remove);
      return remove;
    });
    const host = createWorkspaceShellActionsLazyLoadHost(
      createOptions({ listenToDocument }),
    );

    host.setupDocumentClickListener();
    host.setupDocumentClickListener();
    host.teardown();

    expect(listenToDocument).toHaveBeenCalledTimes(2);
    expect(removers[0]).toHaveBeenCalledTimes(1);
    expect(removers[1]).toHaveBeenCalledTimes(1);
  });

  it('does not register a document click listener after teardown', () => {
    const listenToDocument = vi.fn(() => vi.fn());
    const host = createWorkspaceShellActionsLazyLoadHost(
      createOptions({ listenToDocument }),
    );

    host.teardown();
    host.setupDocumentClickListener();

    expect(listenToDocument).not.toHaveBeenCalled();
  });
});
