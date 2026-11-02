import type { ThemeType } from '../../../models';
import type { ProjectUiOwner } from '../../../services/task-operation-trash-adapter.controller';

import { WorkspaceShellLazyDelegateCallHostController } from './workspace-shell-lazy-delegate-call-host.controller';

const ACTIONS_LOAD_FAILURE_MESSAGE =
  'Workspace shell actions controller 懒加载失败，已跳过本次操作';
const ACTIONS_OPERATION_FAILURE_MESSAGE =
  'Workspace shell actions controller 操作执行失败，已跳过本次操作';
const ACTIONS_TEARDOWN_FAILURE_MESSAGE =
  'Workspace shell actions controller 清理失败，已跳过';

type WorkspaceShellErrorRecoveryModalInput = {
  title: string;
  message: string;
  details?: string;
  options: unknown[];
  defaultOptionId?: string;
  autoSelectIn?: number | null;
  resolve(result: { optionId: string }): void;
};

export interface WorkspaceShellActionsHostDelegate {
  cancelConflictResolution(): void;
  clearUnifiedSearch(): void;
  closeMigrationModal(): void;
  closeSettings(): void;
  closeStorageEscapeModal(): void;
  confirmCreateProject(name: string, desc: string): Promise<void>;
  handleLocalModeFromModal(): Promise<void>;
  handleLogin(event?: Event, opts?: { closeSettings?: boolean }): Promise<void>;
  handleLoginFromModal(data: { email: string; password: string }): Promise<void>;
  handleMigrationComplete(): void;
  handleResetPassword(event?: Event): Promise<void>;
  handleResetPasswordFromModal(email: string): Promise<void>;
  handleSignup(event?: Event): Promise<void>;
  handleSignupFromModal(data: {
    email: string;
    password: string;
    confirmPassword: string;
  }): Promise<void>;
  openConfigHelpModal(): Promise<void>;
  openDashboard(): Promise<void>;
  openDashboardAtConflicts(): Promise<void>;
  openDashboardFromSettings(): Promise<void>;
  openErrorRecoveryModal(error: WorkspaceShellErrorRecoveryModalInput): Promise<void>;
  openLoginModal(): Promise<void>;
  openMigrationModal(): Promise<void>;
  openNewProjectModal(): Promise<void>;
  openSettings(): Promise<void>;
  openStorageEscapeModalImperative(): Promise<void>;
  openTrashModal(owner?: ProjectUiOwner | null): Promise<void>;
  onUnifiedSearchChange(query: string): void;
  onUnifiedSearchInput(event: Event): void;
  resolveConflictLocal(): Promise<void>;
  resolveConflictMerge(): Promise<void>;
  resolveConflictRemote(): Promise<void>;
  retryBootstrap(): void;
  signOut(): Promise<void>;
  startRelogin(): void;
  switchToLogin(): void;
  switchToResetPassword(): void;
  switchToSignup(): void;
  updateFilter(event: Event): void;
  updateFloatPref(event: Event): void;
  updateLayoutDirection(event: Event): void;
  updateTheme(theme: ThemeType): void;
}

export type WorkspaceShellActionsMethodName = keyof WorkspaceShellActionsHostDelegate;

const WORKSPACE_SHELL_ACTION_METHOD_NAMES = [
  'cancelConflictResolution',
  'clearUnifiedSearch',
  'closeMigrationModal',
  'closeSettings',
  'closeStorageEscapeModal',
  'confirmCreateProject',
  'handleLocalModeFromModal',
  'handleLogin',
  'handleLoginFromModal',
  'handleMigrationComplete',
  'handleResetPassword',
  'handleResetPasswordFromModal',
  'handleSignup',
  'handleSignupFromModal',
  'openConfigHelpModal',
  'openDashboard',
  'openDashboardAtConflicts',
  'openDashboardFromSettings',
  'openErrorRecoveryModal',
  'openLoginModal',
  'openMigrationModal',
  'openNewProjectModal',
  'openSettings',
  'openStorageEscapeModalImperative',
  'openTrashModal',
  'onUnifiedSearchChange',
  'onUnifiedSearchInput',
  'resolveConflictLocal',
  'resolveConflictMerge',
  'resolveConflictRemote',
  'retryBootstrap',
  'signOut',
  'startRelogin',
  'switchToLogin',
  'switchToResetPassword',
  'switchToSignup',
  'updateFilter',
  'updateFloatPref',
  'updateLayoutDirection',
  'updateTheme',
] as const satisfies readonly WorkspaceShellActionsMethodName[];

const WORKSPACE_SHELL_ACTION_METHOD_NAME_SET = new Set<string>(
  WORKSPACE_SHELL_ACTION_METHOD_NAMES,
);

export function isWorkspaceShellActionsMethodName(
  value: string,
): value is WorkspaceShellActionsMethodName {
  return WORKSPACE_SHELL_ACTION_METHOD_NAME_SET.has(value);
}

export interface WorkspaceShellActionsCommandHostControllerOptions {
  loadActionsController: () => Promise<WorkspaceShellActionsHostDelegate>;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellActionsCommandHostController {
  private readonly host: WorkspaceShellLazyDelegateCallHostController<
    WorkspaceShellActionsHostDelegate
  >;

  constructor(private readonly options: WorkspaceShellActionsCommandHostControllerOptions) {
    this.host = new WorkspaceShellLazyDelegateCallHostController({
      createDelegate: options.loadActionsController,
      loadFailureMessage: ACTIONS_LOAD_FAILURE_MESSAGE,
      teardownFailureMessage: ACTIONS_TEARDOWN_FAILURE_MESSAGE,
      warn: options.warn,
    });
  }

  runActionCommand(
    method: WorkspaceShellActionsMethodName,
    args: unknown[],
  ): Promise<unknown> {
    return this.host.call(
      actions => {
        const run = actions[method] as (...methodArgs: unknown[]) => unknown;
        return run.apply(actions, args);
      },
      undefined,
      ACTIONS_OPERATION_FAILURE_MESSAGE,
      ACTIONS_LOAD_FAILURE_MESSAGE,
    );
  }

  skipUnknownActionCommand(method: string): Promise<unknown> {
    this.warn('Workspace shell actions controller 未知操作，已跳过本次操作', { method });
    return Promise.resolve(undefined);
  }

  teardown(): void {
    this.host.teardown();
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning sinks are best-effort and must not interrupt action fallbacks.
    }
  }
}
