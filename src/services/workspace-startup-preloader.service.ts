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
  private loaderHandoffPromise: Promise<void> | null = null;
  private started = false;
  private loaderHandoffStarted = false;

  /** @deprecated styles.css 已恢复到静态构建，此信号始终为 true。保留以兼容引用。 */
  readonly workspaceStylesReady = signal(true);
  readonly workspaceShellReady = signal(false);
  readonly projectShellReady = signal(false);
  readonly routeShellsReady = computed(() => this.workspaceShellReady() && this.projectShellReady());

  constructor(
    @Inject(WORKSPACE_STARTUP_ASSET_LOADER)
    private readonly assetLoader: WorkspaceStartupAssetLoader,
  ) {}

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    void this.preloadWorkspaceShell();
  }

  /** @deprecated styles.css 已静态打包，无需预加载。保留以兼容调用方。 */
  preloadWorkspaceStyles(): Promise<void> {
    return Promise.resolve();
  }

  preloadRouteShells(): Promise<void> {
    return this.continueAfterLoaderHidden();
  }

  continueAfterLoaderHidden(): Promise<void> {
    if (this.routeShellsReady()) {
      return Promise.resolve();
    }

    if (this.loaderHandoffStarted && this.loaderHandoffPromise) {
      return this.loaderHandoffPromise;
    }

    this.loaderHandoffStarted = true;
    this.loaderHandoffPromise = this.preloadWorkspaceShell()
      .then(() => this.preloadProjectShell())
      .catch(() => {
        // 预热失败不阻断路由按需加载。
      })
      .finally(() => {
        this.loaderHandoffPromise = null;
      });

    return this.loaderHandoffPromise;
  }

  private preloadWorkspaceShell(): Promise<void> {
    if (this.workspaceShellReady()) {
      return Promise.resolve();
    }

    if (this.workspaceShellPromise) {
      return this.workspaceShellPromise;
    }

    this.workspaceShellPromise = this.assetLoader.preloadWorkspaceShell()
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

  private preloadProjectShell(): Promise<void> {
    if (this.projectShellReady()) {
      return Promise.resolve();
    }

    if (this.projectShellPromise) {
      return this.projectShellPromise;
    }

    this.projectShellPromise = this.assetLoader.preloadProjectShell()
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
}
