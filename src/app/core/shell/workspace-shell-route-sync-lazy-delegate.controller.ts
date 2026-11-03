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

interface WorkspaceShellRouteSyncLazyDelegate {
  setupRouteSync(): void;
  syncStateFromRoute(): void;
  teardown(): void;
  updateUrlForProject(projectId: string): void;
}

function createRouteSyncLazyDelegate(
  controller: WorkspaceShellRouteSyncControllerLike,
): WorkspaceShellRouteSyncLazyDelegate {
  return {
    setupRouteSync: () => controller.setupRouteSync(),
    syncStateFromRoute: () => controller.syncStateFromRoute(),
    teardown: () => controller.cleanup(),
    updateUrlForProject: projectId => controller.updateUrlForProject(projectId),
  };
}

export class WorkspaceShellRouteSyncLazyDelegateController {
  private readonly host: WorkspaceShellLazyDelegateCallHostController<
    WorkspaceShellRouteSyncLazyDelegate
  >;

  constructor(options: WorkspaceShellRouteSyncFactoryOptions) {
    const loadRouteSyncController = createWorkspaceShellRouteSyncControllerLoader({
      options,
    });
    this.host = new WorkspaceShellLazyDelegateCallHostController({
      createDelegate: () => loadRouteSyncController()
        .then(createRouteSyncLazyDelegate),
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
    this.host.teardown();
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
