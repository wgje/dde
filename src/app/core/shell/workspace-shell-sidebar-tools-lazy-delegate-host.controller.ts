import type {
  WorkspaceShellSidebarToolsPreloadReason,
} from './workspace-shell-sidebar-tools.controller';
import {
  WorkspaceShellSidebarToolsLazyActionHostController,
} from './workspace-shell-sidebar-tools-lazy-action-host.controller';

export interface WorkspaceShellSidebarToolsLazyDelegate {
  loadBlackBoxRecorderComponent(): Promise<unknown>;
  loadFocusSessionTriggerComponent(): Promise<unknown>;
  onToolsIntent(): void;
  onVoiceTranscribed(text: string): void;
  preload(reason: WorkspaceShellSidebarToolsPreloadReason): void;
  preloadFocusModeAssets(reason: WorkspaceShellSidebarToolsPreloadReason): Promise<void>;
  scheduleFocusModePreload(reason: 'startup' | 'p1'): void;
}

export interface WorkspaceShellSidebarToolsLazyDelegateHostOptions<
  TDelegate extends WorkspaceShellSidebarToolsLazyDelegate,
> {
  createDelegate: () => Promise<TDelegate>;
  loadFailureMessage: string;
  operationFailureMessage: string;
  teardownFailureMessage: string;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellSidebarToolsLazyDelegateHostController<
  TDelegate extends WorkspaceShellSidebarToolsLazyDelegate,
> {
  private readonly host: WorkspaceShellSidebarToolsLazyActionHostController<TDelegate>;

  constructor(options: WorkspaceShellSidebarToolsLazyDelegateHostOptions<TDelegate>) {
    this.host = new WorkspaceShellSidebarToolsLazyActionHostController({
      createDelegate: options.createDelegate,
      loadFailureMessage: options.loadFailureMessage,
      operationFailureMessage: options.operationFailureMessage,
      teardownFailureMessage: options.teardownFailureMessage,
      warn: options.warn,
    });
  }

  onVoiceTranscribed(text: string): void {
    this.run(controller => controller.onVoiceTranscribed(text));
  }

  onToolsIntent(): void {
    this.run(controller => controller.onToolsIntent());
  }

  preload(reason: WorkspaceShellSidebarToolsPreloadReason): void {
    this.run(controller => controller.preload(reason));
  }

  loadFocusSessionTriggerComponent(): Promise<unknown> {
    return this.call(controller => controller.loadFocusSessionTriggerComponent());
  }

  loadBlackBoxRecorderComponent(): Promise<unknown> {
    return this.call(controller => controller.loadBlackBoxRecorderComponent());
  }

  preloadFocusModeAssets(reason: WorkspaceShellSidebarToolsPreloadReason): Promise<void> {
    return this.call(controller => controller.preloadFocusModeAssets(reason));
  }

  scheduleFocusModePreload(reason: 'startup' | 'p1'): void {
    this.run(controller => controller.scheduleFocusModePreload(reason));
  }

  teardown(): void {
    this.host.teardown();
  }

  private run(action: (controller: TDelegate) => void): void {
    this.host.run(action);
  }

  private call<T>(
    action: (controller: TDelegate) => T | Promise<T>,
  ): Promise<T | undefined> {
    return this.host.call(action);
  }
}
