import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  WorkspaceShellActionsController,
  type WorkspaceShellActionsControllerOptions,
} from './workspace-shell-actions.controller';

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createController(
  overrides: Partial<WorkspaceShellActionsControllerOptions> = {},
) {
  const options: WorkspaceShellActionsControllerOptions = {
    authCoord: {
      retryBootstrap: vi.fn(),
      handleLogin: vi.fn().mockResolvedValue(undefined),
      handleSignup: vi.fn().mockResolvedValue(undefined),
      handleResetPassword: vi.fn().mockResolvedValue(undefined),
      switchToSignup: vi.fn(),
      switchToLogin: vi.fn(),
      switchToResetPassword: vi.fn(),
      startRelogin: vi.fn(),
      handleMigrationComplete: vi.fn(),
      closeMigrationModal: vi.fn(),
    },
    authModal: {
      handleLoginFromModal: vi.fn().mockResolvedValue(undefined),
      handleSignupFromModal: vi.fn().mockResolvedValue(undefined),
      handleResetPasswordFromModal: vi.fn().mockResolvedValue(undefined),
      handleLocalModeFromModal: vi.fn().mockResolvedValue(undefined),
    },
    signOutController: {
      signOut: vi.fn().mockResolvedValue(undefined),
    },
    storageEscape: {
      close: vi.fn(),
    },
    modalCoord: {
      resolveConflictLocal: vi.fn().mockResolvedValue(undefined),
      resolveConflictRemote: vi.fn().mockResolvedValue(undefined),
      resolveConflictMerge: vi.fn().mockResolvedValue(undefined),
      cancelConflictResolution: vi.fn(),
      openSettings: vi.fn().mockResolvedValue(undefined),
      closeSettings: vi.fn(),
      openDashboardFromSettings: vi.fn().mockResolvedValue(undefined),
      openDashboard: vi.fn().mockResolvedValue(undefined),
      openConflictCenterFromDashboard: vi.fn(),
      openLoginModal: vi.fn().mockResolvedValue(undefined),
      openTrashModal: vi.fn().mockResolvedValue(undefined),
      openConfigHelpModal: vi.fn().mockResolvedValue(undefined),
      openNewProjectModal: vi.fn().mockResolvedValue(undefined),
      openMigrationModal: vi.fn().mockResolvedValue(undefined),
      openErrorRecoveryModal: vi.fn().mockResolvedValue(undefined),
      openStorageEscapeModalImperative: vi.fn().mockResolvedValue(undefined),
    },
    projectCoord: {
      selectProject: vi.fn(),
      onProjectCardClick: vi.fn(),
      handleGlobalClick: vi.fn(),
      enterProject: vi.fn(),
      handleProjectDoubleClick: vi.fn(),
      startRenameProject: vi.fn(),
      executeRenameProject: vi.fn(),
      cancelRenameProject: vi.fn(),
      onRenameKeydown: vi.fn(),
      projectDraft: vi.fn(() => null),
      updateProjectDraft: vi.fn(),
      saveProjectDetails: vi.fn(),
      onFocusFlowNode: vi.fn(),
      confirmCreateProject: vi.fn().mockResolvedValue(undefined),
      confirmDeleteProject: vi.fn().mockResolvedValue(undefined),
      handleImportComplete: vi.fn().mockResolvedValue(undefined),
      renameProjectName: { set: vi.fn() },
      isEditingDescription: { set: vi.fn() },
    },
    sidebarOpen: signal(false),
    userSession: {
      isHintOnlyStartupPlaceholderVisible: vi.fn(() => false),
      switchActiveProject: vi.fn(),
    },
    toast: {
      info: vi.fn(),
    },
    taskStore: {
      getTaskProjectId: vi.fn(() => null),
    },
    activeProjectId: vi.fn(() => null),
    checkGateForMobileProjectEntry: vi.fn(),
    dockEngine: {
      setDockExpanded: vi.fn(),
    },
    parkingService: {
      previewTask: vi.fn(),
    },
    preferenceService: {
      setTheme: vi.fn().mockResolvedValue(undefined),
    },
    uiState: {
      layoutDirection: signal<'ltr' | 'rtl'>('ltr'),
      floatingWindowPref: signal<'auto' | 'fixed'>('auto'),
      filterMode: signal('all'),
    },
    searchLazyLoad: {
      ensureLoaded: vi.fn(),
    },
    searchController: {
      update: vi.fn(),
      clear: vi.fn(),
    },
    ...overrides,
  };

  return {
    controller: new WorkspaceShellActionsController(options),
    options,
  };
}

describe('WorkspaceShellActionsController', () => {
  it('keeps auth action forwarding in WorkspaceShellAuthActionsController', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-actions.controller.ts'),
      'utf8',
    );

    expect(source).toContain('WorkspaceShellAuthActionsController');
    expect(source).toContain("from './workspace-shell-auth-actions.controller'");
    expect(source).not.toContain('this.options.authCoord.');
    expect(source).not.toContain('this.options.authModal.');
    expect(source).not.toContain('this.options.signOutController.');
  });

  it('opens a project and checks the mobile focus gate', () => {
    const { controller, options } = createController();

    controller.selectProject('project-1');
    controller.enterProject('project-2');

    expect(options.projectCoord.selectProject).toHaveBeenCalledWith('project-1', options.sidebarOpen);
    expect(options.projectCoord.enterProject).toHaveBeenCalledWith('project-2', options.sidebarOpen);
    expect(options.checkGateForMobileProjectEntry).toHaveBeenCalledTimes(2);
  });

  it('keeps hint-only double-click read-only while still entering the project', () => {
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const { controller, options } = createController({
      userSession: {
        isHintOnlyStartupPlaceholderVisible: vi.fn(() => true),
        switchActiveProject: vi.fn(),
      },
    });

    controller.handleProjectDoubleClick('project-1', {
      preventDefault,
      stopPropagation,
    } as unknown as MouseEvent);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(options.projectCoord.enterProject).toHaveBeenCalledWith('project-1', options.sidebarOpen);
    expect(options.projectCoord.handleProjectDoubleClick).not.toHaveBeenCalled();
    expect(options.checkGateForMobileProjectEntry).toHaveBeenCalledTimes(1);
  });

  it('blocks hint-only project mutations but still lets coordinator-only cleanup actions run', async () => {
    const { controller, options } = createController({
      userSession: {
        isHintOnlyStartupPlaceholderVisible: vi.fn(() => true),
        switchActiveProject: vi.fn(),
      },
    });

    controller.startProjectDescriptionEdit({ stopPropagation: vi.fn() } as unknown as Event);
    controller.updateProjectDraft('project-1', 'description', 'draft');
    await controller.confirmDeleteProject('project-1', 'Project', {} as Event);
    controller.executeRenameProject();
    controller.saveProjectDetails('project-1');

    expect(options.projectCoord.isEditingDescription.set).not.toHaveBeenCalled();
    expect(options.projectCoord.updateProjectDraft).not.toHaveBeenCalled();
    expect(options.projectCoord.confirmDeleteProject).not.toHaveBeenCalled();
    expect(options.projectCoord.executeRenameProject).toHaveBeenCalledTimes(1);
    expect(options.projectCoord.saveProjectDetails).toHaveBeenCalledWith('project-1');
    expect(options.toast.info).toHaveBeenCalledWith(
      '会话确认中',
      '编辑项目简介暂不可用，owner 确认完成前保持只读',
    );
  });

  it('opens parked search results through the dock after the target project becomes active', async () => {
    let activeProjectId = 'project-2';
    const projectSwitchTick = createDeferred<void>();
    const waitForProjectSwitchTick = vi.fn(() => new Promise<void>(resolve => {
      projectSwitchTick.promise.then(resolve);
    }));
    const { controller, options } = createController({
      taskStore: {
        getTaskProjectId: vi.fn(() => 'project-1'),
      },
      activeProjectId: vi.fn(() => activeProjectId),
      waitForProjectSwitchTick,
    });

    controller.onSearchTaskClick('task-1', true);
    activeProjectId = 'project-1';
    projectSwitchTick.resolve();
    await vi.waitFor(() => expect(options.parkingService.previewTask).toHaveBeenCalledWith('task-1'));

    expect(options.userSession.switchActiveProject).toHaveBeenCalledWith('project-1');
    expect(options.dockEngine.setDockExpanded).toHaveBeenCalledWith(true, { persistPreference: false });
    expect(options.projectCoord.onFocusFlowNode).not.toHaveBeenCalled();
  });

  it('updates theme without depending on the preference write return value', () => {
    const setTheme = vi.fn().mockResolvedValue(true);
    const { controller } = createController({
      preferenceService: { setTheme },
    });

    controller.updateTheme('ocean');

    expect(setTheme).toHaveBeenCalledWith('ocean');
  });

  it('lazy-loads search services only for non-empty queries', () => {
    const { controller, options } = createController();

    controller.onUnifiedSearchChange(' roadmap ');
    controller.onUnifiedSearchChange('   ');
    controller.clearUnifiedSearch();

    expect(options.searchLazyLoad.ensureLoaded).toHaveBeenCalledTimes(1);
    expect(options.searchController.update).toHaveBeenNthCalledWith(1, ' roadmap ');
    expect(options.searchController.update).toHaveBeenNthCalledWith(2, '   ');
    expect(options.searchController.clear).toHaveBeenCalledTimes(1);
  });
});
