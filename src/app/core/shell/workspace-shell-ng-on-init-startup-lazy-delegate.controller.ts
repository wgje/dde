import type {
  WorkspaceShellNgOnInitStartupControllerLike,
} from './workspace-shell-ng-on-init-startup.factory';
import { WorkspaceShellLazyDelegateCallHostController } from './workspace-shell-lazy-delegate-call-host.controller';

const NG_ON_INIT_STARTUP_LOAD_FAILURE_MESSAGE =
  'ngOnInit startup lazy-load host 加载失败，已跳过本次启动编排';
const NG_ON_INIT_STARTUP_TEARDOWN_FAILURE_MESSAGE =
  'ngOnInit startup lazy-load host 清理失败，已跳过';

export interface WorkspaceShellNgOnInitStartupLazyDelegateControllerOptions {
  loadDelegate: () => Promise<WorkspaceShellNgOnInitStartupControllerLike>;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellNgOnInitStartupLazyDelegateController
implements WorkspaceShellNgOnInitStartupControllerLike {
  private readonly host: WorkspaceShellLazyDelegateCallHostController<
    WorkspaceShellNgOnInitStartupControllerLike
  >;

  constructor(options: WorkspaceShellNgOnInitStartupLazyDelegateControllerOptions) {
    this.host = new WorkspaceShellLazyDelegateCallHostController({
      createDelegate: options.loadDelegate,
      loadFailureMessage: NG_ON_INIT_STARTUP_LOAD_FAILURE_MESSAGE,
      teardownFailureMessage: NG_ON_INIT_STARTUP_TEARDOWN_FAILURE_MESSAGE,
      warn: options.warn,
    });
  }

  initialize(): void {
    this.host.run(controller => controller.initialize());
  }

  teardown(): void {
    this.host.teardown();
  }
}
