import type {
  WorkspaceShellFocusSyncControllerHosts,
} from './workspace-shell-focus-sync-controllers.factory';
import type {
  WorkspaceShellFocusSyncLazyHost,
} from './workspace-shell-focus-sync-delegates.factory';
import { WorkspaceShellLazyDelegateCallHostController } from './workspace-shell-lazy-delegate-call-host.controller';

const FOCUS_SYNC_OPERATION_FAILURE_MESSAGE =
  'Focus sync controller lazy host 加载失败，已跳过本次操作';
const FOCUS_SYNC_CLEANUP_FAILURE_MESSAGE =
  'Focus sync controller lazy host 清理失败，已跳过';

export interface WorkspaceShellFocusSyncLazyHostControllerOptions {
  loadDelegate: () => Promise<WorkspaceShellFocusSyncControllerHosts>;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellFocusSyncLazyHostController
implements WorkspaceShellFocusSyncLazyHost {
  private readonly host: WorkspaceShellLazyDelegateCallHostController<
    WorkspaceShellFocusSyncControllerHosts
  >;

  constructor(options: WorkspaceShellFocusSyncLazyHostControllerOptions) {
    this.host = new WorkspaceShellLazyDelegateCallHostController({
      createDelegate: options.loadDelegate,
      loadFailureMessage: FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
      teardownFailureMessage: FOCUS_SYNC_CLEANUP_FAILURE_MESSAGE,
      warn: options.warn,
    });
  }

  get loadedDelegate(): WorkspaceShellFocusSyncControllerHosts | null {
    return this.host.loadedDelegate;
  }

  run(
    action: (delegate: WorkspaceShellFocusSyncControllerHosts) => void,
    failureMessage = FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    loadFailureMessage = failureMessage,
  ): void {
    this.host.run(action, failureMessage, loadFailureMessage);
  }

  runIfLoaded(
    action: (delegate: WorkspaceShellFocusSyncControllerHosts) => void,
    failureMessage = FOCUS_SYNC_CLEANUP_FAILURE_MESSAGE,
  ): void {
    this.host.runIfLoaded(action, failureMessage);
  }

  call<TResult>(
    action: (
      delegate: WorkspaceShellFocusSyncControllerHosts
    ) => TResult | Promise<TResult>,
    fallback: TResult,
    failureMessage = FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    loadFailureMessage = failureMessage,
  ): Promise<TResult> {
    return this.host.call(action, fallback, failureMessage, loadFailureMessage);
  }
}
