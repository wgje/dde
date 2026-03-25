import { Inject, Injectable, InjectionToken, signal } from '@angular/core';

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
  private routeShellsPromise: Promise<void> | null = null;
  private started = false;

  /** @deprecated styles.css 已恢复到静态构建，此信号始终为 true。保留以兼容引用。 */
  readonly workspaceStylesReady = signal(true);
  readonly routeShellsReady = signal(false);

  constructor(
    @Inject(WORKSPACE_STARTUP_ASSET_LOADER)
    private readonly assetLoader: WorkspaceStartupAssetLoader,
  ) {}

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    void this.preloadRouteShells();
  }

  /** @deprecated styles.css 已静态打包，无需预加载。保留以兼容调用方。 */
  preloadWorkspaceStyles(): Promise<void> {
    return Promise.resolve();
  }

  preloadRouteShells(): Promise<void> {
    if (this.routeShellsReady()) {
      return Promise.resolve();
    }

    if (this.routeShellsPromise) {
      return this.routeShellsPromise;
    }

    this.routeShellsPromise = Promise.all([
      this.assetLoader.preloadWorkspaceShell(),
      this.assetLoader.preloadProjectShell(),
    ])
      .then(() => {
        this.routeShellsReady.set(true);
      })
      .catch(() => {
        // 预热失败不阻断路由按需加载。
      })
      .finally(() => {
        this.routeShellsPromise = null;
      });

    return this.routeShellsPromise;
  }
}
