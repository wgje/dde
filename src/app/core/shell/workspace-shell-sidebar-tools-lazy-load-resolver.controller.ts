import type {
  WorkspaceShellSidebarToolsLazyLoadControllerOptions,
  WorkspaceShellSidebarToolsPreloadReason,
} from './workspace-shell-sidebar-tools-lazy-load.controller';
import {
  WorkspaceShellSidebarToolsLazyDelegateHostController,
  type WorkspaceShellSidebarToolsLazyDelegate,
} from './workspace-shell-sidebar-tools-lazy-delegate-host.controller';
import {
  createWorkspaceShellSidebarToolsLazyLoadControllerLoader,
} from './workspace-shell-sidebar-tools-lazy-load-controller-loader.factory';

const SIDEBAR_TOOLS_LAZY_CONTROLLER_LOAD_FAILURE_MESSAGE =
  '侧栏工具 lazy-load 控制器加载失败，侧栏工具暂不可用';
const SIDEBAR_TOOLS_LAZY_CONTROLLER_OPERATION_FAILURE_MESSAGE =
  '侧栏工具 lazy-load 控制器操作失败，已跳过';
const SIDEBAR_TOOLS_LAZY_CONTROLLER_TEARDOWN_FAILURE_MESSAGE =
  '侧栏工具 lazy-load 控制器清理失败，已跳过';

export type { WorkspaceShellSidebarToolsPreloadReason } from './workspace-shell-sidebar-tools-lazy-load.controller';

export interface WorkspaceShellSidebarToolsLazyLoadControllerLike
  extends WorkspaceShellSidebarToolsLazyDelegate {
  loadBlackBoxRecorderComponent(): Promise<unknown>;
  loadFocusSessionTriggerComponent(): Promise<unknown>;
  onToolsIntent(): void;
  onVoiceTranscribed(text: string): void;
  preload(reason: WorkspaceShellSidebarToolsPreloadReason): void;
  preloadFocusModeAssets(reason: WorkspaceShellSidebarToolsPreloadReason): Promise<void>;
  scheduleFocusModePreload(reason: 'startup' | 'p1'): void;
  teardown(): void;
}

export interface WorkspaceShellSidebarToolsLazyLoadResolverOptions
  extends Partial<WorkspaceShellSidebarToolsLazyLoadControllerOptions> {
  createSidebarToolsController?: () => Promise<WorkspaceShellSidebarToolsLazyLoadControllerLike>;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellSidebarToolsLazyLoadResolverController {
  private readonly host:
    WorkspaceShellSidebarToolsLazyDelegateHostController<WorkspaceShellSidebarToolsLazyLoadControllerLike>;

  constructor(options: WorkspaceShellSidebarToolsLazyLoadResolverOptions) {
    this.host = new WorkspaceShellSidebarToolsLazyDelegateHostController({
      createDelegate: createWorkspaceShellSidebarToolsLazyLoadControllerLoader(options),
      loadFailureMessage: SIDEBAR_TOOLS_LAZY_CONTROLLER_LOAD_FAILURE_MESSAGE,
      operationFailureMessage: SIDEBAR_TOOLS_LAZY_CONTROLLER_OPERATION_FAILURE_MESSAGE,
      teardownFailureMessage: SIDEBAR_TOOLS_LAZY_CONTROLLER_TEARDOWN_FAILURE_MESSAGE,
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
