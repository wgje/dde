export interface WorkspaceShellStartupWidgetGateMutationEffectInput {
  intent: 'mark-gate-read' | 'mark-gate-complete';
  widgetGateEntryId: string | null;
}

export interface WorkspaceShellStartupWidgetGateMutationEffectContext {
  clearDeferredAfterSuccess: boolean;
  onFailure: () => void;
}

export interface WorkspaceShellStartupWidgetGateMutationEffectControllerOptions {
  applyMutation: (
    input: WorkspaceShellStartupWidgetGateMutationEffectInput,
  ) => Promise<unknown> | unknown;
  clearDeferredStartupEntryIntent: () => void;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellStartupWidgetGateMutationEffectController {
  private isTornDown = false;

  constructor(
    private readonly options: WorkspaceShellStartupWidgetGateMutationEffectControllerOptions,
  ) {}

  apply(
    input: WorkspaceShellStartupWidgetGateMutationEffectInput,
    context: WorkspaceShellStartupWidgetGateMutationEffectContext | null,
  ): void {
    if (this.isTornDown) {
      return;
    }

    const handleFailure = (error: unknown): void => {
      this.warn('Startup entry widget gate mutation failed', error);
      context?.onFailure();
    };

    try {
      void Promise.resolve(this.options.applyMutation(input)).then(() => {
        if (this.isTornDown) {
          return;
        }

        if (context?.clearDeferredAfterSuccess) {
          this.options.clearDeferredStartupEntryIntent();
        }
      }).catch((error: unknown) => {
        if (this.isTornDown) {
          return;
        }

        handleFailure(error);
      });
    } catch (error) {
      handleFailure(error);
    }
  }

  teardown(): void {
    this.isTornDown = true;
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning sinks must not break mutation retry ownership.
    }
  }
}
