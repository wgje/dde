import { describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../models';
import type { ActiveProjectOwner } from '../../../services/project-state.service';
import {
  WorkspaceShellProjectMutationController,
  type WorkspaceShellProjectMutationControllerOptions,
} from './workspace-shell-project-mutation.controller';

function createOptions(
  overrides: Partial<WorkspaceShellProjectMutationControllerOptions> = {},
): WorkspaceShellProjectMutationControllerOptions {
  return {
    isHintOnlyStartupPlaceholderVisible: () => false,
    modalCoord: {
      openNewProjectModal: vi.fn().mockResolvedValue(undefined),
    },
    projectCoord: {
      cancelRenameProject: vi.fn(),
      confirmCreateProject: vi.fn().mockResolvedValue(undefined),
      confirmDeleteProject: vi.fn().mockResolvedValue(undefined),
      executeRenameProject: vi.fn(),
      handleImportComplete: vi.fn().mockResolvedValue(undefined),
      isEditingDescription: { set: vi.fn() },
      onRenameKeydown: vi.fn(),
      projectDraft: vi.fn(() => null),
      renameProjectName: { set: vi.fn() },
      saveProjectDetails: vi.fn(),
      startRenameProject: vi.fn(),
      updateProjectDraft: vi.fn(),
    },
    toast: {
      info: vi.fn(),
    },
    ...overrides,
  };
}

function createProject(): Project {
  return {
    id: 'project-1',
    name: 'Project',
    description: '',
    createdDate: '2026-07-14',
    tasks: [],
    connections: [],
  };
}

describe('WorkspaceShellProjectMutationController', () => {
  it('blocks hint-only mutations but keeps coordinator cleanup actions available', async () => {
    const options = createOptions({
      isHintOnlyStartupPlaceholderVisible: () => true,
    });
    const controller = new WorkspaceShellProjectMutationController(options);
    const stopPropagation = vi.fn();

    controller.startProjectDescriptionEdit({ stopPropagation } as unknown as Event);
    controller.startRenameProject('project-1', 'Project', {} as Event);
    controller.updateProjectDraft('project-1', 'description', 'draft');
    controller.createNewProject();
    await controller.confirmDeleteProject('project-1', 'Project', {} as Event);
    await controller.handleImportComplete(createProject());
    controller.executeRenameProject();
    controller.saveProjectDetails('project-1');

    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(options.projectCoord.isEditingDescription.set).not.toHaveBeenCalled();
    expect(options.projectCoord.startRenameProject).not.toHaveBeenCalled();
    expect(options.projectCoord.updateProjectDraft).not.toHaveBeenCalled();
    expect(options.modalCoord.openNewProjectModal).not.toHaveBeenCalled();
    expect(options.projectCoord.confirmDeleteProject).not.toHaveBeenCalled();
    expect(options.projectCoord.handleImportComplete).not.toHaveBeenCalled();
    expect(options.projectCoord.executeRenameProject).toHaveBeenCalledTimes(1);
    expect(options.projectCoord.saveProjectDetails).toHaveBeenCalledWith('project-1');
    expect(options.toast.info).toHaveBeenCalledWith(
      '会话确认中',
      '编辑项目简介暂不可用，owner 确认完成前保持只读',
    );
  });

  it('delegates writable project mutations to their owning coordinators', async () => {
    const options = createOptions();
    const controller = new WorkspaceShellProjectMutationController(options);
    const editEvent = { stopPropagation: vi.fn() } as unknown as Event;
    const renameEvent = {} as Event;
    const deleteEvent = {} as Event;
    const deleteOwner: ActiveProjectOwner = Object.freeze({ projectId: 'project-1', generation: 3 });
    const project = createProject();

    controller.startProjectDescriptionEdit(editEvent);
    controller.startRenameProject('project-1', 'Project', renameEvent);
    controller.createNewProject();
    await controller.confirmCreateProject('Project', 'Description');
    await controller.confirmDeleteProject('project-1', 'Project', deleteEvent, deleteOwner);
    await controller.handleImportComplete(project);

    expect(options.projectCoord.isEditingDescription.set).toHaveBeenCalledWith(true);
    expect(options.projectCoord.startRenameProject).toHaveBeenCalledWith(
      'project-1',
      'Project',
      renameEvent,
    );
    expect(options.modalCoord.openNewProjectModal).toHaveBeenCalledTimes(1);
    expect(options.projectCoord.confirmCreateProject).toHaveBeenCalledWith(
      'Project',
      'Description',
    );
    expect(options.projectCoord.confirmDeleteProject).toHaveBeenCalledWith(
      'project-1',
      'Project',
      deleteEvent,
      deleteOwner,
    );
    expect(options.projectCoord.handleImportComplete).toHaveBeenCalledWith(project);
  });

  it('rejects an ownerless delete relay instead of falling back to the active project', async () => {
    const options = createOptions();
    const controller = new WorkspaceShellProjectMutationController(options);

    await controller.confirmDeleteProject('project-1', 'Project', {} as Event);

    expect(options.projectCoord.confirmDeleteProject).not.toHaveBeenCalled();
  });

  it('writes project form input values through the project coordinator', () => {
    const options = createOptions();
    const controller = new WorkspaceShellProjectMutationController(options);

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

  it('exposes rename and draft coordinator state without applying mutation guards', () => {
    const projectDraft = { description: 'Draft' };
    const options = createOptions({
      projectCoord: {
        ...createOptions().projectCoord,
        projectDraft: vi.fn(() => projectDraft),
      },
    });
    const controller = new WorkspaceShellProjectMutationController(options);
    const keyboardEvent = {} as KeyboardEvent;

    controller.cancelRenameProject();
    controller.onRenameKeydown(keyboardEvent);

    expect(controller.projectDraft('project-1')).toBe(projectDraft);
    expect(options.projectCoord.cancelRenameProject).toHaveBeenCalledTimes(1);
    expect(options.projectCoord.onRenameKeydown).toHaveBeenCalledWith(keyboardEvent);
  });
});
