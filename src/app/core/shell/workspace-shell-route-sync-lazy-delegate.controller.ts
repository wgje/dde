import { WorkspaceShellLazyDelegateCallHostController } from './workspace-shell-lazy-delegate-call-host.controller';
import {
  createWorkspaceShellRouteSyncControllerLoader,
  type WorkspaceShellRouteSyncControllerLike,
} from './workspace-shell-route-sync-controller-loader.factory';
import type {
  WorkspaceShellRouteSyncFactoryOptions,
} from './workspace-shell-route-sync.factory';

const ROUTE_SYNC_LOAD_FAILURE_MESSAGE =
  'Workspace route sync controller 懒加载失败，已跳过本次路由同步';
const ROUTE_SYNC_OPERATION_FAILURE_MESSAGE =
  'Workspace route sync controller 操作执行失败，已跳过本次路由同步';

export class WorkspaceShellRouteSyncLazyDelegateController {
  private readonly host: WorkspaceShellLazyDelegateCallHostController<
    WorkspaceShellRouteSyncControllerLike
  >;

  constructor(options: WorkspaceShellRouteSyncFactoryOptions) {
    const loadRouteSyncController = createWorkspaceShellRouteSyncControllerLoader({
      options,
    });
    this.host = new WorkspaceShellLazyDelegateCallHostController({
      createDelegate: () => loadRouteSyncController(),
      loadFailureMessage: ROUTE_SYNC_LOAD_FAILURE_MESSAGE,
      teardownFailureMessage: 'Workspace route sync controller 清理失败，已跳过',
      warn: options.warn,
    });
  }

  setupRouteSync(): void {
    this.host.run(
      controller => controller.setupRouteSync(),
      ROUTE_SYNC_OPERATION_FAILURE_MESSAGE,
      ROUTE_SYNC_LOAD_FAILURE_MESSAGE,
    );
  }

  cleanup(): void {
    this.host.runIfLoaded(controller => controller.cleanup());
  }

  syncStateFromRoute(): void {
    this.host.run(
      controller => controller.syncStateFromRoute(),
      ROUTE_SYNC_OPERATION_FAILURE_MESSAGE,
      ROUTE_SYNC_LOAD_FAILURE_MESSAGE,
    );
  }

  updateUrlForProject(projectId: string): void {
    this.host.run(
      controller => controller.updateUrlForProject(projectId),
      ROUTE_SYNC_OPERATION_FAILURE_MESSAGE,
      ROUTE_SYNC_LOAD_FAILURE_MESSAGE,
    );
  }
}
