import { Inject, Injectable, InjectionToken, signal } from '@angular/core';

export interface WorkspaceStartupAssetLoader {
  loadWorkspaceStyles: () => Promise<unknown>;
  preloadWorkspaceShell: () => Promise<unknown>;
  preloadProjectShell: () => Promise<unknown>;
}

export const WORKSPACE_STARTUP_ASSET_LOADER = new InjectionToken<WorkspaceStartupAssetLoader>(
  'WORKSPACE_STARTUP_ASSET_LOADER',
  {
    providedIn: 'root',
    factory: () => ({
      loadWorkspaceStyles: () => import('../styles.css'),
      preloadWorkspaceShell: () => import('../workspace-shell.component'),
      preloadProjectShell: () => import('../app/core/shell/project-shell.component'),
    }),
  },
);

@Injectable({
  providedIn: 'root',
})
export class WorkspaceStartupPreloaderService {
  private stylesPromise: Promise<void> | null = null;
  private routeShellsPromise: Promise<void> | null = null;
  private started = false;

  readonly workspaceStylesReady = signal(false);
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
    void this.preloadWorkspaceStyles();
    void this.preloadRouteShells();
  }

  preloadWorkspaceStyles(): Promise<void> {
    if (this.workspaceStylesReady()) {
      return Promise.resolve();
    }

    if (this.stylesPromise) {
      return this.stylesPromise;
    }

    this.stylesPromise = this.assetLoader.loadWorkspaceStyles()
      .then(() => {
        this.workspaceStylesReady.set(true);
      })
      .catch(() => {
        this.workspaceStylesReady.set(true);
      })
      .finally(() => {
        this.stylesPromise = null;
      });

    return this.stylesPromise;
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
