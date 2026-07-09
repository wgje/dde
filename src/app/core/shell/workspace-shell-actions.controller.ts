import type { ThemeType } from '../../../models';

import {
  WorkspaceShellAuthActionsController,
  type WorkspaceShellAuthActionsControllerOptions,
} from './workspace-shell-auth-actions.controller';
import { readWorkspaceTextInputValue } from './workspace-shell-search.controller';
import {
  WorkspaceShellProjectActionsController,
  type WorkspaceShellProjectActionsControllerOptions,
  type WorkspaceShellSignalSetter,
} from './workspace-shell-project-actions.controller';

type WorkspaceShellErrorRecoveryModalInput = {
  title: string;
  message: string;
  details?: string;
  options: unknown[];
  defaultOptionId?: string;
  autoSelectIn?: number | null;
  resolve(result: { optionId: string }): void;
};

type WorkspaceShellModalCoordinatorLike = {
  resolveConflictLocal(): Promise<void>;
  resolveConflictRemote(): Promise<void>;
  resolveConflictMerge(): Promise<void>;
  cancelConflictResolution(): void;
  openSettings(): Promise<void>;
  closeSettings(): void;
  openDashboard(options?: { initialTab?: string }): Promise<void>;
  openDashboardFromSettings(): Promise<void>;
  openConflictCenterFromDashboard(): void;
  openLoginModal(): Promise<void>;
  openTrashModal(): Promise<void>;
  openConfigHelpModal(): Promise<void>;
  openNewProjectModal(): Promise<void>;
  openMigrationModal(): Promise<void>;
  openErrorRecoveryModal(error: WorkspaceShellErrorRecoveryModalInput): Promise<void>;
  openStorageEscapeModalImperative(): Promise<void>;
};

type WorkspaceShellSearchLazyLoadLike = {
  ensureLoaded(): void;
};

type WorkspaceShellSearchControllerLike = {
  update(query: string): void;
  clear(): void;
};

type WorkspaceShellUiStateLike = {
  layoutDirection: WorkspaceShellSignalSetter<'ltr' | 'rtl'>;
  floatingWindowPref: WorkspaceShellSignalSetter<'auto' | 'fixed'>;
  filterMode: WorkspaceShellSignalSetter<string>;
};

export interface WorkspaceShellActionsControllerOptions
  extends WorkspaceShellProjectActionsControllerOptions,
    WorkspaceShellAuthActionsControllerOptions {
  storageEscape: { close(): void };
  modalCoord: WorkspaceShellModalCoordinatorLike;
  preferenceService: {
    setTheme(theme: ThemeType): Promise<unknown> | unknown;
  };
  uiState: WorkspaceShellUiStateLike;
  searchLazyLoad: WorkspaceShellSearchLazyLoadLike;
  searchController: WorkspaceShellSearchControllerLike;
}

export class WorkspaceShellActionsController extends WorkspaceShellProjectActionsController<
  WorkspaceShellActionsControllerOptions
> {
  private readonly authActions: WorkspaceShellAuthActionsController<
    WorkspaceShellActionsControllerOptions
  >;

  constructor(options: WorkspaceShellActionsControllerOptions) {
    super(options);
    this.authActions = new WorkspaceShellAuthActionsController(options);
  }

  retryBootstrap(): void {
    this.authActions.retryBootstrap();
  }

  handleLogin(event?: Event, opts?: { closeSettings?: boolean }): Promise<void> {
    return this.authActions.handleLogin(event, opts);
  }

  handleSignup(event?: Event): Promise<void> {
    return this.authActions.handleSignup(event);
  }

  handleResetPassword(event?: Event): Promise<void> {
    return this.authActions.handleResetPassword(event);
  }

  switchToSignup(): void {
    this.authActions.switchToSignup();
  }

  switchToLogin(): void {
    this.authActions.switchToLogin();
  }

  switchToResetPassword(): void {
    this.authActions.switchToResetPassword();
  }

  signOut(): Promise<void> {
    return this.authActions.signOut();
  }

  startRelogin(): void {
    this.authActions.startRelogin();
  }

  closeStorageEscapeModal(): void {
    this.options.storageEscape.close();
  }

  resolveConflictLocal(): Promise<void> {
    return this.options.modalCoord.resolveConflictLocal();
  }

  resolveConflictRemote(): Promise<void> {
    return this.options.modalCoord.resolveConflictRemote();
  }

  resolveConflictMerge(): Promise<void> {
    return this.options.modalCoord.resolveConflictMerge();
  }

  cancelConflictResolution(): void {
    this.options.modalCoord.cancelConflictResolution();
  }

  openSettings(): Promise<void> {
    return this.options.modalCoord.openSettings();
  }

  closeSettings(): void {
    this.options.modalCoord.closeSettings();
  }

  openDashboardFromSettings(): Promise<void> {
    return this.options.modalCoord.openDashboardFromSettings();
  }

  openDashboard(): Promise<void> {
    return this.options.modalCoord.openDashboard();
  }

  openDashboardAtConflicts(): Promise<void> {
    return this.options.modalCoord.openDashboard({ initialTab: 'conflicts' });
  }

  openConflictCenterFromDashboard(): void {
    this.options.modalCoord.openConflictCenterFromDashboard();
  }

  openLoginModal(): Promise<void> {
    return this.options.modalCoord.openLoginModal();
  }

  openTrashModal(): Promise<void> {
    return this.options.modalCoord.openTrashModal();
  }

  openConfigHelpModal(): Promise<void> {
    return this.options.modalCoord.openConfigHelpModal();
  }

  openNewProjectModal(): Promise<void> {
    return this.options.modalCoord.openNewProjectModal();
  }

  openMigrationModal(): Promise<void> {
    return this.options.modalCoord.openMigrationModal();
  }

  openErrorRecoveryModal(error: WorkspaceShellErrorRecoveryModalInput): Promise<void> {
    return this.options.modalCoord.openErrorRecoveryModal(error);
  }

  openStorageEscapeModalImperative(): Promise<void> {
    return this.options.modalCoord.openStorageEscapeModalImperative();
  }

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

  handleLoginFromModal(data: { email: string; password: string }): Promise<void> {
    return this.authActions.handleLoginFromModal(data);
  }

  handleSignupFromModal(data: {
    email: string;
    password: string;
    confirmPassword: string;
  }): Promise<void> {
    return this.authActions.handleSignupFromModal(data);
  }

  handleResetPasswordFromModal(email: string): Promise<void> {
    return this.authActions.handleResetPasswordFromModal(email);
  }

  handleLocalModeFromModal(): Promise<void> {
    return this.authActions.handleLocalModeFromModal();
  }

  handleMigrationComplete(): void {
    this.authActions.handleMigrationComplete();
  }

  closeMigrationModal(): void {
    this.authActions.closeMigrationModal();
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
