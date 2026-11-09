import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceShellActionsHostDelegate,
  WorkspaceShellActionsLazyLoadHostOptions,
} from './workspace-shell-actions-lazy-load-host.controller';
import {
  createWorkspaceShellInteractionActionsHostLoader,
} from './workspace-shell-interaction-actions-host-loader.factory';

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

describe('createWorkspaceShellInteractionActionsHostLoader', () => {
  it('creates the default actions lazy-load host lazily', async () => {
    const signOut = vi.fn().mockResolvedValue(undefined);
    const createActionsController = vi.fn().mockResolvedValue({
      signOut,
    } satisfies Partial<WorkspaceShellActionsHostDelegate>);
    const loadHost = createWorkspaceShellInteractionActionsHostLoader({
      options: createOptions({ createActionsController }),
    });

    expect(createActionsController).not.toHaveBeenCalled();

    const host = await loadHost();

    expect(createActionsController).not.toHaveBeenCalled();

    await host.signOut();

    expect(createActionsController).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
