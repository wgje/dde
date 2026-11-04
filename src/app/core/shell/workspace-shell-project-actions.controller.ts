import { WorkspaceShellProjectSearchTaskController } from './workspace-shell-project-search-task.controller';
import type { ActiveProjectOwner } from '../../../services/project-state.service';
import {
  WorkspaceShellProjectMutationController,
  type WorkspaceShellProjectMutationCoordinatorLike,
  type WorkspaceShellSignalSetter,
} from './workspace-shell-project-mutation.controller';

export type {
  WorkspaceShellSignalSetter,
} from './workspace-shell-project-mutation.controller';

type SidebarOpenSignal = WorkspaceShellSignalSetter<boolean>;

type WorkspaceShellProjectCoordinatorLike = WorkspaceShellProjectMutationCoordinatorLike & {
  captureActiveProjectOwner?(): ActiveProjectOwner;
  selectProject(id: string, sidebarOpen: SidebarOpenSignal): void;
  onProjectCardClick(event: MouseEvent, projectId: string): void;
  handleGlobalClick(event: MouseEvent): void;
  enterProject(id: string, sidebarOpen: SidebarOpenSignal): void;
  handleProjectDoubleClick(id: string, event: MouseEvent, sidebarOpen: SidebarOpenSignal): void;
  onFocusFlowNode(taskId: string): void;
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
  projectMutation?: WorkspaceShellProjectMutationController;
}

export class WorkspaceShellProjectActionsController<
  TOptions extends WorkspaceShellProjectActionsControllerOptions = WorkspaceShellProjectActionsControllerOptions,
> {
  private readonly projectSearchTask: WorkspaceShellProjectSearchTaskController;
  private readonly projectMutation: WorkspaceShellProjectMutationController;

  constructor(protected readonly options: TOptions) {
    this.projectSearchTask = new WorkspaceShellProjectSearchTaskController({
      taskProjectId: taskId => options.taskStore.getTaskProjectId(taskId),
      activeProjectId: options.activeProjectId,
      switchActiveProject: projectId => options.userSession.switchActiveProject(projectId),
      focusFlowNode: taskId => options.projectCoord.onFocusFlowNode(taskId),
      setDockExpanded: (expanded, dockOptions) =>
        options.dockEngine.setDockExpanded(expanded, dockOptions),
      previewTask: taskId => options.parkingService.previewTask(taskId),
      waitForProjectSwitchTick: options.waitForProjectSwitchTick,
    });
    this.projectMutation = options.projectMutation
      ?? new WorkspaceShellProjectMutationController({
        isHintOnlyStartupPlaceholderVisible: () =>
          options.userSession.isHintOnlyStartupPlaceholderVisible(),
        modalCoord: options.modalCoord,
        projectCoord: options.projectCoord,
        toast: options.toast,
      });
  }

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
    this.projectMutation.startProjectDescriptionEdit(event);
  }

  startRenameProject(projectId: string, currentName: string, event: Event): void {
    this.projectMutation.startRenameProject(projectId, currentName, event);
  }

  executeRenameProject(): void {
    this.projectMutation.executeRenameProject();
  }

  cancelRenameProject(): void {
    this.projectMutation.cancelRenameProject();
  }

  onRenameKeydown(event: KeyboardEvent): void {
    this.projectMutation.onRenameKeydown(event);
  }

  projectDraft(projectId: string): unknown {
    return this.projectMutation.projectDraft(projectId);
  }

  updateProjectDraft(projectId: string, field: 'description' | 'createdDate', value: string): void {
    this.projectMutation.updateProjectDraft(projectId, field, value);
  }

  saveProjectDetails(projectId: string): void {
    this.projectMutation.saveProjectDetails(projectId);
  }

  createNewProject(): void {
    this.projectMutation.createNewProject();
  }

  onFocusFlowNode(taskId: string): void {
    this.options.projectCoord.onFocusFlowNode(taskId);
  }

  onSearchTaskClick(taskId: string, isParked: boolean): void {
    this.projectSearchTask.open(taskId, isParked);
  }

  confirmCreateProject(name: string, desc: string): Promise<void> {
    return this.projectMutation.confirmCreateProject(name, desc);
  }

  async confirmDeleteProject(
    projectId: string,
    projectName: string,
    event: Event,
    owner?: ActiveProjectOwner,
  ): Promise<void> {
    await this.projectMutation.confirmDeleteProject(projectId, projectName, event, owner);
  }

  async handleImportComplete(
    project: Parameters<WorkspaceShellProjectMutationController['handleImportComplete']>[0],
  ): Promise<void> {
    await this.projectMutation.handleImportComplete(project);
  }

  onRenameProjectNameInput(event: Event): void {
    this.projectMutation.onRenameProjectNameInput(event);
  }

  onProjectDescriptionInput(projectId: string, event: Event): void {
    this.projectMutation.onProjectDescriptionInput(projectId, event);
  }

  protected blockHintOnlyMutation(actionLabel: string): boolean {
    return this.projectMutation.blockHintOnlyMutation(actionLabel);
  }
}
