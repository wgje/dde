import type {
  WorkspaceShellRemoteCallbacksControllerOptions,
} from './workspace-shell-remote-callbacks.controller';
import { WorkspaceShellLazyDelegateCallHostController } from './workspace-shell-lazy-delegate-call-host.controller';
import {
  createWorkspaceShellRemoteCallbacksControllerLoader,
} from './workspace-shell-remote-callbacks-controller-loader.factory';

const REMOTE_CALLBACKS_CONTROLLER_LOAD_FAILURE_MESSAGE =
  '远程恢复回调 controller 懒加载失败，已跳过本次注册';
const REMOTE_CALLBACKS_CONTROLLER_REGISTER_FAILURE_MESSAGE =
  '远程恢复回调 controller 注册失败，已跳过本次注册';
const REMOTE_CALLBACKS_CONTROLLER_TEARDOWN_FAILURE_MESSAGE =
  '远程恢复回调 controller 清理失败，已跳过';

export interface WorkspaceShellRemoteCallbacksHostDelegate {
  registerIfReady(): void;
  teardown(): void;
}

export interface WorkspaceShellRemoteCallbacksLazyLoadHostOptions
  extends WorkspaceShellRemoteCallbacksControllerOptions {
  createRemoteCallbacksController?: () => Promise<WorkspaceShellRemoteCallbacksHostDelegate>;
}

export class WorkspaceShellRemoteCallbacksLazyLoadHostController {
  private readonly host: WorkspaceShellLazyDelegateCallHostController<WorkspaceShellRemoteCallbacksHostDelegate>;
  private readonly loadRemoteCallbacksController: () => Promise<WorkspaceShellRemoteCallbacksHostDelegate>;

  constructor(private readonly options: WorkspaceShellRemoteCallbacksLazyLoadHostOptions) {
    this.loadRemoteCallbacksController =
      createWorkspaceShellRemoteCallbacksControllerLoader(options);
    this.host = new WorkspaceShellLazyDelegateCallHostController({
      createDelegate: () => this.loadRemoteCallbacksController(),
      loadFailureMessage: REMOTE_CALLBACKS_CONTROLLER_LOAD_FAILURE_MESSAGE,
      teardownFailureMessage: REMOTE_CALLBACKS_CONTROLLER_TEARDOWN_FAILURE_MESSAGE,
      warn: options.warn,
    });
  }

  registerIfReady(): void {
    this.host.run(
      controller => controller.registerIfReady(),
      REMOTE_CALLBACKS_CONTROLLER_REGISTER_FAILURE_MESSAGE,
      REMOTE_CALLBACKS_CONTROLLER_LOAD_FAILURE_MESSAGE,
    );
  }

  teardown(): void {
    this.host.teardown();
  }
}
