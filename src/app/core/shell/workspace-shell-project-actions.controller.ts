import type { Project } from '../../../models';

import { readWorkspaceTextInputValue } from './workspace-shell-search.controller';

export type WorkspaceShellSignalSetter<T> = {
  set(value: T): void;
};

type SidebarOpenSignal = WorkspaceShellSignalSetter<boolean>;

type WorkspaceShellProjectCoordinatorLike = {
  selectProject(id: string, sidebarOpen: SidebarOpenSignal): void;
  onProjectCardClick(event: MouseEvent, projectId: string): void;
  handleGlobalClick(event: MouseEvent): void;
  enterProject(id: string, sidebarOpen: SidebarOpenSignal): void;
  handleProjectDoubleClick(id: string, event: MouseEvent, sidebarOpen: SidebarOpenSignal): void;
  startRenameProject(projectId: string, currentName: string, event: Event): void;
  executeRenameProject(): void | Promise<void>;
  cancelRenameProject(): void;
  onRenameKeydown(event: KeyboardEvent): void;
  projectDraft(projectId: string): unknown;
  updateProjectDraft(projectId: string, field: 'description' | 'createdDate', value: string): void;
  saveProjectDetails(projectId: string): void | Promise<void>;
  onFocusFlowNode(taskId: string): void;
  confirmCreateProject(name: string, desc: string): Promise<void>;
  confirmDeleteProject(projectId: string, projectName: string, event: Event): Promise<void>;
  handleImportComplete(project: Project): Promise<void>;
  renameProjectName: WorkspaceShellSignalSetter<string>;
  isEditingDescription: WorkspaceShellSignalSetter<boolean>;
};

export interface WorkspaceShellProjectActionsControllerOptions {
  modalCoord: {
    openNewProjectModal(): Promise<void>;
  };
  projectCoord: WorkspaceShellProjectCoordinatorLike;
  sidebarOpen: SidebarOpenSignal;
  userSession: {
    isHintOnlyStartupPlaceholderVisible(): boolean;
    switchActiveProject(projectId: string): void;
  };
  toast: {
    info(title: string, message: string): void;
  };
  taskStore: {
    getTaskProjectId(taskId: string): string | null;
  };
  activeProjectId(): string | null;
  checkGateForMobileProjectEntry(): void;
  dockEngine: {
    setDockExpanded(expanded: boolean, options: { persistPreference: boolean }): void | Promise<boolean>;
  };
  parkingService: {
    previewTask(taskId: string): void | Promise<boolean>;
  };
  waitForProjectSwitchTick?: () => Promise<void>;
}

const PROJECT_SWITCH_PREVIEW_WAIT_ATTEMPTS = 5;

export class WorkspaceShellProjectActionsController<
  TOptions extends WorkspaceShellProjectActionsControllerOptions = WorkspaceShellProjectActionsControllerOptions,
> {
  private parkedSearchPreviewGeneration = 0;

  constructor(protected readonly options: TOptions) {}

  selectProject(id: string): void {
    this.options.projectCoord.selectProject(id, this.options.sidebarOpen);
    this.options.checkGateForMobileProjectEntry();
  }

  onProjectCardClick(event: MouseEvent, projectId: string): void {
    this.options.projectCoord.onProjectCardClick(event, projectId);
  }

  onGlobalClick(event: MouseEvent): void {
    this.options.projectCoord.handleGlobalClick(event);
  }

  enterProject(id: string): void {
    this.options.projectCoord.enterProject(id, this.options.sidebarOpen);
    this.options.checkGateForMobileProjectEntry();
  }

  handleProjectDoubleClick(id: string, event: MouseEvent): void {
    if (this.options.userSession.isHintOnlyStartupPlaceholderVisible()) {
      event.preventDefault();
      event.stopPropagation();
      this.options.projectCoord.enterProject(id, this.options.sidebarOpen);
      this.options.checkGateForMobileProjectEntry();
      return;
    }

    this.options.projectCoord.handleProjectDoubleClick(id, event, this.options.sidebarOpen);
    this.options.checkGateForMobileProjectEntry();
  }

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

  updateProjectDraft(projectId: string, field: 'description' | 'createdDate', value: string): void {
    if (this.options.userSession.isHintOnlyStartupPlaceholderVisible()) return;
    this.options.projectCoord.updateProjectDraft(projectId, field, value);
  }

  saveProjectDetails(projectId: string): void {
    void this.options.projectCoord.saveProjectDetails(projectId);
  }

  createNewProject(): void {
    if (this.blockHintOnlyMutation('创建项目')) return;
    void this.options.modalCoord.openNewProjectModal();
  }

  onFocusFlowNode(taskId: string): void {
    this.options.projectCoord.onFocusFlowNode(taskId);
  }

  onSearchTaskClick(taskId: string, isParked: boolean): void {
    const projectId = this.options.taskStore.getTaskProjectId(taskId)
      ?? this.options.activeProjectId();
    const activeProjectId = this.options.activeProjectId();
    if (projectId && projectId !== activeProjectId) {
      this.options.userSession.switchActiveProject(projectId);
    }

    if (isParked) {
      const generation = ++this.parkedSearchPreviewGeneration;
      void this.previewParkedSearchTaskAfterProjectSwitch(taskId, projectId, activeProjectId, generation);
      return;
    }

    this.parkedSearchPreviewGeneration += 1;
    this.onFocusFlowNode(taskId);
  }

  private async previewParkedSearchTaskAfterProjectSwitch(
    taskId: string,
    projectId: string | null,
    activeProjectId: string | null,
    generation: number,
  ): Promise<void> {
    if (projectId && projectId !== activeProjectId) {
      const switched = await this.waitForActiveProject(projectId);
      if (!switched || generation !== this.parkedSearchPreviewGeneration) return;
    }

    if (generation !== this.parkedSearchPreviewGeneration) return;
    this.previewParkedSearchTask(taskId);
  }

  private previewParkedSearchTask(taskId: string): void {
    void this.options.dockEngine.setDockExpanded(true, { persistPreference: false });
    void this.options.parkingService.previewTask(taskId);
  }

  private async waitForActiveProject(projectId: string): Promise<boolean> {
    for (let attempt = 0; attempt < PROJECT_SWITCH_PREVIEW_WAIT_ATTEMPTS; attempt += 1) {
      await this.waitForProjectSwitchTick();
      if (this.options.activeProjectId() === projectId) {
        return true;
      }
    }
    return this.options.activeProjectId() === projectId;
  }

  private waitForProjectSwitchTick(): Promise<void> {
    return this.options.waitForProjectSwitchTick?.()
      ?? new Promise(resolve => setTimeout(resolve, 0));
  }

  confirmCreateProject(name: string, desc: string): Promise<void> {
    return this.options.projectCoord.confirmCreateProject(name, desc);
  }

  async confirmDeleteProject(projectId: string, projectName: string, event: Event): Promise<void> {
    if (this.blockHintOnlyMutation('删除项目')) return;
    await this.options.projectCoord.confirmDeleteProject(projectId, projectName, event);
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

  protected blockHintOnlyMutation(actionLabel: string): boolean {
    if (!this.options.userSession.isHintOnlyStartupPlaceholderVisible()) {
      return false;
    }

    this.options.toast.info('会话确认中', `${actionLabel}暂不可用，owner 确认完成前保持只读`);
    return true;
  }
}
