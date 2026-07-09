import type { Injector } from '@angular/core';

import {
  type WorkspaceShellLazyLifecycleDelegate,
} from './workspace-shell-lazy-lifecycle-host.controller';
import {
  createWorkspaceShellLazyLifecycleHostMember,
} from './workspace-shell-lazy-lifecycle-host-member.factory';
import {
  createWorkspaceShellKeyboardShortcutsLifecycleHost,
} from './workspace-shell-keyboard-shortcuts-lifecycle-host.factory';
import {
  createWorkspaceShellStartupBreadcrumbLifecycleHost,
} from './workspace-shell-startup-breadcrumb-lifecycle-host.factory';
import {
  createWorkspaceShellSwUpdateLifecycleHost,
} from './workspace-shell-sw-update-lifecycle-host.factory';

export interface WorkspaceShellLazyLifecycleGroupMember
  extends WorkspaceShellLazyLifecycleDelegate {}

export interface WorkspaceShellLazyLifecycleHosts {
  keyboardShortcuts: WorkspaceShellLazyLifecycleGroupMember;
  startupBreadcrumb: WorkspaceShellLazyLifecycleGroupMember;
  swUpdateLifecycle: WorkspaceShellLazyLifecycleGroupMember;
}

export interface WorkspaceShellLazyLifecycleHostsOptions {
  injector?: Injector;
  runtime: {
    destroyed: () => boolean;
  };
  warn: (message: string, error: unknown) => void;
  createKeyboardShortcutsHost?: () => Promise<WorkspaceShellLazyLifecycleGroupMember>;
  createStartupBreadcrumbHost?: () => Promise<WorkspaceShellLazyLifecycleGroupMember>;
  createSwUpdateLifecycleHost?: () => Promise<WorkspaceShellLazyLifecycleGroupMember>;
}

export function createWorkspaceShellLazyLifecycleHosts(
  options: WorkspaceShellLazyLifecycleHostsOptions,
): WorkspaceShellLazyLifecycleHosts {
  return {
    keyboardShortcuts: createWorkspaceShellLazyLifecycleGroupHost({
      createController: () => options.createKeyboardShortcutsHost?.()
        ?? createWorkspaceShellKeyboardShortcutsLifecycleHost(options),
      initializeFailureMessage: '全局快捷键 controller 加载失败，快捷键暂不可用',
      teardownFailureMessage: '全局快捷键 controller 清理失败，已跳过',
      warn: options.warn,
    }),
    startupBreadcrumb: createWorkspaceShellLazyLifecycleGroupHost({
      createController: () => options.createStartupBreadcrumbHost?.()
        ?? createWorkspaceShellStartupBreadcrumbLifecycleHost(options),
      initializeFailureMessage: '启动 breadcrumb controller 加载失败，已跳过',
      teardownFailureMessage: '启动 breadcrumb controller 清理失败，已跳过',
      warn: options.warn,
    }),
    swUpdateLifecycle: createWorkspaceShellLazyLifecycleGroupHost({
      createController: () => options.createSwUpdateLifecycleHost?.()
        ?? createWorkspaceShellSwUpdateLifecycleHost(options),
      initializeFailureMessage: 'Service Worker 更新生命周期 controller 加载失败，已跳过',
      teardownFailureMessage: 'Service Worker 更新生命周期 controller 清理失败，已跳过',
      warn: options.warn,
    }),
  };
}

function createWorkspaceShellLazyLifecycleGroupHost(
  options: Parameters<typeof createWorkspaceShellLazyLifecycleHostMember>[0],
): WorkspaceShellLazyLifecycleGroupMember {
  return createWorkspaceShellLazyLifecycleHostMember(options);
}
