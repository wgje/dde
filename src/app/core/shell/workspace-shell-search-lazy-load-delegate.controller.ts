import { signal, type Signal } from '@angular/core';
import type { Project } from '../../../models';
import type { WorkspaceShellSearchTask } from './workspace-shell-search-lazy-load.controller';
import {
  createWorkspaceShellSearchLazyLoadControllerLoader,
} from './workspace-shell-search-lazy-load-controller-loader.factory';
import { WorkspaceShellLazyDelegateCallHostController } from './workspace-shell-lazy-delegate-call-host.controller';
import type {
  WorkspaceShellSearchLazyLoadDelegate,
  WorkspaceShellSearchLazyLoadDelegateOptions,
} from './workspace-shell-search-lazy-load-delegate.factory';

const SEARCH_LAZY_LOAD_FAILURE_MESSAGE =
  '搜索 lazy-load delegate 加载失败，搜索结果暂不可用';
const SEARCH_LAZY_LOAD_INITIALIZE_FAILURE_MESSAGE =
  '搜索 lazy-load delegate 初始化失败，搜索结果暂不可用';

export class WorkspaceShellSearchLazyLoadDelegateController
implements WorkspaceShellSearchLazyLoadDelegate {
  private readonly delegate = signal<WorkspaceShellSearchLazyLoadDelegate | null>(null);
  private readonly emptySearchResults = signal<WorkspaceShellSearchTask[]>([]);
  private readonly host: WorkspaceShellLazyDelegateCallHostController<
    WorkspaceShellSearchLazyLoadDelegate
  >;

  constructor(private readonly options: WorkspaceShellSearchLazyLoadDelegateOptions) {
    const loadSearchDelegate = createWorkspaceShellSearchLazyLoadControllerLoader({
      loadSearchDelegate: options.loadSearchDelegate,
      options,
    });
    this.host = new WorkspaceShellLazyDelegateCallHostController({
      createDelegate: () => loadSearchDelegate(),
      loadFailureMessage: SEARCH_LAZY_LOAD_FAILURE_MESSAGE,
      warn: options.warn,
    });
  }

  get searchResults(): Signal<WorkspaceShellSearchTask[]> {
    const resolvedDelegate = this.delegate();
    if (this.options.hasActiveSearchQuery()) {
      this.ensureLoaded();
    }

    return resolvedDelegate?.searchResults ?? this.emptySearchResults;
  }

  get filteredProjects(): Signal<Project[]> {
    const resolvedDelegate = this.delegate();
    if (this.options.hasActiveSearchQuery()) {
      this.ensureLoaded();
    }

    return resolvedDelegate?.filteredProjects ?? this.options.fallbackProjects;
  }

  ensureLoaded(): void {
    if (this.delegate() || this.options.destroyed?.()) {
      return;
    }

    void this.host.call(
      resolvedDelegate => {
        resolvedDelegate.ensureLoaded();
        this.delegate.set(resolvedDelegate);
      },
      undefined,
      SEARCH_LAZY_LOAD_INITIALIZE_FAILURE_MESSAGE,
      SEARCH_LAZY_LOAD_FAILURE_MESSAGE,
    );
  }
}
