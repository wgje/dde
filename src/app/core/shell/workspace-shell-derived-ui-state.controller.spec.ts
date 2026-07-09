import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';

import {
  WorkspaceShellDerivedUiStateController,
  type WorkspaceShellDerivedUiStateControllerOptions,
} from './workspace-shell-derived-ui-state.controller';

function createController(
  overrides: Partial<WorkspaceShellDerivedUiStateControllerOptions> = {},
) {
  const filterId = signal('all');
  const tasks = new Map([
    ['task-1', { title: 'Focus plan', displayId: 'T-1' }],
    ['task-2', { title: '', displayId: 'T-2' }],
  ]);
  const deleteProjectOpen = signal(false);
  const deleteProjectData = signal<
    { projectId: string; projectName: string } | undefined
  >(undefined);
  const authLoginRequired = signal(false);
  const handoffLoginRequired = signal(false);

  const controller = new WorkspaceShellDerivedUiStateController({
    filterId: () => filterId(),
    getTask: (taskId) => tasks.get(taskId),
    isDeleteProjectModalOpen: () => deleteProjectOpen(),
    getDeleteProjectData: () => deleteProjectData(),
    isAuthLoginRequired: () => authLoginRequired(),
    isHandoffLoginRequired: () => handoffLoginRequired(),
    ...overrides,
  });

  return {
    authLoginRequired,
    controller,
    deleteProjectData,
    deleteProjectOpen,
    filterId,
    handoffLoginRequired,
  };
}

describe('WorkspaceShellDerivedUiStateController', () => {
  it('resolves the current filter label from the active filter task', () => {
    const { controller, filterId } = createController();

    expect(controller.currentFilterLabel()).toBe('全部任务');

    filterId.set('task-1');
    expect(controller.currentFilterLabel()).toBe('Focus plan');

    filterId.set('task-2');
    expect(controller.currentFilterLabel()).toBe('T-2');

    filterId.set('missing-task');
    expect(controller.currentFilterLabel()).toBe('全部任务');
  });

  it('exposes delete-project modal visibility and target data', () => {
    const { controller, deleteProjectData, deleteProjectOpen } =
      createController();

    expect(controller.showDeleteProjectModal()).toBe(false);
    expect(controller.deleteProjectTarget()).toBeNull();

    deleteProjectOpen.set(true);
    deleteProjectData.set({
      projectId: 'project-1',
      projectName: 'Launch',
    });

    expect(controller.showDeleteProjectModal()).toBe(true);
    expect(controller.deleteProjectTarget()).toEqual({
      id: 'project-1',
      name: 'Launch',
    });
  });

  it('shows login required only when auth and handoff both require it', () => {
    const { authLoginRequired, controller, handoffLoginRequired } =
      createController();

    expect(controller.showLoginRequired()).toBe(false);

    authLoginRequired.set(true);
    expect(controller.showLoginRequired()).toBe(false);

    handoffLoginRequired.set(true);
    expect(controller.showLoginRequired()).toBe(true);
  });

  it('owns transient modal loading state for shell modal buttons', () => {
    const { controller } = createController();

    expect(controller.modalLoading()).toEqual({});

    controller.modalLoading.set({ login: true });

    expect(controller.modalLoading()).toEqual({ login: true });
  });
});
