import type { ThemeType } from '../../../models';

import { readWorkspaceTextInputValue } from './workspace-shell-search.controller';

export interface WorkspaceShellUiActionsSignalSetter<T> {
  set(value: T): void;
}

export interface WorkspaceShellUiActionsControllerOptions {
  preferenceService: {
    setTheme(theme: ThemeType): Promise<unknown> | unknown;
  };
  uiState: {
    layoutDirection: WorkspaceShellUiActionsSignalSetter<'ltr' | 'rtl'>;
    floatingWindowPref: WorkspaceShellUiActionsSignalSetter<'auto' | 'fixed'>;
    filterMode: WorkspaceShellUiActionsSignalSetter<string>;
  };
  searchLazyLoad: {
    ensureLoaded(): void;
  };
  searchController: {
    update(query: string): void;
    clear(): void;
  };
}

export class WorkspaceShellUiActionsController {
  constructor(private readonly options: WorkspaceShellUiActionsControllerOptions) {}

  updateLayoutDirection(event: Event): void {
    const value = readWorkspaceTextInputValue(event) as 'ltr' | 'rtl';
    this.options.uiState.layoutDirection.set(value);
  }

  updateFloatPref(event: Event): void {
    const value = readWorkspaceTextInputValue(event) as 'auto' | 'fixed';
    this.options.uiState.floatingWindowPref.set(value);
  }

  updateTheme(theme: ThemeType): void {
    void this.options.preferenceService.setTheme(theme);
  }

  updateFilter(event: Event): void {
    this.options.uiState.filterMode.set(readWorkspaceTextInputValue(event));
  }

  onUnifiedSearchInput(event: Event): void {
    this.onUnifiedSearchChange(readWorkspaceTextInputValue(event));
  }

  onUnifiedSearchChange(query: string): void {
    if (query.trim()) {
      this.options.searchLazyLoad.ensureLoaded();
    }
    this.options.searchController.update(query);
  }

  clearUnifiedSearch(): void {
    this.options.searchController.clear();
  }
}
