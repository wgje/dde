import type { ThemeType } from '../../../models';
import type { ProjectUiOwner } from '../../../services/task-operation-trash-adapter.controller';

import {
  WorkspaceShellAuthActionsController,
  type WorkspaceShellAuthActionsControllerOptions,
} from './workspace-shell-auth-actions.controller';
import {
  WorkspaceShellModalActionsController,
  type WorkspaceShellErrorRecoveryModalInput,
  type WorkspaceShellModalActionsControllerOptions,
} from './workspace-shell-modal-actions.controller';
import {
  WorkspaceShellProjectActionsController,
  type WorkspaceShellProjectActionsControllerOptions,
} from './workspace-shell-project-actions.controller';
import {
  WorkspaceShellUiActionsController,
  type WorkspaceShellUiActionsControllerOptions,
} from './workspace-shell-ui-actions.controller';

export type WorkspaceShellActionsControllerOptions =
  WorkspaceShellProjectActionsControllerOptions
  & WorkspaceShellAuthActionsControllerOptions
  & WorkspaceShellModalActionsControllerOptions
  & WorkspaceShellUiActionsControllerOptions;

export class WorkspaceShellActionsController extends WorkspaceShellProjectActionsController<
  WorkspaceShellActionsControllerOptions
> {
  private readonly authActions: WorkspaceShellAuthActionsController<
    WorkspaceShellActionsControllerOptions
  >;
  private readonly modalActions: WorkspaceShellModalActionsController;
  private readonly uiActions: WorkspaceShellUiActionsController;

  constructor(options: WorkspaceShellActionsControllerOptions) {
    super(options);
    this.authActions = new WorkspaceShellAuthActionsController(options);
    this.modalActions = new WorkspaceShellModalActionsController(options);
    this.uiActions = new WorkspaceShellUiActionsController(options);
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
    this.modalActions.closeStorageEscapeModal();
  }

  resolveConflictLocal(): Promise<void> {
    return this.modalActions.resolveConflictLocal();
  }

  resolveConflictRemote(): Promise<void> {
    return this.modalActions.resolveConflictRemote();
  }

  resolveConflictMerge(): Promise<void> {
    return this.modalActions.resolveConflictMerge();
  }

  cancelConflictResolution(): void {
    this.modalActions.cancelConflictResolution();
  }

  openSettings(): Promise<void> {
    return this.modalActions.openSettings();
  }

  closeSettings(): void {
    this.modalActions.closeSettings();
  }

  openDashboardFromSettings(): Promise<void> {
    return this.modalActions.openDashboardFromSettings();
  }

  openDashboard(): Promise<void> {
    return this.modalActions.openDashboard();
  }

  openDashboardAtConflicts(): Promise<void> {
    return this.modalActions.openDashboardAtConflicts();
  }

  openConflictCenterFromDashboard(): void {
    this.modalActions.openConflictCenterFromDashboard();
  }

  openLoginModal(): Promise<void> {
    return this.modalActions.openLoginModal();
  }

  openTrashModal(owner?: ProjectUiOwner | null): Promise<void> {
    return this.modalActions.openTrashModal(owner);
  }

  openConfigHelpModal(): Promise<void> {
    return this.modalActions.openConfigHelpModal();
  }

  openNewProjectModal(): Promise<void> {
    return this.modalActions.openNewProjectModal();
  }

  openMigrationModal(): Promise<void> {
    return this.modalActions.openMigrationModal();
  }

  openErrorRecoveryModal(error: WorkspaceShellErrorRecoveryModalInput): Promise<void> {
    return this.modalActions.openErrorRecoveryModal(error);
  }

  openStorageEscapeModalImperative(): Promise<void> {
    return this.modalActions.openStorageEscapeModalImperative();
  }

  updateLayoutDirection(event: Event): void {
    this.uiActions.updateLayoutDirection(event);
  }

  updateFloatPref(event: Event): void {
    this.uiActions.updateFloatPref(event);
  }

  updateTheme(theme: ThemeType): void {
    this.uiActions.updateTheme(theme);
  }

  updateFilter(event: Event): void {
    this.uiActions.updateFilter(event);
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
    this.uiActions.onUnifiedSearchInput(event);
  }

  onUnifiedSearchChange(query: string): void {
    this.uiActions.onUnifiedSearchChange(query);
  }

  clearUnifiedSearch(): void {
    this.uiActions.clearUnifiedSearch();
  }
}
