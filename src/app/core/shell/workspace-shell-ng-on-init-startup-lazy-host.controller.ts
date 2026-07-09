import { WorkspaceShellLazyDelegateCallHostController } from './workspace-shell-lazy-delegate-call-host.controller';
import {
  createWorkspaceShellNgOnInitStartupControllerLoader,
} from './workspace-shell-ng-on-init-startup-controller-loader.factory';
import type {
  WorkspaceShellNgOnInitStartupHostDelegate,
  WorkspaceShellNgOnInitStartupLazyLoadHostOptions,
} from './workspace-shell-ng-on-init-startup-lazy-load-host.controller';

const NG_ON_INIT_STARTUP_LOAD_FAILURE_MESSAGE =
  'ngOnInit startup controller 懒加载失败，已跳过本次启动编排';
const NG_ON_INIT_STARTUP_INITIALIZE_FAILURE_MESSAGE =
  'ngOnInit startup controller 初始化失败，已跳过本次启动编排';
const NG_ON_INIT_STARTUP_TEARDOWN_FAILURE_MESSAGE =
  'ngOnInit startup controller 清理失败，已跳过';

export interface WorkspaceShellNgOnInitStartupLazyHostControllerOptions
  extends WorkspaceShellNgOnInitStartupLazyLoadHostOptions {}

export class WorkspaceShellNgOnInitStartupLazyHostController {
  private readonly host: WorkspaceShellLazyDelegateCallHostController<
    WorkspaceShellNgOnInitStartupHostDelegate
  >;

  constructor(options: WorkspaceShellNgOnInitStartupLazyHostControllerOptions) {
    this.host = new WorkspaceShellLazyDelegateCallHostController({
      createDelegate: createWorkspaceShellNgOnInitStartupControllerLoader(options),
      loadFailureMessage: NG_ON_INIT_STARTUP_LOAD_FAILURE_MESSAGE,
      teardownFailureMessage: NG_ON_INIT_STARTUP_TEARDOWN_FAILURE_MESSAGE,
      warn: options.warn,
    });
  }

  initialize(): void {
    this.host.run(
      controller => controller.initialize(),
      NG_ON_INIT_STARTUP_INITIALIZE_FAILURE_MESSAGE,
      NG_ON_INIT_STARTUP_LOAD_FAILURE_MESSAGE,
    );
  }

  teardown(): void {
    this.host.teardown();
  }
}
