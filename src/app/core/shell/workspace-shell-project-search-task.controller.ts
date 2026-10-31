export interface WorkspaceShellProjectSearchTaskControllerOptions {
  taskProjectId: (taskId: string) => string | null;
  activeProjectId: () => string | null;
  switchActiveProject: (projectId: string) => void;
  focusFlowNode: (taskId: string) => void;
  setDockExpanded: (
    expanded: boolean,
    options: { persistPreference: boolean },
  ) => void | Promise<boolean>;
  previewTask: (taskId: string) => void | Promise<boolean>;
  waitForProjectSwitchTick?: () => Promise<void>;
}

const PROJECT_SWITCH_PREVIEW_WAIT_ATTEMPTS = 5;

export class WorkspaceShellProjectSearchTaskController {
  private parkedSearchPreviewGeneration = 0;

  constructor(
    private readonly options: WorkspaceShellProjectSearchTaskControllerOptions,
  ) {}

  open(taskId: string, isParked: boolean): void {
    const projectId = this.options.taskProjectId(taskId)
      ?? this.options.activeProjectId();
    const activeProjectId = this.options.activeProjectId();
    if (projectId && projectId !== activeProjectId) {
      this.options.switchActiveProject(projectId);
    }

    if (isParked) {
      const generation = ++this.parkedSearchPreviewGeneration;
      void this.previewAfterProjectSwitch(taskId, projectId, activeProjectId, generation);
      return;
    }

    this.parkedSearchPreviewGeneration += 1;
    this.options.focusFlowNode(taskId);
  }

  private async previewAfterProjectSwitch(
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
    this.preview(taskId);
  }

  private preview(taskId: string): void {
    void this.options.setDockExpanded(true, { persistPreference: false });
    void this.options.previewTask(taskId);
  }

  private async waitForActiveProject(projectId: string): Promise<boolean> {
    for (let attempt = 0; attempt < PROJECT_SWITCH_PREVIEW_WAIT_ATTEMPTS; attempt += 1) {
      await this.waitForProjectSwitchTick();
      if (this.options.activeProjectId() === projectId) return true;
    }
    return this.options.activeProjectId() === projectId;
  }

  private waitForProjectSwitchTick(): Promise<void> {
    return this.options.waitForProjectSwitchTick?.()
      ?? new Promise(resolve => setTimeout(resolve, 0));
  }
}
