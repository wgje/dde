import {
  createWorkspaceShellFlowPrewarmControllerLoader,
} from './workspace-shell-flow-prewarm-controller-loader.factory';
import { WorkspaceShellLazyDelegateCallHostController } from './workspace-shell-lazy-delegate-call-host.controller';
import type {
  WorkspaceShellFlowPrewarmControllerOptions,
} from './workspace-shell-flow-prewarm.controller';

export interface WorkspaceShellFlowPrewarmDelegate {
  scheduleAggressivePrewarm(reason: string): void;
  teardown(): void;
}

type WorkspaceShellFlowPrewarmDelegateFactory =
  () => Promise<WorkspaceShellFlowPrewarmDelegate>;

export class WorkspaceShellFlowPrewarmLazyLoadController
implements WorkspaceShellFlowPrewarmDelegate {
  private readonly host: WorkspaceShellLazyDelegateCallHostController<
    WorkspaceShellFlowPrewarmDelegate
  >;

  constructor(
    options: WorkspaceShellFlowPrewarmControllerOptions,
    createDelegate: WorkspaceShellFlowPrewarmDelegateFactory =
      createWorkspaceShellFlowPrewarmControllerLoader(options),
  ) {
    this.host = new WorkspaceShellLazyDelegateCallHostController({
      createDelegate,
      loadFailureMessage: 'Flow 预热控制器懒加载失败，已跳过本次预热',
      teardownFailureMessage: 'Flow 预热控制器清理失败，已跳过',
      warn: options.warn,
    });
  }

  scheduleAggressivePrewarm(reason: string): void {
    this.host.run(controller => controller.scheduleAggressivePrewarm(reason));
  }

  teardown(): void {
    this.host.teardown();
  }
}

export function createWorkspaceShellFlowPrewarmLazyLoadController(
  options: WorkspaceShellFlowPrewarmControllerOptions,
  createDelegate: WorkspaceShellFlowPrewarmDelegateFactory =
    createWorkspaceShellFlowPrewarmControllerLoader(options),
): WorkspaceShellFlowPrewarmDelegate {
  return new WorkspaceShellFlowPrewarmLazyLoadController(options, createDelegate);
}
