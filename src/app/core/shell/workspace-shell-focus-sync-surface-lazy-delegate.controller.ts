import type {
  WorkspaceShellFocusSyncControllers,
  WorkspaceShellFocusSyncControllersOptions,
} from './workspace-shell-focus-sync-controllers.factory';
import { WorkspaceShellLazyDelegateCallHostController } from './workspace-shell-lazy-delegate-call-host.controller';

const FOCUS_SYNC_OPERATION_FAILURE_MESSAGE =
  'Focus sync controller lazy surface 加载失败，已跳过本次操作';
const FOCUS_SYNC_CLEANUP_FAILURE_MESSAGE =
  'Focus sync controller lazy surface 清理失败，已跳过';

export interface WorkspaceShellFocusSyncSurfaceLazyDelegateControllerOptions {
  createFocusSyncControllers?: (
    options: WorkspaceShellFocusSyncControllersOptions,
  ) => WorkspaceShellFocusSyncControllers;
  focusSyncOptions: WorkspaceShellFocusSyncControllersOptions;
  mountState: WorkspaceShellFocusSyncControllers['mountState'];
}

export class WorkspaceShellFocusSyncSurfaceLazyDelegateController {
  private readonly host: WorkspaceShellLazyDelegateCallHostController<
    WorkspaceShellFocusSyncControllers
  >;

  constructor(
    options: WorkspaceShellFocusSyncSurfaceLazyDelegateControllerOptions,
  ) {
    this.host = new WorkspaceShellLazyDelegateCallHostController({
      createDelegate: () => this.createDelegate(options),
      loadFailureMessage: FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
      teardownFailureMessage: FOCUS_SYNC_CLEANUP_FAILURE_MESSAGE,
      warn: options.focusSyncOptions.warn,
    });
  }

  get loadedDelegate(): WorkspaceShellFocusSyncControllers | null {
    return this.host.loadedDelegate;
  }

  run(
    action: (delegate: WorkspaceShellFocusSyncControllers) => void,
    failureMessage = FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    loadFailureMessage = failureMessage,
  ): void {
    this.host.run(action, failureMessage, loadFailureMessage);
  }

  runIfLoaded(
    action: (delegate: WorkspaceShellFocusSyncControllers) => void,
    failureMessage = FOCUS_SYNC_CLEANUP_FAILURE_MESSAGE,
  ): void {
    this.host.runIfLoaded(action, failureMessage);
  }

  call<TResult>(
    action: (
      delegate: WorkspaceShellFocusSyncControllers
    ) => TResult | Promise<TResult>,
    fallback: TResult,
    failureMessage = FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    loadFailureMessage = failureMessage,
  ): Promise<TResult> {
    return this.host.call(action, fallback, failureMessage, loadFailureMessage);
  }

  private async createDelegate(
    options: WorkspaceShellFocusSyncSurfaceLazyDelegateControllerOptions,
  ): Promise<WorkspaceShellFocusSyncControllers> {
    if (options.createFocusSyncControllers) {
      return options.createFocusSyncControllers(options.focusSyncOptions);
    }

    const { createWorkspaceShellFocusSyncControllersWithMountState } =
      await import('./workspace-shell-focus-sync-controllers.factory');
    return createWorkspaceShellFocusSyncControllersWithMountState(
      options.focusSyncOptions,
      options.mountState,
    );
  }
}
