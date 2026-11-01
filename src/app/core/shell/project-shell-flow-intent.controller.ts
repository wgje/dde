import {
  computed,
  signal,
  type Signal,
  type WritableSignal,
} from '@angular/core';

export type ProjectShellFlowIntentSource =
  | 'click'
  | 'route'
  | 'deeplink'
  | 'restore-idle';

export interface ProjectShellFlowIntentControllerOptions {
  enabled: boolean;
  onActivated: (source: ProjectShellFlowIntentSource) => void;
}

export class ProjectShellFlowIntentController {
  readonly flowIntentActivated: WritableSignal<boolean>;
  readonly flowPrefetchOnlyActivated = signal(false);
  readonly shouldLoadFlowNow: Signal<boolean>;
  readonly shouldPrefetchFlowChunk: Signal<boolean>;

  constructor(private readonly options: ProjectShellFlowIntentControllerOptions) {
    this.flowIntentActivated = signal(!options.enabled);
    this.shouldLoadFlowNow = computed(() =>
      !this.options.enabled || this.flowIntentActivated());
    this.shouldPrefetchFlowChunk = computed(() =>
      this.shouldLoadFlowNow() || this.flowPrefetchOnlyActivated());
  }

  activate(source: ProjectShellFlowIntentSource): void {
    if (!this.options.enabled || this.flowIntentActivated()) return;

    this.flowIntentActivated.set(true);
    this.flowPrefetchOnlyActivated.set(false);
    this.options.onActivated(source);
  }
}
