import type {
  WorkspaceShellSidebarResizeDeferredLazyLoadHostDelegate,
} from './workspace-shell-sidebar-resize-deferred-lazy-load-host.controller';
import { WorkspaceShellLazyDelegateCallHostController } from './workspace-shell-lazy-delegate-call-host.controller';

const SIDEBAR_RESIZE_HOST_LOAD_FAILURE_MESSAGE =
  '侧栏拖拽加载失败，已跳过';
const SIDEBAR_RESIZE_HOST_TEARDOWN_FAILURE_MESSAGE =
  '侧栏拖拽 lazy-load host 清理失败，已跳过';

export type WorkspaceShellInteractionSidebarResizeLazyHostDelegate =
  WorkspaceShellSidebarResizeDeferredLazyLoadHostDelegate;

export interface WorkspaceShellInteractionSidebarResizeLazyHostControllerOptions {
  loadSidebarResizeHost: () => Promise<WorkspaceShellInteractionSidebarResizeLazyHostDelegate>;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellInteractionSidebarResizeLazyHostController {
  private readonly host: WorkspaceShellLazyDelegateCallHostController<
    WorkspaceShellInteractionSidebarResizeLazyHostDelegate
  >;

  constructor(
    options: WorkspaceShellInteractionSidebarResizeLazyHostControllerOptions,
  ) {
    this.host = new WorkspaceShellLazyDelegateCallHostController({
      createDelegate: options.loadSidebarResizeHost,
      loadFailureMessage: SIDEBAR_RESIZE_HOST_LOAD_FAILURE_MESSAGE,
      teardownFailureMessage: SIDEBAR_RESIZE_HOST_TEARDOWN_FAILURE_MESSAGE,
      warn: options.warn,
    });
  }

  get loadedDelegate(): WorkspaceShellInteractionSidebarResizeLazyHostDelegate | null {
    return this.host.loadedDelegate;
  }

  runIfLoaded(
    action: (
      delegate: WorkspaceShellInteractionSidebarResizeLazyHostDelegate
    ) => void,
    failureMessage = SIDEBAR_RESIZE_HOST_LOAD_FAILURE_MESSAGE,
  ): void {
    this.host.runIfLoaded(action, failureMessage);
  }

  call<TResult>(
    action: (
      delegate: WorkspaceShellInteractionSidebarResizeLazyHostDelegate
    ) => TResult | Promise<TResult>,
    fallback: TResult,
    failureMessage = SIDEBAR_RESIZE_HOST_LOAD_FAILURE_MESSAGE,
  ): Promise<TResult> {
    return this.host.call(action, fallback, failureMessage);
  }

  teardown(): void {
    this.host.teardown();
  }
}
