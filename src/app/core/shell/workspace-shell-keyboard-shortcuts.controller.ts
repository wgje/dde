import type { Injector } from '@angular/core';

import {
  createWorkspaceShellKeyboardShortcutsServiceLoader,
} from './workspace-shell-keyboard-shortcuts-service-loader.factory';
import type {
  WorkspaceShellLazyLifecycleDelegate,
} from './workspace-shell-lazy-lifecycle-host.controller';
import {
  WorkspaceShellLazyLifecycleServiceController,
} from './workspace-shell-lazy-lifecycle-service.controller';

export interface WorkspaceShellKeyboardShortcutsLike
  extends WorkspaceShellLazyLifecycleDelegate {}

export interface WorkspaceShellKeyboardShortcutsControllerOptions {
  injector?: Injector;
  destroyed: () => boolean;
  warn: (message: string, error: unknown) => void;
  loadKeyboardShortcuts?: () => Promise<WorkspaceShellKeyboardShortcutsLike>;
}

export class WorkspaceShellKeyboardShortcutsController {
  private readonly lifecycle: WorkspaceShellLazyLifecycleServiceController<
    WorkspaceShellKeyboardShortcutsLike
  >;

  constructor(options: WorkspaceShellKeyboardShortcutsControllerOptions) {
    this.lifecycle = new WorkspaceShellLazyLifecycleServiceController({
      destroyed: options.destroyed,
      initializeFailureMessage: '全局快捷键服务懒加载失败，快捷键暂不可用',
      loadService: createWorkspaceShellKeyboardShortcutsServiceLoader({
        injector: options.injector,
        loadKeyboardShortcuts: options.loadKeyboardShortcuts,
      }),
      teardownFailureMessage: '全局快捷键服务清理失败，已跳过',
      warn: options.warn,
    });
  }

  initialize(): void {
    this.lifecycle.initialize();
  }

  teardown(): void {
    this.lifecycle.teardown();
  }
}
