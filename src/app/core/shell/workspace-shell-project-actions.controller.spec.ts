import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellProjectActionsController,
  type WorkspaceShellProjectActionsControllerOptions,
} from './workspace-shell-project-actions.controller';

function createController(
  overrides: Partial<WorkspaceShellProjectActionsControllerOptions> = {},
) {
  const options: WorkspaceShellProjectActionsControllerOptions = {
    modalCoord: {
      openNewProjectModal: vi.fn().mockResolvedValue(undefined),
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
    ...overrides,
  };

  return {
    controller: new WorkspaceShellProjectActionsController(options),
    options,
  };
}

describe('WorkspaceShellProjectActionsController', () => {
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
    const stopPropagation = vi.fn();
    const { controller, options } = createController({
      userSession: {
        isHintOnlyStartupPlaceholderVisible: vi.fn(() => true),
        switchActiveProject: vi.fn(),
      },
    });

    controller.startProjectDescriptionEdit({ stopPropagation } as unknown as Event);
    controller.updateProjectDraft('project-1', 'description', 'draft');
    await controller.confirmDeleteProject('project-1', 'Project', {} as Event);
    controller.executeRenameProject();
    controller.saveProjectDetails('project-1');

    expect(stopPropagation).toHaveBeenCalledTimes(1);
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

  it('opens parked search results through the dock instead of focusing the flow node', () => {
    const { controller, options } = createController({
      taskStore: {
        getTaskProjectId: vi.fn(() => 'project-1'),
      },
      activeProjectId: vi.fn(() => 'project-1'),
    });

    controller.onSearchTaskClick('task-1', true);

    expect(options.userSession.switchActiveProject).not.toHaveBeenCalled();
    expect(options.dockEngine.setDockExpanded).toHaveBeenCalledWith(true, { persistPreference: false });
    expect(options.parkingService.previewTask).toHaveBeenCalledWith('task-1');
    expect(options.projectCoord.onFocusFlowNode).not.toHaveBeenCalled();
  });

  it('defers cross-project parked search preview until the target project is active', async () => {
    let activeProjectId = 'project-2';
    let resolveProjectSwitchTick!: () => void;
    const waitForProjectSwitchTick = vi.fn(() =>
      new Promise<void>(resolve => {
        resolveProjectSwitchTick = resolve;
      }),
    );
    const { controller, options } = createController({
      taskStore: {
        getTaskProjectId: vi.fn(() => 'project-1'),
      },
      activeProjectId: vi.fn(() => activeProjectId),
      waitForProjectSwitchTick,
    });

    controller.onSearchTaskClick('task-1', true);
    await Promise.resolve();

    expect(options.userSession.switchActiveProject).toHaveBeenCalledWith('project-1');
    expect(options.dockEngine.setDockExpanded).not.toHaveBeenCalled();
    expect(options.parkingService.previewTask).not.toHaveBeenCalled();

    activeProjectId = 'project-1';
    resolveProjectSwitchTick();

    await vi.waitFor(() => {
      expect(options.dockEngine.setDockExpanded).toHaveBeenCalledWith(true, { persistPreference: false });
    });
    expect(options.parkingService.previewTask).toHaveBeenCalledWith('task-1');
    expect(options.projectCoord.onFocusFlowNode).not.toHaveBeenCalled();
  });

  it('ignores a stale parked search preview when a newer search result is clicked', async () => {
    let activeProjectId = 'project-0';
    const pendingTicks: Array<() => void> = [];
    const waitForProjectSwitchTick = vi.fn(() =>
      new Promise<void>(resolve => {
        pendingTicks.push(resolve);
      }),
    );
    const { controller, options } = createController({
      taskStore: {
        getTaskProjectId: vi.fn((taskId: string) =>
          taskId === 'task-old' ? 'project-old' : 'project-new',
        ),
      },
      activeProjectId: vi.fn(() => activeProjectId),
      waitForProjectSwitchTick,
    });

    controller.onSearchTaskClick('task-old', true);
    await Promise.resolve();
    controller.onSearchTaskClick('task-new', true);
    await Promise.resolve();

    activeProjectId = 'project-old';
    pendingTicks[0]?.();
    await Promise.resolve();

    expect(options.parkingService.previewTask).not.toHaveBeenCalledWith('task-old');

    activeProjectId = 'project-new';
    pendingTicks[1]?.();

    await vi.waitFor(() => {
      expect(options.parkingService.previewTask).toHaveBeenCalledTimes(1);
    });
    expect(options.parkingService.previewTask).toHaveBeenCalledWith('task-new');
    expect(options.dockEngine.setDockExpanded).toHaveBeenCalledTimes(1);
  });

  it('writes project form input values through the project coordinator', () => {
    const { controller, options } = createController();

    controller.onRenameProjectNameInput({ target: { value: 'Renamed' } } as unknown as Event);
    controller.onProjectDescriptionInput('project-1', {
      target: { value: 'Description' },
    } as unknown as Event);

    expect(options.projectCoord.renameProjectName.set).toHaveBeenCalledWith('Renamed');
    expect(options.projectCoord.updateProjectDraft).toHaveBeenCalledWith(
      'project-1',
      'description',
      'Description',
    );
  });
});
