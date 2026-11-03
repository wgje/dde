import type {
  WorkspaceShellToolLazyLoadHosts,
} from './workspace-shell-tool-lazy-load-hosts.factory';

export interface WorkspaceShellToolLazyLoadHostsLoaderControllerOptions {
  loadHosts: () => Promise<WorkspaceShellToolLazyLoadHosts>;
  warn: (message: string, error: unknown) => void;
}

interface WorkspaceShellToolLazyLoadTeardownDelegate {
  teardown(): void;
}

export class WorkspaceShellToolLazyLoadHostsLoaderController {
  private hostsPromise: Promise<WorkspaceShellToolLazyLoadHosts> | null = null;
  private hostsInstance: WorkspaceShellToolLazyLoadHosts | null = null;
  private isTornDown = false;
  private didTearDownHosts = false;

  constructor(
    private readonly options: WorkspaceShellToolLazyLoadHostsLoaderControllerOptions,
  ) {}

  load(): Promise<WorkspaceShellToolLazyLoadHosts> {
    if (this.hostsInstance) {
      return Promise.resolve(this.hostsInstance);
    }

    return (this.hostsPromise ??= Promise.resolve()
      .then(() => this.options.loadHosts())
      .then(hosts => {
        this.hostsInstance = hosts;
        if (this.isTornDown) {
          this.teardownHostsOnce();
        }
        return hosts;
      })
      .catch(error => {
        this.hostsPromise = null;
        throw error;
      }));
  }

  teardown(): void {
    if (this.isTornDown) return;
    this.isTornDown = true;

    if (this.hostsInstance) {
      this.teardownHostsOnce();
      return;
    }

    void this.hostsPromise?.catch(error => {
      this.options.warn(
        '工作区工具 hosts lazy-load 清理失败，已继续清理后续工具',
        error,
      );
    });
  }

  private teardownHostsOnce(): void {
    if (!this.hostsInstance || this.didTearDownHosts) return;
    this.didTearDownHosts = true;
    this.teardownDelegate(
      'focusToolsLazyLoad.inner',
      this.hostsInstance.focusToolsLazyLoad,
    );
    this.teardownDelegate(
      'sidebarToolsLazyLoad.inner',
      this.hostsInstance.sidebarToolsLazyLoad,
    );
  }

  private teardownDelegate(
    label: string,
    delegate: WorkspaceShellToolLazyLoadTeardownDelegate,
  ): void {
    try {
      delegate.teardown();
    } catch (error) {
      this.options.warn(
        `工作区工具懒加载 ${label} 清理失败，已继续清理后续工具`,
        error,
      );
    }
  }
}
