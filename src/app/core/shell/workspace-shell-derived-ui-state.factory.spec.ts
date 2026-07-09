import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellDerivedUiStateController,
  type WorkspaceShellDerivedUiStateControllerOptions,
} from './workspace-shell-derived-ui-state.controller';
import {
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellInteractionSurfacesSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

type DerivedUiStateFactoryModule = {
  createWorkspaceShellDerivedUiStateController?: unknown;
};

async function loadFactoryModule(): Promise<DerivedUiStateFactoryModule> {
  try {
    const modulePath = './workspace-shell-derived-ui-state.factory';
    return await import(/* @vite-ignore */ modulePath) as DerivedUiStateFactoryModule;
  } catch {
    return {};
  }
}

describe('createWorkspaceShellDerivedUiStateController', () => {
  it('moves derived UI state adapter wiring out of WorkspaceShellComponent', () => {
    const componentSource = readWorkspaceShellSource();
    const graphSource = readWorkspaceShellControllerGraphSource();
    const interactionSurfacesSource = readWorkspaceShellInteractionSurfacesSource();

    expect(graphSource).toContain('createWorkspaceShellInteractionSurfaces');
    expect(graphSource).not.toContain('createWorkspaceShellDerivedUiStateController');
    expect(interactionSurfacesSource)
      .toContain('createWorkspaceShellDerivedUiStateController');
    expect(componentSource).not.toContain('new WorkspaceShellDerivedUiStateController');
    expect(componentSource).not.toContain('WorkspaceShellDeleteProjectData');
    expect(componentSource).not.toContain("modal.getData('deleteProject') as");
    expect(componentSource).not.toContain("handoffCoordinator.result().kind === 'login-required'");
    expect(graphSource).toContain('...context');
    expect(componentSource).not.toContain('filterId: () => this.uiState.filterMode()');
    expect(componentSource).not.toContain('getTask: (taskId) => this.projectState.getTask(taskId)');
  });

  it('adapts shell modal and login dependencies into derived UI state options', async () => {
    const { createWorkspaceShellDerivedUiStateController } =
      await loadFactoryModule();
    expect(createWorkspaceShellDerivedUiStateController).toBeTypeOf('function');
    const createDerivedUiState =
      createWorkspaceShellDerivedUiStateController as (
        options: {
          authCoord: { showLoginRequired: () => boolean };
          createController: (
            options: WorkspaceShellDerivedUiStateControllerOptions,
          ) => WorkspaceShellDerivedUiStateController;
          handoffCoordinator: { result: () => { kind: string } };
          modal: {
            getData: (id: 'deleteProject') => unknown;
            isOpen: (id: 'deleteProject') => boolean;
          };
          projectState: {
            getTask: WorkspaceShellDerivedUiStateControllerOptions['getTask'];
          };
          uiState: { filterMode: () => string };
        },
      ) => WorkspaceShellDerivedUiStateController;
    let controllerOptions!: WorkspaceShellDerivedUiStateControllerOptions;
    const createController = vi.fn((options) => {
      controllerOptions = options;
      return new WorkspaceShellDerivedUiStateController(options);
    });
    const uiState = {
      filterMode: vi.fn(() => 'all'),
    };
    const getTask = vi.fn();
    const projectState = {
      getTask,
    };
    const modal = {
      getData: vi.fn(() => ({
        projectId: 'project-1',
        projectName: 'Launch',
      })),
      isOpen: vi.fn(() => true),
    };
    const authCoord = {
      showLoginRequired: vi.fn(() => true),
    };
    const handoffCoordinator = {
      result: vi.fn(() => ({ kind: 'login-required' })),
    };

    const controller = createDerivedUiState({
      authCoord,
      createController,
      handoffCoordinator,
      modal,
      projectState,
      uiState,
    });

    expect(controller).toBeInstanceOf(WorkspaceShellDerivedUiStateController);
    expect(controllerOptions.filterId()).toBe('all');
    getTask.mockReturnValueOnce({ title: 'Focus task', displayId: 'T-1' });
    expect(controllerOptions.getTask('task-1')).toEqual({
      title: 'Focus task',
      displayId: 'T-1',
    });
    expect(getTask).toHaveBeenCalledWith('task-1');
    expect(controllerOptions.isDeleteProjectModalOpen()).toBe(true);
    expect(controllerOptions.getDeleteProjectData()).toEqual({
      projectId: 'project-1',
      projectName: 'Launch',
    });
    expect(controllerOptions.isAuthLoginRequired()).toBe(true);
    expect(controllerOptions.isHandoffLoginRequired()).toBe(true);
    expect(modal.isOpen).toHaveBeenCalledWith('deleteProject');
    expect(modal.getData).toHaveBeenCalledWith('deleteProject');
  });
});
