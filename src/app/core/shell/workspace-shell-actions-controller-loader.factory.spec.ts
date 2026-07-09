import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellActionsControllerLoader,
} from './workspace-shell-actions-controller-loader.factory';
import type {
  WorkspaceShellActionsControllerOptions,
} from './workspace-shell-actions.controller';
import type {
  WorkspaceShellActionsHostDelegate,
} from './workspace-shell-actions-lazy-load-host.controller';

function createActionsDelegate(): WorkspaceShellActionsHostDelegate {
  return {
    openSettings: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkspaceShellActionsHostDelegate;
}

function createOptions(
  overrides: Partial<WorkspaceShellActionsControllerOptions> = {},
): WorkspaceShellActionsControllerOptions {
  return {
    authCoord: {} as never,
    authModal: {} as never,
    signOutController: {} as never,
    storageEscape: { close: vi.fn() },
    modalCoord: {} as never,
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
    sidebarOpen: signal(false),
    userSession: {
      isHintOnlyStartupPlaceholderVisible: vi.fn(() => false),
      switchActiveProject: vi.fn(),
    },
    toast: { info: vi.fn() },
    taskStore: { getTaskProjectId: vi.fn() },
    activeProjectId: vi.fn(() => null),
    checkGateForMobileProjectEntry: vi.fn(),
    dockEngine: { setDockExpanded: vi.fn() },
    parkingService: { previewTask: vi.fn() },
    preferenceService: { setTheme: vi.fn().mockResolvedValue(undefined) },
    uiState: {
      layoutDirection: signal<'ltr' | 'rtl'>('ltr'),
      floatingWindowPref: signal<'auto' | 'fixed'>('auto'),
      filterMode: signal('all'),
    },
    searchLazyLoad: { ensureLoaded: vi.fn() },
    searchController: {
      clear: vi.fn(),
      update: vi.fn(),
    },
    ...overrides,
  };
}

describe('createWorkspaceShellActionsControllerLoader', () => {
  it('uses the provided actions controller loader', async () => {
    const actions = createActionsDelegate();
    const createActionsController = vi.fn().mockResolvedValue(actions);
    const loadController = createWorkspaceShellActionsControllerLoader({
      ...createOptions(),
      createActionsController,
    });

    await expect(loadController()).resolves.toBe(actions);

    expect(createActionsController).toHaveBeenCalledOnce();
  });

  it('creates the default actions controller lazily', async () => {
    const options = createOptions();
    const loadController = createWorkspaceShellActionsControllerLoader(options);

    const controller = await loadController();
    controller.updateTheme('ocean');

    expect(options.preferenceService.setTheme).toHaveBeenCalledWith('ocean');
  });
});
