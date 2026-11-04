import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createWorkspaceShellInteractionActionsHost,
  type WorkspaceShellInteractionActionsHostOptions,
} from './workspace-shell-interaction-actions-host.factory';
import type {
  WorkspaceShellActionsInteractionDelegate,
} from './workspace-shell-interaction-lazy-load-delegates.factory';
import type { ProjectUiOwner } from '../../../services/task-operation-trash-adapter.controller';

function createActionsDelegate(): WorkspaceShellActionsInteractionDelegate {
  return {
    closeMigrationModal: vi.fn(),
    confirmCreateProject: vi.fn(),
    handleImportComplete: vi.fn(),
    handleLocalModeFromModal: vi.fn(),
    handleLoginFromModal: vi.fn(),
    handleMigrationComplete: vi.fn(),
    handleResetPasswordFromModal: vi.fn(),
    handleSignupFromModal: vi.fn(),
    setupDocumentClickListener: vi.fn(),
    signOut: vi.fn(),
    teardown: vi.fn(),
    updateTheme: vi.fn(),
  } as unknown as WorkspaceShellActionsInteractionDelegate;
}

function createOptions(
  overrides: Partial<WorkspaceShellInteractionActionsHostOptions> = {},
): WorkspaceShellInteractionActionsHostOptions {
  return {
    authModal: {} as never,
    getDocument: () => undefined,
    warn: vi.fn(),
    ...overrides,
  } as WorkspaceShellInteractionActionsHostOptions;
}

function createDefaultPathOptions(modalCoord: WorkspaceShellInteractionActionsHostOptions['modalCoord']) {
  return createOptions({
    activeProjectId: () => 'project-a',
    authCoord: {} as never,
    checkGateForMobileProjectEntry: vi.fn(),
    dockEngine: { setDockExpanded: vi.fn() },
    modalCoord,
    parkingService: { previewTask: vi.fn() },
    preferenceService: {} as never,
    projectCoord: {
      cancelRenameProject: vi.fn(), confirmCreateProject: vi.fn(), confirmDeleteProject: vi.fn(),
      enterProject: vi.fn(), executeRenameProject: vi.fn(), handleGlobalClick: vi.fn(),
      handleImportComplete: vi.fn(), handleProjectDoubleClick: vi.fn(),
      isEditingDescription: { set: vi.fn() }, onFocusFlowNode: vi.fn(),
      onProjectCardClick: vi.fn(), onRenameKeydown: vi.fn(), projectDraft: vi.fn(),
      renameProjectName: { set: vi.fn() }, saveProjectDetails: vi.fn(),
      selectProject: vi.fn(), startRenameProject: vi.fn(), updateProjectDraft: vi.fn(),
    },
    searchController: {} as never,
    searchLazyLoad: {} as never,
    sidebarOpen: { set: vi.fn() },
    signOutController: {} as never,
    storageEscape: { close: vi.fn() },
    taskStore: { getTaskProjectId: vi.fn() },
    toast: { info: vi.fn() },
    uiState: {} as never,
    userSession: {
      isHintOnlyStartupPlaceholderVisible: () => false,
      switchActiveProject: vi.fn(),
    },
  });
}

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

describe('createWorkspaceShellInteractionActionsHost', () => {
  it.each([
    ['A -> B', { projectId: 'project-b', generation: 2 }],
    ['A -> B -> A', { projectId: 'project-a', generation: 3 }],
    ['duplicate A', { projectId: 'project-a', generation: 1 }],
  ])('captures the trash owner before the first dynamic import for %s', async (_label, finalOwner) => {
    const clickedOwner: ProjectUiOwner = Object.freeze({ projectId: 'project-a', generation: 1 });
    let currentOwner: ProjectUiOwner = clickedOwner;
    const captureProjectUiOwner = vi.fn(() => currentOwner);
    const openTrashModal = vi.fn().mockResolvedValue(undefined);
    const modalCoord = {
      cancelConflictResolution: vi.fn(), closeSettings: vi.fn(),
      openConfigHelpModal: vi.fn(), openDashboard: vi.fn(),
      openDashboardFromSettings: vi.fn(), openErrorRecoveryModal: vi.fn(),
      openLoginModal: vi.fn(), openMigrationModal: vi.fn(), openNewProjectModal: vi.fn(),
      openStorageEscapeModalImperative: vi.fn(), openTrashModal,
      openConflictCenterFromDashboard: vi.fn(), resolveConflictLocal: vi.fn(),
      resolveConflictMerge: vi.fn(), resolveConflictRemote: vi.fn(), openSettings: vi.fn(),
      captureProjectUiOwner,
    };
    const host = createWorkspaceShellInteractionActionsHost(
      createDefaultPathOptions(modalCoord),
    );

    const completion = host.openTrashModal();
    const captureCountBeforeSwitch = captureProjectUiOwner.mock.calls.length;
    currentOwner = finalOwner;
    await completion;

    expect(captureCountBeforeSwitch).toBe(1);
    expect(captureProjectUiOwner).toHaveBeenCalledTimes(1);
    expect(openTrashModal).toHaveBeenCalledWith(clickedOwner);
    expect(openTrashModal.mock.calls[0]?.[0]).toBe(clickedOwner);
  });

  it.each([
    ['A -> B', { projectId: 'project-b', generation: 2 }],
    ['A -> B -> A', { projectId: 'project-a', generation: 3 }],
    ['duplicate A', { projectId: 'project-a', generation: 1 }],
  ])('captures the delete owner before the first dynamic import for %s', async (_label, finalOwner) => {
    const clickedOwner: ProjectUiOwner = Object.freeze({ projectId: 'project-a', generation: 1 });
    let currentOwner: ProjectUiOwner = clickedOwner;
    const captureProjectUiOwner = vi.fn(() => currentOwner);
    const modalCoord = {
      cancelConflictResolution: vi.fn(), closeSettings: vi.fn(), openConfigHelpModal: vi.fn(),
      openDashboard: vi.fn(), openDashboardFromSettings: vi.fn(), openErrorRecoveryModal: vi.fn(),
      openLoginModal: vi.fn(), openMigrationModal: vi.fn(), openNewProjectModal: vi.fn(),
      openStorageEscapeModalImperative: vi.fn(), openTrashModal: vi.fn(),
      openConflictCenterFromDashboard: vi.fn(), resolveConflictLocal: vi.fn(),
      resolveConflictMerge: vi.fn(), resolveConflictRemote: vi.fn(), openSettings: vi.fn(),
      captureProjectUiOwner,
    };
    const options = createDefaultPathOptions(modalCoord);
    const confirmDeleteProject = vi.mocked(options.projectCoord.confirmDeleteProject);
    const host = createWorkspaceShellInteractionActionsHost(options);
    const event = {} as Event;

    const completion = host.confirmDeleteProject('project-a', 'Project A', event);
    const captureCountBeforeSwitch = captureProjectUiOwner.mock.calls.length;
    currentOwner = finalOwner;
    await completion;

    expect(captureCountBeforeSwitch).toBe(1);
    expect(confirmDeleteProject).toHaveBeenCalledWith('project-a', 'Project A', event, clickedOwner);
    expect(confirmDeleteProject.mock.calls[0]?.[3]).toBe(clickedOwner);
  });

  it('uses the provided actions host without loading the default host', async () => {
    const actions = createActionsDelegate();
    const createActionsHost = vi.fn(() => actions);
    const host = createWorkspaceShellInteractionActionsHost(createOptions({
      createActionsHost,
    }));

    expect(createActionsHost).not.toHaveBeenCalled();

    await host.signOut();

    expect(createActionsHost).toHaveBeenCalledTimes(1);
    expect(actions.signOut).toHaveBeenCalledTimes(1);
  });

  it('routes action failures through the shared warn boundary', async () => {
    const error = new Error('action failed');
    const warn = vi.fn();
    const actions = createActionsDelegate();
    vi.mocked(actions.signOut).mockRejectedValue(error);
    const host = createWorkspaceShellInteractionActionsHost(createOptions({
      createActionsHost: () => actions,
      warn,
    }));

    await host.signOut();

    expect(warn).toHaveBeenCalledWith(
      '工作区操作执行失败，已跳过本次操作',
      error,
    );
  });

  it('keeps the concrete actions host behind a dynamic import', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-interaction-actions-host.factory.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellInteractionActionsHostLoader');
    expect(source).not.toContain("import('./workspace-shell-actions-lazy-load-host.controller')");
    expect(source).not.toContain('createWorkspaceShellActionsLazyLoadHost');
  });
});
