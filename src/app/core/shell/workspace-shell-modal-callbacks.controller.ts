import type { Project, ThemeType } from '../../../models';
import type { ModalCallbacks } from '../../../services/workspace-modal-coordinator.service';

export interface WorkspaceShellModalCallbackActions {
  signOut(): Promise<void> | void;
  updateTheme(theme: ThemeType): void;
  handleImportComplete(project: Project): Promise<void> | void;
  handleLoginFromModal(data: { email: string; password: string }): Promise<void> | void;
  handleSignupFromModal(data: {
    email: string;
    password: string;
    confirmPassword: string;
  }): Promise<void> | void;
  handleResetPasswordFromModal(email: string): Promise<void> | void;
  handleLocalModeFromModal(): Promise<void> | void;
  confirmCreateProject(name: string, description: string): Promise<void> | void;
  handleMigrationComplete(): void;
  closeMigrationModal(): void;
}

export interface WorkspaceShellModalCallbacksControllerOptions {
  actions: WorkspaceShellModalCallbackActions;
  warn?: (message: string, error: unknown) => void;
}

export class WorkspaceShellModalCallbacksController {
  constructor(private readonly options: WorkspaceShellModalCallbacksControllerOptions) {}

  createCallbacks(): ModalCallbacks {
    const { actions } = this.options;

    return {
      signOut: () => this.runAsyncCallback(() => actions.signOut()),
      updateTheme: theme => actions.updateTheme(theme),
      handleImportComplete: project => this.runAwaitableCallback(
        () => actions.handleImportComplete(project),
      ),
      handleLoginFromModal: data => this.runAsyncCallback(() => actions.handleLoginFromModal(data)),
      handleSignupFromModal: data => this.runAsyncCallback(() => actions.handleSignupFromModal(data)),
      handleResetPasswordFromModal: email => this.runAsyncCallback(() => actions.handleResetPasswordFromModal(email)),
      handleLocalModeFromModal: () => this.runAsyncCallback(() => actions.handleLocalModeFromModal()),
      confirmCreateProject: (name, desc) => this.runAsyncCallback(() => actions.confirmCreateProject(name, desc)),
      handleMigrationComplete: () => actions.handleMigrationComplete(),
      closeMigrationModal: () => actions.closeMigrationModal(),
    };
  }

  private runAsyncCallback(action: () => Promise<void> | void): Promise<void> {
    try {
      return Promise.resolve(action()).catch(error => {
        this.reportCallbackFailure(error);
      });
    } catch (error) {
      this.reportCallbackFailure(error);
      return Promise.resolve();
    }
  }

  private runAwaitableCallback(action: () => Promise<void> | void): Promise<void> {
    try {
      return Promise.resolve(action()).catch(error => {
        this.reportCallbackFailure(error);
        throw error;
      });
    } catch (error) {
      this.reportCallbackFailure(error);
      return Promise.reject(error);
    }
  }

  private reportCallbackFailure(error: unknown): void {
    this.options.warn?.('Workspace shell modal callback 执行失败，已跳过本次操作', error);
  }
}
