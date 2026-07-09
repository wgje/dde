import type {
  WorkspaceShellSessionLaunchDelegatesOptions,
} from './workspace-shell-session-launch-delegates.factory';
import type {
  WorkspaceShellSessionLaunchControllers,
} from './workspace-shell-session-launch.factory';
import { WorkspaceShellLazyDelegateCallHostController } from './workspace-shell-lazy-delegate-call-host.controller';

const SESSION_LAUNCH_LOAD_FAILURE_MESSAGE =
  '会话启动加载失败';
const SESSION_LAUNCH_ACTION_FAILURE_MESSAGE =
  '会话启动执行失败';
const SESSION_LAUNCH_TEARDOWN_FAILURE_MESSAGE =
  '会话启动清理失败';

export type WorkspaceShellSessionLaunchDelegateLoader =
  () => Promise<WorkspaceShellSessionLaunchControllers>;

export interface WorkspaceShellSessionLaunchLazyDelegateControllerOptions {
  loadDelegate: WorkspaceShellSessionLaunchDelegateLoader;
  warn: WorkspaceShellSessionLaunchDelegatesOptions['warn'];
}

export class WorkspaceShellSessionLaunchLazyDelegateController
implements WorkspaceShellSessionLaunchControllers {
  private readonly host: WorkspaceShellLazyDelegateCallHostController<
    WorkspaceShellSessionLaunchControllers
  >;

  readonly launchSnapshotController = {
    sync: () => this.host.run(
      delegate => delegate.launchSnapshotController.sync(),
      SESSION_LAUNCH_ACTION_FAILURE_MESSAGE,
      SESSION_LAUNCH_LOAD_FAILURE_MESSAGE,
    ),
  };

  readonly sessionTransition = {
    setupSessionHandlers: () => this.host.run(
      delegate => delegate.sessionTransition.setupSessionHandlers(),
      SESSION_LAUNCH_ACTION_FAILURE_MESSAGE,
      SESSION_LAUNCH_LOAD_FAILURE_MESSAGE,
    ),
    cleanup: () => this.host.runIfLoaded(
      delegate => delegate.sessionTransition.cleanup(),
      SESSION_LAUNCH_TEARDOWN_FAILURE_MESSAGE,
    ),
  };

  constructor(options: WorkspaceShellSessionLaunchLazyDelegateControllerOptions) {
    this.host = new WorkspaceShellLazyDelegateCallHostController({
      createDelegate: options.loadDelegate,
      loadFailureMessage: SESSION_LAUNCH_LOAD_FAILURE_MESSAGE,
      teardownFailureMessage: SESSION_LAUNCH_TEARDOWN_FAILURE_MESSAGE,
      warn: options.warn,
    });
  }
}
