import {
  type EffectRef,
  effect,
  type Injector,
  type Signal,
  type Type,
  type WritableSignal,
} from '@angular/core';

import {
  type WorkspaceShellFocusToolsLazyDelegateHosts,
} from './workspace-shell-focus-tools-lazy-delegate-hosts.factory';
import {
  createWorkspaceShellFocusToolsLazyLoadDelegateHosts,
} from './workspace-shell-focus-tools-lazy-load-delegate-hosts.factory';

export type WorkspaceShellFocusToolsPreloadReason = 'startup' | 'p1' | 'intent';
export type WorkspaceShellFocusToolsScheduledPreloadReason =
  Exclude<WorkspaceShellFocusToolsPreloadReason, 'intent'>;

export interface WorkspaceShellFocusModePreloadLike {
  preload(reason: WorkspaceShellFocusToolsPreloadReason): Promise<void>;
  schedule(reason: WorkspaceShellFocusToolsScheduledPreloadReason): void;
}

export interface WorkspaceShellFocusToolsLoaderLike {
  readonly focusSessionTriggerComponent: Signal<Type<unknown> | null>;
  readonly blackBoxRecorderComponent: Signal<Type<unknown> | null>;
  loadFocusSessionTrigger(): Promise<Type<unknown> | null>;
  loadBlackBoxRecorder(): Promise<Type<unknown> | null>;
}

export interface WorkspaceShellFocusToolsLazyLoadControllerOptions {
  injector: Injector;
  focusSessionTriggerComponent: WritableSignal<Type<unknown> | null>;
  blackBoxRecorderComponent: WritableSignal<Type<unknown> | null>;
  warn: (message: string, error: unknown) => void;
  loadFocusModePreloadService?: () => Promise<WorkspaceShellFocusModePreloadLike>;
  loadFocusToolsLoaderService?: () => Promise<WorkspaceShellFocusToolsLoaderLike>;
}

export class WorkspaceShellFocusToolsLazyLoadController {
  private readonly lazyDelegateHosts: WorkspaceShellFocusToolsLazyDelegateHosts;
  private focusToolsMirrorEffect: EffectRef | null = null;
  private isTornDown = false;

  constructor(private readonly options: WorkspaceShellFocusToolsLazyLoadControllerOptions) {
    this.lazyDelegateHosts = createWorkspaceShellFocusToolsLazyLoadDelegateHosts({
      ...options,
      isTornDown: () => this.isTornDown,
      mirrorFocusToolsComponents: service => this.mirrorFocusToolsComponents(service),
    });
  }

  preloadFocusMode(reason: WorkspaceShellFocusToolsPreloadReason): Promise<void> {
    return this.lazyDelegateHosts.focusModePreloadHost.call(
      service => service.preload(reason),
      undefined,
    );
  }

  scheduleFocusModePreload(reason: WorkspaceShellFocusToolsScheduledPreloadReason): void {
    this.lazyDelegateHosts.focusModePreloadHost.run(service => service.schedule(reason));
  }

  teardown(): void {
    this.isTornDown = true;
    this.focusToolsMirrorEffect?.destroy();
    this.focusToolsMirrorEffect = null;
    this.lazyDelegateHosts.focusModePreloadHost.teardown();
    this.lazyDelegateHosts.focusToolsLoaderHost.teardown();
  }

  loadFocusSessionTriggerComponent(): Promise<unknown> {
    return this.lazyDelegateHosts.focusToolsLoaderHost.call(
      service => service.loadFocusSessionTrigger(),
      undefined,
    )
      .then(component => {
        if (this.isTornDown) {
          return null;
        }
        if (component !== undefined) {
          this.options.focusSessionTriggerComponent.set(component);
        }
        return component ?? null;
      });
  }

  loadBlackBoxRecorderComponent(): Promise<unknown> {
    return this.lazyDelegateHosts.focusToolsLoaderHost.call(
      service => service.loadBlackBoxRecorder(),
      undefined,
    )
      .then(component => {
        if (this.isTornDown) {
          return null;
        }
        if (component !== undefined) {
          this.options.blackBoxRecorderComponent.set(component);
        }
        return component ?? null;
      });
  }

  private mirrorFocusToolsComponents(service: WorkspaceShellFocusToolsLoaderLike): void {
    this.options.focusSessionTriggerComponent.set(service.focusSessionTriggerComponent());
    this.options.blackBoxRecorderComponent.set(service.blackBoxRecorderComponent());

    this.focusToolsMirrorEffect?.destroy();
    this.focusToolsMirrorEffect = effect(() => {
      this.options.focusSessionTriggerComponent.set(service.focusSessionTriggerComponent());
      this.options.blackBoxRecorderComponent.set(service.blackBoxRecorderComponent());
    }, { injector: this.options.injector });
  }
}
