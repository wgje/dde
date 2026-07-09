import {
  WorkspaceShellSidebarResizeAsyncDelegateController,
  type WorkspaceShellSidebarResizeAsyncDelegate,
} from './workspace-shell-sidebar-resize-async-delegate.controller';
import {
  createWorkspaceShellSidebarResizeDelegate,
  type WorkspaceShellSidebarResizeServiceLike,
} from './workspace-shell-sidebar-resize-delegate.factory';
import {
  WorkspaceShellSidebarResizeDelegateHostController,
} from './workspace-shell-sidebar-resize-delegate-host.controller';

export type {
  WorkspaceShellSidebarResizeServiceLike,
} from './workspace-shell-sidebar-resize-delegate.factory';

export interface WorkspaceShellSidebarResizeLazyLoadControllerOptions {
  destroyed: () => boolean;
  warn: (message: string, error: unknown) => void;
  loadSidebarResize: () => Promise<WorkspaceShellSidebarResizeServiceLike>;
}

export class WorkspaceShellSidebarResizeLazyLoadController {
  private readonly host: WorkspaceShellSidebarResizeDelegateHostController;

  constructor(private readonly options: WorkspaceShellSidebarResizeLazyLoadControllerOptions) {
    const delegate = new WorkspaceShellSidebarResizeAsyncDelegateController({
      loadDelegate: () => this.createResizeDelegate(),
      resolveFailureMessage: target => target === 'sidebar'
        ? '侧栏拖拽服务懒加载失败，已跳过本次拖拽'
        : '内容列拖拽服务懒加载失败，已跳过本次拖拽',
      resolveStartFailureMessage: target => target === 'sidebar'
        ? '侧栏拖拽服务启动失败，已跳过本次拖拽'
        : '内容列拖拽服务启动失败，已跳过本次拖拽',
      teardownFailureMessage: '侧栏拖拽服务清理失败，已跳过',
      warn: options.warn,
    });
    this.host = new WorkspaceShellSidebarResizeDelegateHostController({
      delegate,
      destroyed: options.destroyed,
    });
  }

  setup(): void {
    this.host.setup();
  }

  isResizingAny(): boolean {
    return this.host.isResizingAny();
  }

  startSidebarResize(event: MouseEvent): void {
    this.host.startSidebarResize(event);
  }

  startContentResize(event: MouseEvent): void {
    this.host.startContentResize(event);
  }

  onMouseMove(event: MouseEvent): void {
    this.host.onMouseMove(event);
  }

  onMouseUp(): void {
    this.host.onMouseUp();
  }

  teardown(): void {
    this.host.teardown();
  }

  private createResizeDelegate(): Promise<WorkspaceShellSidebarResizeAsyncDelegate> {
    return this.resolveSidebarResize()
      .then(service => createWorkspaceShellSidebarResizeDelegate({
        destroyed: this.options.destroyed,
        service,
      }));
  }

  private resolveSidebarResize(): Promise<WorkspaceShellSidebarResizeServiceLike> {
    return this.options.loadSidebarResize();
  }
}
