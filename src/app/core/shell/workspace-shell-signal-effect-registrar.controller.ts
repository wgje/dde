export type WorkspaceShellEffectRegistrar = (callback: () => void) => void;

export interface WorkspaceShellSignalEffectRegistrarControllerOptions {
  registerEffect: WorkspaceShellEffectRegistrar;
  onEffectError?: (effect: string, error: unknown) => void;
  onAsyncEffectError?: (effect: string, error: unknown) => void;
}

export class WorkspaceShellSignalEffectRegistrarController {
  constructor(
    private readonly options: WorkspaceShellSignalEffectRegistrarControllerOptions,
  ) {}

  register(effectName: string, callback: () => void): void {
    try {
      this.options.registerEffect(() => {
        try {
          callback();
        } catch (error) {
          this.report(effectName, error);
        }
      });
    } catch (error) {
      this.report(`${effectName}:register`, error);
    }
  }

  report(effectName: string, error: unknown): void {
    this.reportTo(this.options.onEffectError ?? this.options.onAsyncEffectError, effectName, error);
  }

  reportAsync(effectName: string, error: unknown): void {
    this.reportTo(this.options.onAsyncEffectError ?? this.options.onEffectError, effectName, error);
  }

  private reportTo(
    reportError: ((effect: string, error: unknown) => void) | undefined,
    effectName: string,
    error: unknown,
  ): void {
    if (!reportError) {
      return;
    }

    try {
      reportError(effectName, error);
    } catch {
      // Effect diagnostics must not create a second shell effect failure.
    }
  }
}
