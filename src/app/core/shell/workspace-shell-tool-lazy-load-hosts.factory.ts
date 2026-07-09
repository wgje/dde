import type {
  WorkspaceShellFocusToolsLazyLoadControllerOptions,
  WorkspaceShellFocusToolsPreloadReason,
  WorkspaceShellFocusToolsScheduledPreloadReason,
} from './workspace-shell-focus-tools-lazy-load.controller';
import type {
  WorkspaceShellSidebarToolsHostDelegate,
} from './workspace-shell-sidebar-tools-lazy-load-host.controller';
import type {
  WorkspaceShellSidebarToolsControllerOptions,
} from './workspace-shell-sidebar-tools.controller';
import { createWorkspaceShellDeferredController } from './workspace-shell-deferred-controller.helpers';
import {
  createWorkspaceShellFocusToolsLazyLoadHost,
} from './workspace-shell-focus-tools-lazy-load-host.factory';
import {
  createWorkspaceShellSidebarToolsLazyLoadHost,
} from './workspace-shell-sidebar-tools-lazy-load-host.factory';

export interface WorkspaceShellToolLazyLoadHosts {
  readonly focusToolsLazyLoad: WorkspaceShellFocusToolsHostDelegate;
  readonly sidebarToolsLazyLoad: WorkspaceShellSidebarToolsHostDelegate;
}

export interface WorkspaceShellFocusToolsHostDelegate {
  loadFocusSessionTriggerComponent(): Promise<unknown>;
  loadBlackBoxRecorderComponent(): Promise<unknown>;
  preloadFocusMode(reason: WorkspaceShellFocusToolsPreloadReason): Promise<void>;
  scheduleFocusModePreload(reason: WorkspaceShellFocusToolsScheduledPreloadReason): void;
  teardown(): void;
}

export interface WorkspaceShellToolLazyLoadHostsOptions
  extends Pick<
    WorkspaceShellFocusToolsLazyLoadControllerOptions,
    'blackBoxRecorderComponent' | 'focusSessionTriggerComponent' | 'injector'
  >,
  Omit<
    WorkspaceShellSidebarToolsControllerOptions,
    | 'loadFocusSessionTrigger'
    | 'loadBlackBoxRecorder'
    | 'preloadFocusMode'
    | 'scheduleFocusModePreload'
  > {
  warn: (message: string, error: unknown) => void;
  createFocusToolsHost?: () => Promise<WorkspaceShellFocusToolsHostDelegate>;
  createSidebarToolsHost?: () => Promise<WorkspaceShellSidebarToolsHostDelegate>;
}

export function createWorkspaceShellToolLazyLoadHosts(
  options: WorkspaceShellToolLazyLoadHostsOptions,
): WorkspaceShellToolLazyLoadHosts {
  const focusToolsLazyLoad =
    createWorkspaceShellDeferredController<WorkspaceShellFocusToolsHostDelegate>(
      () => options.createFocusToolsHost?.()
        ?? createFocusToolsHost(options),
      {
        failureMessage: 'Focus 工具 lazy-load host 加载失败，相关入口暂不可用',
        teardownFailureMessage: '工作区工具懒加载 focusToolsLazyLoad 清理失败，已继续清理后续工具',
        warn: options.warn,
      },
    );
  const sidebarToolsLazyLoad =
    createWorkspaceShellDeferredController<WorkspaceShellSidebarToolsHostDelegate>(
      () => options.createSidebarToolsHost?.()
        ?? createSidebarToolsHost(options, focusToolsLazyLoad),
      {
        failureMessage: '侧栏工具 lazy-load host 加载失败，侧栏工具暂不可用',
        teardownFailureMessage: '工作区工具懒加载 sidebarToolsLazyLoad 清理失败，已继续清理后续工具',
        warn: options.warn,
      },
    );

  return { focusToolsLazyLoad, sidebarToolsLazyLoad };
}

function createFocusToolsHost(
  options: WorkspaceShellToolLazyLoadHostsOptions,
): Promise<WorkspaceShellFocusToolsHostDelegate> {
  return createWorkspaceShellFocusToolsLazyLoadHost({
    injector: options.injector,
    focusSessionTriggerComponent: options.focusSessionTriggerComponent,
    blackBoxRecorderComponent: options.blackBoxRecorderComponent,
    warn: options.warn,
  });
}

function createSidebarToolsHost(
  options: WorkspaceShellToolLazyLoadHostsOptions,
  focusToolsLazyLoad: WorkspaceShellFocusToolsHostDelegate,
): Promise<WorkspaceShellSidebarToolsHostDelegate> {
  return createWorkspaceShellSidebarToolsLazyLoadHost({
    createBlackBoxEntry: options.createBlackBoxEntry,
    warning: options.warning,
    dynamicLoadEnabled: options.dynamicLoadEnabled,
    isBlackBoxEnabled: options.isBlackBoxEnabled,
    focusToolsLazyLoad,
    addBreadcrumb: options.addBreadcrumb,
    warn: options.warn,
  });
}
