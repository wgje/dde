import type { Project } from '../../../models';
import type { ActiveProjectOwner } from '../../../services/project-state.service';

import { readWorkspaceTextInputValue } from './workspace-shell-search.controller';

export type WorkspaceShellSignalSetter<T> = {
  set(value: T): void;
};

export interface WorkspaceShellProjectMutationCoordinatorLike {
  startRenameProject(projectId: string, currentName: string, event: Event): void;
  executeRenameProject(): void | Promise<void>;
  cancelRenameProject(): void;
  onRenameKeydown(event: KeyboardEvent): void;
  projectDraft(projectId: string): unknown;
  updateProjectDraft(
    projectId: string,
    field: 'description' | 'createdDate',
    value: string,
  ): void;
  saveProjectDetails(projectId: string): void | Promise<void>;
  confirmCreateProject(name: string, desc: string): Promise<void>;
  confirmDeleteProject(
    projectId: string,
    projectName: string,
    event: Event,
    owner: ActiveProjectOwner,
  ): Promise<void>;
  handleImportComplete(project: Project): Promise<void>;
  renameProjectName: WorkspaceShellSignalSetter<string>;
  isEditingDescription: WorkspaceShellSignalSetter<boolean>;
}

export interface WorkspaceShellProjectMutationControllerOptions {
  modalCoord: {
    openNewProjectModal(): Promise<void>;
  };
  projectCoord: WorkspaceShellProjectMutationCoordinatorLike;
  isHintOnlyStartupPlaceholderVisible(): boolean;
  toast: {
    info(title: string, message: string): void;
  };
}

export class WorkspaceShellProjectMutationController {
  constructor(private readonly options: WorkspaceShellProjectMutationControllerOptions) {}

  startProjectDescriptionEdit(event: Event): void {
    event.stopPropagation();
    if (this.blockHintOnlyMutation('编辑项目简介')) return;
    this.options.projectCoord.isEditingDescription.set(true);
  }

  startRenameProject(projectId: string, currentName: string, event: Event): void {
    if (this.blockHintOnlyMutation('重命名项目')) return;
    this.options.projectCoord.startRenameProject(projectId, currentName, event);
  }

  executeRenameProject(): void {
    void this.options.projectCoord.executeRenameProject();
  }

  cancelRenameProject(): void {
    this.options.projectCoord.cancelRenameProject();
  }

  onRenameKeydown(event: KeyboardEvent): void {
    this.options.projectCoord.onRenameKeydown(event);
  }

  projectDraft(projectId: string): unknown {
    return this.options.projectCoord.projectDraft(projectId);
  }

  updateProjectDraft(
    projectId: string,
    field: 'description' | 'createdDate',
    value: string,
  ): void {
    if (this.options.isHintOnlyStartupPlaceholderVisible()) return;
    this.options.projectCoord.updateProjectDraft(projectId, field, value);
  }

  saveProjectDetails(projectId: string): void {
    void this.options.projectCoord.saveProjectDetails(projectId);
  }

  createNewProject(): void {
    if (this.blockHintOnlyMutation('创建项目')) return;
    void this.options.modalCoord.openNewProjectModal();
  }

  confirmCreateProject(name: string, desc: string): Promise<void> {
    return this.options.projectCoord.confirmCreateProject(name, desc);
  }

  async confirmDeleteProject(
    projectId: string,
    projectName: string,
    event: Event,
    owner?: ActiveProjectOwner,
  ): Promise<void> {
    if (this.blockHintOnlyMutation('删除项目')) return;
    if (!owner || owner.projectId !== projectId) return;
    await this.options.projectCoord.confirmDeleteProject(projectId, projectName, event, owner);
  }

  async handleImportComplete(project: Project): Promise<void> {
    if (this.blockHintOnlyMutation('导入项目')) return;
    await this.options.projectCoord.handleImportComplete(project);
  }

  onRenameProjectNameInput(event: Event): void {
    this.options.projectCoord.renameProjectName.set(readWorkspaceTextInputValue(event));
  }

  onProjectDescriptionInput(projectId: string, event: Event): void {
    this.updateProjectDraft(projectId, 'description', readWorkspaceTextInputValue(event));
  }

  blockHintOnlyMutation(actionLabel: string): boolean {
    if (!this.options.isHintOnlyStartupPlaceholderVisible()) {
      return false;
    }

    this.options.toast.info('会话确认中', `${actionLabel}暂不可用，owner 确认完成前保持只读`);
    return true;
  }
}
