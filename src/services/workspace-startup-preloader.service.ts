import { Inject, Injectable, InjectionToken, computed, signal } from '@angular/core';

export interface WorkspaceStartupAssetLoader {
  preloadWorkspaceShell: () => Promise<unknown>;
  preloadProjectShell: () => Promise<unknown>;
}

export const WORKSPACE_STARTUP_ASSET_LOADER = new InjectionToken<WorkspaceStartupAssetLoader>(
  'WORKSPACE_STARTUP_ASSET_LOADER',
  {
    providedIn: 'root',
    factory: () => ({
      preloadWorkspaceShell: () => import('../workspace-shell.component'),
      preloadProjectShell: () => import('../app/core/shell/project-shell.component'),
    }),
  },
);

@Injectable({
  providedIn: 'root',
})
export class WorkspaceStartupPreloaderService {
  private workspaceShellPromise: Promise<void> | null = null;
  private projectShellPromise: Promise<void> | null = null;
  private started = false;

  /** @deprecated styles.css 已恢复到静态构建，此信号始终为 true。保留以兼容引用。 */
  readonly workspaceStylesReady = signal(true);
  readonly workspaceShellReady = signal(false);
  readonly projectShellReady = signal(false);
  /** 两阶段全部完成（computed 自动派生） */
  readonly routeShellsReady = computed(() => this.workspaceShellReady() && this.projectShellReady());

  constructor(
    @Inject(WORKSPACE_STARTUP_ASSET_LOADER)
    private readonly assetLoader: WorkspaceStartupAssetLoader,
  ) {}

  /**
   * 第一阶段：仅预热 workspace-shell。
   * 由 AppComponent 构造函数调用，launch-shell 渲染前即可开始。
   */
  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    void this.preloadWorkspaceShell();
  }

  /**
   * 第二阶段：预热 project-shell。
   * 应在 initial-loader 淡出后调用（nanoflow:loader-hidden 事件），
   * 避免与首屏渲染争抢主线程。
   */
  scheduleProjectShellPreload(): void {
    void this.preloadProjectShell();
  }

  /** @deprecated styles.css 已静态打包，无需预加载。保留以兼容调用方。 */
  preloadWorkspaceStyles(): Promise<void> {
    return Promise.resolve();
  }

  preloadWorkspaceShell(): Promise<void> {
    if (this.workspaceShellReady()) {
      return Promise.resolve();
    }

    if (this.workspaceShellPromise) {
      return this.workspaceShellPromise;
    }

    this.workspaceShellPromise = this.assetLoader
      .preloadWorkspaceShell()
      .then(() => {
        this.workspaceShellReady.set(true);
      })
      .catch(() => {
        // 预热失败不阻断路由按需加载。
      })
      .finally(() => {
        this.workspaceShellPromise = null;
      });

    return this.workspaceShellPromise;
  }

  preloadProjectShell(): Promise<void> {
    if (this.projectShellReady()) {
      return Promise.resolve();
    }

    if (this.projectShellPromise) {
      return this.projectShellPromise;
    }

    this.projectShellPromise = this.assetLoader
      .preloadProjectShell()
      .then(() => {
        this.projectShellReady.set(true);
      })
      .catch(() => {
        // 预热失败不阻断路由按需加载。
      })
      .finally(() => {
        this.projectShellPromise = null;
      });

    return this.projectShellPromise;
  }

  /** 向后兼容：并行加载两阶段。 */
  preloadRouteShells(): Promise<void> {
    return Promise.all([this.preloadWorkspaceShell(), this.preloadProjectShell()]).then(() => {});
  }
}
