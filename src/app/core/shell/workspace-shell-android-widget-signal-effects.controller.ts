import type { WorkspaceShellSignalEffectRegistrarController } from './workspace-shell-signal-effect-registrar.controller';

export interface WorkspaceShellAndroidWidgetSignalEffectsControllerOptions {
  effectRegistrar: WorkspaceShellSignalEffectRegistrarController;
  routeUrl: () => string | null | undefined;
  captureAndroidWidgetBootstrapFromRoute: (routeUrl: string | null) => Promise<boolean>;
  syncAndroidWidgetBootstrapProcessing: () => void;
}

export class WorkspaceShellAndroidWidgetSignalEffectsController {
  constructor(
    private readonly options: WorkspaceShellAndroidWidgetSignalEffectsControllerOptions,
  ) {}

  setup(): void {
    this.options.effectRegistrar.register('android-widget-bootstrap-capture', () => {
      const routeUrl = this.options.routeUrl();
      void this.options.captureAndroidWidgetBootstrapFromRoute(
        typeof routeUrl === 'string' ? routeUrl : null,
      ).catch(error => {
        this.options.effectRegistrar.reportAsync(
          'android-widget-bootstrap-capture',
          error,
        );
      });
    });

    this.options.effectRegistrar.register('android-widget-bootstrap-processing', () => {
      this.options.syncAndroidWidgetBootstrapProcessing();
    });
  }
}
