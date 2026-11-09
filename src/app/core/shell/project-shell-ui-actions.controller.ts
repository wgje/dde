import {
  computed,
  signal,
  type Signal,
} from '@angular/core';

import {
  resolveWorkspaceFilterLabel,
  type WorkspaceFilterLabelTask,
} from './workspace-shell-filter-label.helpers';

export interface ProjectShellUiActionsControllerOptions {
  dispatchEvent?: (event: Event) => unknown;
  getTask: (taskId: string) => WorkspaceFilterLabelTask | null | undefined;
  uiState: {
    filterMode: () => string;
    isTextColumnCollapsed: {
      set(value: boolean): void;
      update(update: (value: boolean) => boolean): unknown;
    };
    textColumnRatio: {
      set(value: number): void;
    };
  };
}

export class ProjectShellUiActionsController {
  readonly isFilterOpen = signal(false);
  readonly currentFilterLabel: Signal<string>;

  constructor(private readonly options: ProjectShellUiActionsControllerOptions) {
    this.currentFilterLabel = computed(() => resolveWorkspaceFilterLabel({
      filterId: this.options.uiState.filterMode(),
      getTask: this.options.getTask,
    }));
  }

  toggleSidebar(): void {
    this.dispatch('toggle-sidebar');
  }

  toggleDockFocusSession(): void {
    this.dispatch('dock-focus-session-toggle');
  }

  toggleTextColumn(): void {
    this.options.uiState.isTextColumnCollapsed.update(value => !value);
  }

  expandTextColumnToMin(): void {
    this.options.uiState.textColumnRatio.set(25);
    this.options.uiState.isTextColumnCollapsed.set(false);
  }

  private dispatch(type: string): void {
    const event = new CustomEvent(type);
    if (this.options.dispatchEvent) {
      this.options.dispatchEvent(event);
      return;
    }

    window.dispatchEvent(event);
  }
}
