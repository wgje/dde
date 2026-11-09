import type { WorkspaceShellSignalEffectRegistrarController } from './workspace-shell-signal-effect-registrar.controller';

export interface WorkspaceShellStartupRouteSignalEffectsControllerOptions {
  effectRegistrar: WorkspaceShellSignalEffectRegistrarController;
  launchSnapshotController: { sync(): void };
  routeUrl: () => string | null | undefined;
  projects: () => unknown;
  activeProjectId: () => string | null;
  syncStateFromRoute: () => void;
  startupEntryIntentController: { sync(): void };
}

export class WorkspaceShellStartupRouteSignalEffectsController {
  constructor(
    private readonly options: WorkspaceShellStartupRouteSignalEffectsControllerOptions,
  ) {}

  setupLaunchAndRoute(): void {
    this.options.effectRegistrar.register('launch-snapshot', () => {
      this.options.launchSnapshotController.sync();
    });

    this.options.effectRegistrar.register('route-project-selection', () => {
      this.options.routeUrl();
      this.options.projects();
      this.options.activeProjectId();
      this.options.syncStateFromRoute();
    });
  }

  setupStartupEntryIntent(): void {
    this.options.effectRegistrar.register('startup-entry-intent', () => {
      this.options.startupEntryIntentController.sync();
    });
  }
}
