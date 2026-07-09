import {
  signal,
  type Type,
  type WritableSignal,
} from '@angular/core';

import type {
  WorkspaceShellSidebarToolsHostDelegate,
} from './workspace-shell-sidebar-tools-lazy-load-host.controller';
import { createWorkspaceShellDeferredController } from './workspace-shell-deferred-controller.helpers';
import {
  createWorkspaceShellToolLazyLoadHostsLoader,
  type WorkspaceShellFocusToolsHostDelegate,
  type WorkspaceShellToolLazyLoadHostsOptions,
} from './workspace-shell-tool-lazy-load-hosts-loader.factory';

export interface WorkspaceShellToolLazyLoadDelegates {
  readonly focusToolsLazyLoad: WorkspaceShellFocusToolsHostDelegate;
  readonly sidebarToolsLazyLoad: WorkspaceShellSidebarToolsHostDelegate;
  readonly focusSessionTriggerComponent: WritableSignal<Type<unknown> | null>;
  readonly blackBoxRecorderComponent: WritableSignal<Type<unknown> | null>;
  readonly blackBoxRecorderOutletInputs: {
    readonly appearance: 'obsidian';
    readonly onTranscribed: (text: string) => void;
  };
  readonly templateBindings: WorkspaceShellToolLazyLoadTemplateBindings;
  teardown(): void;
}

export interface WorkspaceShellToolLazyLoadTemplateBindings {
  readonly focusSessionTriggerComponent: WritableSignal<Type<unknown> | null>;
  readonly blackBoxRecorderComponent: WritableSignal<Type<unknown> | null>;
  readonly blackBoxRecorderOutletInputs: {
    readonly appearance: 'obsidian';
    readonly onTranscribed: (text: string) => void;
  };
}

export interface WorkspaceShellToolLazyLoadDelegateOptions
  extends Omit<
    WorkspaceShellToolLazyLoadHostsOptions,
    'blackBoxRecorderComponent' | 'focusSessionTriggerComponent'
  > {
  focusSessionTriggerComponent?: WritableSignal<Type<unknown> | null>;
  blackBoxRecorderComponent?: WritableSignal<Type<unknown> | null>;
}

export function createWorkspaceShellToolLazyLoadDelegates(
  options: WorkspaceShellToolLazyLoadDelegateOptions,
): WorkspaceShellToolLazyLoadDelegates {
  const components = createToolLazyLoadComponentSignals(options);
  const resolvedOptions: WorkspaceShellToolLazyLoadHostsOptions = {
    ...options,
    ...components,
  };
  const toolHosts = createWorkspaceShellToolLazyLoadHostsLoader({ options: resolvedOptions });
  const focusToolsLazyLoad =
    createWorkspaceShellDeferredController<WorkspaceShellFocusToolsHostDelegate>(
      () => toolHosts.load().then(hosts => hosts.focusToolsLazyLoad),
      {
        failureMessage: 'Focus 工具 lazy-load hosts 加载失败，相关入口暂不可用',
        teardownFailureMessage: '工作区工具懒加载 focusToolsLazyLoad 清理失败，已继续清理后续工具',
        warn: options.warn,
      },
    );
  const sidebarToolsLazyLoad =
    createWorkspaceShellDeferredController<WorkspaceShellSidebarToolsHostDelegate>(
      () => toolHosts.load().then(hosts => hosts.sidebarToolsLazyLoad),
      {
        failureMessage: '侧栏工具 lazy-load hosts 加载失败，侧栏工具暂不可用',
        teardownFailureMessage: '工作区工具懒加载 sidebarToolsLazyLoad 清理失败，已继续清理后续工具',
        warn: options.warn,
      },
    );
  const blackBoxRecorderOutletInputs = {
    appearance: 'obsidian' as const,
    onTranscribed: (text: string) =>
      sidebarToolsLazyLoad.onVoiceTranscribed(text),
  };
  const templateBindings = createToolLazyLoadTemplateBindings(
    components,
    blackBoxRecorderOutletInputs,
  );

  return {
    focusToolsLazyLoad,
    sidebarToolsLazyLoad,
    ...components,
    blackBoxRecorderOutletInputs,
    templateBindings,
    teardown: () => {
      teardownToolLazyLoadDelegate('focusToolsLazyLoad', focusToolsLazyLoad, options.warn);
      teardownToolLazyLoadDelegate('sidebarToolsLazyLoad', sidebarToolsLazyLoad, options.warn);
      toolHosts.teardown();
    },
  };
}

function teardownToolLazyLoadDelegate(
  label: string,
  delegate: Pick<WorkspaceShellToolLazyLoadDelegates, 'teardown'>,
  warn: (message: string, error: unknown) => void,
): void {
  try {
    delegate.teardown();
  } catch (error) {
    warn(`工作区工具懒加载 ${label} 清理失败，已继续清理后续工具`, error);
  }
}

function createToolLazyLoadComponentSignals(
  options: WorkspaceShellToolLazyLoadDelegateOptions,
): Pick<
  WorkspaceShellToolLazyLoadDelegates,
  'blackBoxRecorderComponent' | 'focusSessionTriggerComponent'
> {
  return {
    focusSessionTriggerComponent:
      options.focusSessionTriggerComponent ?? signal<Type<unknown> | null>(null),
    blackBoxRecorderComponent:
      options.blackBoxRecorderComponent ?? signal<Type<unknown> | null>(null),
  };
}

function createToolLazyLoadTemplateBindings(
  components: Pick<
    WorkspaceShellToolLazyLoadDelegates,
    'blackBoxRecorderComponent' | 'focusSessionTriggerComponent'
  >,
  blackBoxRecorderOutletInputs: WorkspaceShellToolLazyLoadTemplateBindings['blackBoxRecorderOutletInputs'],
): WorkspaceShellToolLazyLoadTemplateBindings {
  return {
    ...components,
    blackBoxRecorderOutletInputs,
  };
}
