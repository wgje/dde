import type { ThemeType } from '../../../models';

import {
  createWorkspaceShellActionsControllerLoader,
  type WorkspaceShellActionsControllerLoaderOptions,
} from './workspace-shell-actions-controller-loader.factory';
import { WorkspaceShellLazyDelegateCallHostController } from './workspace-shell-lazy-delegate-call-host.controller';
import {
  WorkspaceShellProjectActionsController,
} from './workspace-shell-project-actions.controller';

const ACTIONS_LOAD_FAILURE_MESSAGE =
  'Workspace shell actions controller 懒加载失败，已跳过本次操作';
const ACTIONS_OPERATION_FAILURE_MESSAGE =
  'Workspace shell actions controller 操作执行失败，已跳过本次操作';
const ACTIONS_TEARDOWN_FAILURE_MESSAGE =
  'Workspace shell actions controller 清理失败，已跳过';
const ACTIONS_DOCUMENT_CLICK_LISTENER_TEARDOWN_FAILURE_MESSAGE =
  'Workspace shell actions controller 文档点击监听清理失败，已继续清理';

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
  openTrashModal(): Promise<void>;
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

export interface WorkspaceShellActionsLazyLoadHostOptions
  extends WorkspaceShellActionsControllerLoaderOptions {
  listenToDocument?: (eventName: string, listener: EventListener) => () => void;
  warn: (message: string, error: unknown) => void;
}

type WorkspaceShellActionsMethodName = keyof WorkspaceShellActionsHostDelegate;
const WORKSPACE_SHELL_ACTION_METHOD_NAMES = [
  'cancelConflictResolution',
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

function isWorkspaceShellActionsMethodName(value: string): value is WorkspaceShellActionsMethodName {
  return WORKSPACE_SHELL_ACTION_METHOD_NAME_SET.has(value);
}

export class WorkspaceShellActionsLazyLoadHostController
  extends WorkspaceShellProjectActionsController<WorkspaceShellActionsLazyLoadHostOptions> {
  private readonly host: WorkspaceShellLazyDelegateCallHostController<
    WorkspaceShellActionsHostDelegate
  >;
  private readonly loadActionsController: () => Promise<WorkspaceShellActionsHostDelegate>;
  private removeDocumentClickListener: (() => void) | null = null;
  private isTornDown = false;

  constructor(options: WorkspaceShellActionsLazyLoadHostOptions) {
    super(options);
    this.loadActionsController = createWorkspaceShellActionsControllerLoader(options);
    this.host = new WorkspaceShellLazyDelegateCallHostController({
      createDelegate: () => this.loadActionsController(),
      loadFailureMessage: ACTIONS_LOAD_FAILURE_MESSAGE,
      teardownFailureMessage: ACTIONS_TEARDOWN_FAILURE_MESSAGE,
      warn: options.warn,
    });
  }

  setupDocumentClickListener(): void {
    if (this.isTornDown || !this.options.listenToDocument) return;

    this.removeDocumentClickListenerSafely();
    this.removeDocumentClickListener = this.options.listenToDocument('click', event => {
      this.onGlobalClick(event as MouseEvent);
    });
  }

  teardown(): void {
    if (this.isTornDown) return;

    this.isTornDown = true;
    this.removeDocumentClickListenerSafely();
    this.host.teardown();
  }

  createNewProject(): void {
    if (this.blockHintOnlyMutation('创建项目')) return;
    void this.runActionCommand('openNewProjectModal', []);
  }

  runActionCommand(
    method: WorkspaceShellActionsMethodName,
    args: unknown[],
  ): Promise<unknown> {
    if (this.isTornDown) {
      return Promise.resolve(undefined);
    }

    return this.host.call(
      actions => {
        if (this.isTornDown) {
          return undefined;
        }

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

  private removeDocumentClickListenerSafely(): void {
    const removeDocumentClickListener = this.removeDocumentClickListener;
    if (!removeDocumentClickListener) return;

    this.removeDocumentClickListener = null;

    try {
      removeDocumentClickListener();
    } catch (error) {
      this.warn(
        ACTIONS_DOCUMENT_CLICK_LISTENER_TEARDOWN_FAILURE_MESSAGE,
        error,
      );
    }
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning sinks are best-effort and must not interrupt action fallbacks.
    }
  }
}

export type WorkspaceShellActionsLazyLoadHostDelegate =
  WorkspaceShellActionsLazyLoadHostController &
  WorkspaceShellActionsHostDelegate;

export function createWorkspaceShellActionsLazyLoadHost(
  options: WorkspaceShellActionsLazyLoadHostOptions,
): WorkspaceShellActionsLazyLoadHostDelegate {
  const controller = new WorkspaceShellActionsLazyLoadHostController(options);

  return new Proxy(controller, {
    get(target, property, receiver) {
      if (property === 'then') {
        return undefined;
      }

      const member = Reflect.get(target, property, receiver);
      if (member !== undefined) {
        return typeof member === 'function' ? member.bind(target) : member;
      }

      if (typeof property !== 'string') {
        return undefined;
      }

      if (!isWorkspaceShellActionsMethodName(property)) {
        return () => target.skipUnknownActionCommand(property);
      }

      return (...args: never[]) =>
        target.runActionCommand(property, args);
    },
  }) as WorkspaceShellActionsLazyLoadHostDelegate;
}
