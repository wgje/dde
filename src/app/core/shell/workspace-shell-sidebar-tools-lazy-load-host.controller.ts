import {
  type WorkspaceShellSidebarToolsLazyLoadControllerLike,
  type WorkspaceShellSidebarToolsLazyLoadResolverOptions,
  type WorkspaceShellSidebarToolsPreloadReason,
} from './workspace-shell-sidebar-tools-lazy-load-resolver.controller';
import {
  WorkspaceShellSidebarToolsLazyDelegateHostController,
} from './workspace-shell-sidebar-tools-lazy-delegate-host.controller';
import {
  createWorkspaceShellSidebarToolsResolverLoader,
} from './workspace-shell-sidebar-tools-resolver-loader.factory';

const SIDEBAR_TOOLS_RESOLVER_LOAD_FAILURE_MESSAGE =
  '侧栏工具 lazy-load resolver 加载失败，侧栏工具暂不可用';
const SIDEBAR_TOOLS_RESOLVER_OPERATION_FAILURE_MESSAGE =
  '侧栏工具 lazy-load resolver 操作失败，已跳过';
const SIDEBAR_TOOLS_RESOLVER_TEARDOWN_FAILURE_MESSAGE =
  '侧栏工具 lazy-load resolver 清理失败，已跳过';

export type WorkspaceShellSidebarToolsHostDelegate =
  WorkspaceShellSidebarToolsLazyLoadControllerLike;

export interface WorkspaceShellSidebarToolsLazyLoadHostOptions
  extends Partial<WorkspaceShellSidebarToolsLazyLoadResolverOptions> {
  createSidebarToolsController?: () => Promise<WorkspaceShellSidebarToolsHostDelegate>;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellSidebarToolsLazyLoadHostController {
  private readonly host:
    WorkspaceShellSidebarToolsLazyDelegateHostController<WorkspaceShellSidebarToolsHostDelegate>;

  constructor(options: WorkspaceShellSidebarToolsLazyLoadHostOptions) {
    this.host = new WorkspaceShellSidebarToolsLazyDelegateHostController({
      createDelegate: createWorkspaceShellSidebarToolsResolverLoader(options),
      loadFailureMessage: SIDEBAR_TOOLS_RESOLVER_LOAD_FAILURE_MESSAGE,
      operationFailureMessage: SIDEBAR_TOOLS_RESOLVER_OPERATION_FAILURE_MESSAGE,
      teardownFailureMessage: SIDEBAR_TOOLS_RESOLVER_TEARDOWN_FAILURE_MESSAGE,
      warn: options.warn,
    });
  }

  onVoiceTranscribed(text: string): void {
    this.host.onVoiceTranscribed(text);
  }

  onToolsIntent(): void {
    this.host.onToolsIntent();
  }

  preload(reason: WorkspaceShellSidebarToolsPreloadReason): void {
    this.host.preload(reason);
  }

  loadFocusSessionTriggerComponent(): Promise<unknown> {
    return this.host.loadFocusSessionTriggerComponent();
  }

  loadBlackBoxRecorderComponent(): Promise<unknown> {
    return this.host.loadBlackBoxRecorderComponent();
  }

  preloadFocusModeAssets(reason: WorkspaceShellSidebarToolsPreloadReason): Promise<void> {
    return this.host.preloadFocusModeAssets(reason);
  }

  scheduleFocusModePreload(reason: 'startup' | 'p1'): void {
    this.host.scheduleFocusModePreload(reason);
  }

  teardown(): void {
    this.host.teardown();
  }
}
