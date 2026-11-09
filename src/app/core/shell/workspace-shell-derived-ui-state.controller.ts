import { computed, signal } from '@angular/core';

import {
  resolveWorkspaceFilterLabel,
  type WorkspaceFilterLabelTask,
} from './workspace-shell-filter-label.helpers';

export interface WorkspaceShellDeleteProjectData {
  projectId: string;
  projectName: string;
}

export interface WorkspaceShellDerivedUiStateControllerOptions {
  filterId: () => string;
  getTask: (taskId: string) => WorkspaceFilterLabelTask | null | undefined;
  isDeleteProjectModalOpen: () => boolean;
  getDeleteProjectData: () => WorkspaceShellDeleteProjectData | undefined;
  isAuthLoginRequired: () => boolean;
  isHandoffLoginRequired: () => boolean;
}

export class WorkspaceShellDerivedUiStateController {
  readonly modalLoading = signal<Record<string, boolean>>({});

  readonly currentFilterLabel = computed(() =>
    resolveWorkspaceFilterLabel({
      filterId: this.options.filterId(),
      getTask: this.options.getTask,
    }),
  );

  readonly showDeleteProjectModal = computed(() =>
    this.options.isDeleteProjectModalOpen(),
  );

  readonly showLoginRequired = computed(
    () =>
      this.options.isAuthLoginRequired() &&
      this.options.isHandoffLoginRequired(),
  );

  readonly deleteProjectTarget = computed(() => {
    const data = this.options.getDeleteProjectData();
    return data ? { id: data.projectId, name: data.projectName } : null;
  });

  constructor(
    private readonly options: WorkspaceShellDerivedUiStateControllerOptions,
  ) {}
}
