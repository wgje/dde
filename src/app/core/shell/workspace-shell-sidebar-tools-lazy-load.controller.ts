import {
  type WorkspaceShellSidebarToolsControllerOptions,
  type WorkspaceShellSidebarToolsPreloadReason,
} from './workspace-shell-sidebar-tools.controller';
import {
  WorkspaceShellSidebarToolsLazyDelegateHostController,
  type WorkspaceShellSidebarToolsLazyDelegate,
} from './workspace-shell-sidebar-tools-lazy-delegate-host.controller';
import {
  createWorkspaceShellSidebarToolsControllerLoader,
} from './workspace-shell-sidebar-tools-controller-loader.factory';

const SIDEBAR_TOOLS_LOAD_FAILURE_MESSAGE =
  '侧栏工具控制器懒加载失败，侧栏工具暂不可用';
const SIDEBAR_TOOLS_OPERATION_FAILURE_MESSAGE =
  '侧栏工具控制器操作失败，已跳过';
const SIDEBAR_TOOLS_TEARDOWN_FAILURE_MESSAGE =
  '侧栏工具控制器清理失败，已跳过';

export type { WorkspaceShellSidebarToolsPreloadReason } from './workspace-shell-sidebar-tools.controller';

export interface WorkspaceShellSidebarToolsControllerLike
  extends WorkspaceShellSidebarToolsLazyDelegate {
  loadBlackBoxRecorderComponent(): Promise<unknown>;
  loadFocusSessionTriggerComponent(): Promise<unknown>;
  onToolsIntent(): void;
  onVoiceTranscribed(text: string): void;
  preload(reason: WorkspaceShellSidebarToolsPreloadReason): void;
  preloadFocusModeAssets(reason: WorkspaceShellSidebarToolsPreloadReason): Promise<void>;
  scheduleFocusModePreload(reason: 'startup' | 'p1'): void;
}

export interface WorkspaceShellSidebarToolsLazyLoadControllerOptions
  extends WorkspaceShellSidebarToolsControllerOptions {
  warn: (message: string, error: unknown) => void;
  createSidebarToolsController?: () => Promise<WorkspaceShellSidebarToolsControllerLike>;
}

export class WorkspaceShellSidebarToolsLazyLoadController {
  private readonly host:
    WorkspaceShellSidebarToolsLazyDelegateHostController<WorkspaceShellSidebarToolsControllerLike>;

  constructor(options: WorkspaceShellSidebarToolsLazyLoadControllerOptions) {
    this.host = new WorkspaceShellSidebarToolsLazyDelegateHostController({
      createDelegate: createWorkspaceShellSidebarToolsControllerLoader(options),
      loadFailureMessage: SIDEBAR_TOOLS_LOAD_FAILURE_MESSAGE,
      operationFailureMessage: SIDEBAR_TOOLS_OPERATION_FAILURE_MESSAGE,
      teardownFailureMessage: SIDEBAR_TOOLS_TEARDOWN_FAILURE_MESSAGE,
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
