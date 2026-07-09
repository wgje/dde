import { signal, type Injector, type Signal } from '@angular/core';
import type { Project, Task } from '../../../models';
import { WorkspaceShellLazyDelegateCallHostController } from './workspace-shell-lazy-delegate-call-host.controller';
import {
  createWorkspaceShellSearchServiceLoader,
} from './workspace-shell-search-service-loader.factory';

const SEARCH_SERVICE_LOAD_FAILURE_MESSAGE = '搜索服务懒加载失败，搜索结果暂不可用';

export type WorkspaceShellSearchTask = Task & { _isParked?: boolean };

export interface WorkspaceShellSearchServiceLike {
  readonly filteredProjects: Signal<Project[]>;
  readonly searchResults: Signal<WorkspaceShellSearchTask[]>;
}

export interface WorkspaceShellSearchLazyLoadControllerOptions {
  destroyed?: () => boolean;
  fallbackProjects: Signal<Project[]>;
  hasActiveSearchQuery: () => boolean;
  warn: (message: string, error: unknown) => void;
  injector?: Injector;
  loadSearchService?: () => Promise<WorkspaceShellSearchServiceLike>;
}

export class WorkspaceShellSearchLazyLoadController {
  private readonly host: WorkspaceShellLazyDelegateCallHostController<WorkspaceShellSearchServiceLike>;
  private readonly emptySearchResults = signal<WorkspaceShellSearchTask[]>([]);
  private readonly searchServiceReady = signal(false);

  constructor(private readonly options: WorkspaceShellSearchLazyLoadControllerOptions) {
    this.host = new WorkspaceShellLazyDelegateCallHostController({
      createDelegate: () => this.resolveLoadedSearchService(
        createWorkspaceShellSearchServiceLoader(this.options)(),
      ),
      loadFailureMessage: SEARCH_SERVICE_LOAD_FAILURE_MESSAGE,
      warn: options.warn,
    });
  }

  get searchResults(): Signal<WorkspaceShellSearchTask[]> {
    this.searchServiceReady();
    if (!this.isDestroyed() && this.options.hasActiveSearchQuery()) {
      this.ensureLoaded();
    }

    return this.host.loadedDelegate?.searchResults ?? this.emptySearchResults;
  }

  get filteredProjects(): Signal<Project[]> {
    this.searchServiceReady();
    if (!this.isDestroyed() && this.options.hasActiveSearchQuery()) {
      this.ensureLoaded();
    }

    return this.host.loadedDelegate?.filteredProjects ?? this.options.fallbackProjects;
  }

  ensureLoaded(): void {
    if (this.isDestroyed()) {
      this.host.teardown();
      return;
    }

    void this.loadSearchService();
  }

  private loadSearchService(): Promise<void> {
    return this.host.call(() => {
      this.searchServiceReady.set(true);
    }, undefined);
  }

  private resolveLoadedSearchService(
    service: WorkspaceShellSearchServiceLike | Promise<WorkspaceShellSearchServiceLike>,
  ): Promise<WorkspaceShellSearchServiceLike> {
    return Promise.resolve(service)
      .then(resolvedService => {
        if (this.isDestroyed()) {
          this.host.teardown();
        }

        return resolvedService;
      });
  }

  private isDestroyed(): boolean {
    return this.options.destroyed?.() ?? false;
  }
}
