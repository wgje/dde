import type {
  WorkspaceShellLazyLifecycleGroupControllerOptions,
} from './workspace-shell-lazy-lifecycle-group.controller';
import {
  createWorkspaceShellLazyLifecycleGroupControllerLoader,
} from './workspace-shell-lazy-lifecycle-group-controller-loader.factory';
import type {
  WorkspaceShellLazyLifecycleGroupControllerLike,
} from './workspace-shell-lazy-lifecycle-group.factory';
import { WorkspaceShellLazyDelegateCallHostController } from './workspace-shell-lazy-delegate-call-host.controller';

const LAZY_LIFECYCLE_NG_ON_INIT_STAGE_FAILURE_MESSAGE =
  '懒生命周期初始化加载失败';

export class WorkspaceShellLazyLifecycleGroupLazyDelegateController {
  private readonly host: WorkspaceShellLazyDelegateCallHostController<
    WorkspaceShellLazyLifecycleGroupControllerLike
  >;

  constructor(options: WorkspaceShellLazyLifecycleGroupControllerOptions) {
    this.host = new WorkspaceShellLazyDelegateCallHostController({
      createDelegate: createWorkspaceShellLazyLifecycleGroupControllerLoader(options),
      loadFailureMessage: LAZY_LIFECYCLE_NG_ON_INIT_STAGE_FAILURE_MESSAGE,
      warn: options.warn,
    });
  }

  run(
    method: keyof WorkspaceShellLazyLifecycleGroupControllerLike,
    failureMessage: string,
  ): void {
    this.host.run(controller => controller[method](), failureMessage);
  }
}
