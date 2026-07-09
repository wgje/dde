import { WorkspaceShellLazyDelegateCallHostController } from './workspace-shell-lazy-delegate-call-host.controller';
import {
  createWorkspaceShellRemoteCallbacksLazyLoadHostLoader,
} from './workspace-shell-remote-callbacks-lazy-load-host-loader.factory';
import type {
  WorkspaceShellRemoteCallbacksLazyLoadDelegate,
  WorkspaceShellRemoteCallbacksLazyLoadDelegateOptions,
} from './workspace-shell-remote-callbacks-lazy-load-delegate.factory';

const REMOTE_CALLBACKS_LAZY_HOST_LOAD_FAILURE_MESSAGE =
  '远程恢复回调 lazy-load host 加载失败，已跳过本次注册';
const REMOTE_CALLBACKS_LAZY_HOST_REGISTER_FAILURE_MESSAGE =
  '远程恢复回调 lazy-load host 注册失败，已跳过本次注册';
const REMOTE_CALLBACKS_LAZY_HOST_TEARDOWN_FAILURE_MESSAGE =
  '远程恢复回调 lazy-load host 清理失败，已跳过';

export class WorkspaceShellRemoteCallbacksLazyLoadDelegateController
implements WorkspaceShellRemoteCallbacksLazyLoadDelegate {
  private readonly host: WorkspaceShellLazyDelegateCallHostController<
    WorkspaceShellRemoteCallbacksLazyLoadDelegate
  >;
  private readonly loadRemoteCallbacksLazyLoadHost:
    () => Promise<WorkspaceShellRemoteCallbacksLazyLoadDelegate>;

  constructor(options: WorkspaceShellRemoteCallbacksLazyLoadDelegateOptions) {
    this.loadRemoteCallbacksLazyLoadHost =
      createWorkspaceShellRemoteCallbacksLazyLoadHostLoader({
        createRemoteCallbacksLazyLoadHost: options.createRemoteCallbacksLazyLoadHost,
        options,
      });
    this.host = new WorkspaceShellLazyDelegateCallHostController({
      createDelegate: () => this.loadRemoteCallbacksLazyLoadHost(),
      loadFailureMessage: REMOTE_CALLBACKS_LAZY_HOST_LOAD_FAILURE_MESSAGE,
      teardownFailureMessage: REMOTE_CALLBACKS_LAZY_HOST_TEARDOWN_FAILURE_MESSAGE,
      warn: options.warn,
    });
  }

  registerIfReady(): void {
    this.host.run(
      controller => controller.registerIfReady(),
      REMOTE_CALLBACKS_LAZY_HOST_REGISTER_FAILURE_MESSAGE,
      REMOTE_CALLBACKS_LAZY_HOST_LOAD_FAILURE_MESSAGE,
    );
  }

  teardown(): void {
    this.host.teardown();
  }
}
