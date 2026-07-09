import { WorkspaceShellLazyDelegateCallHostController } from './workspace-shell-lazy-delegate-call-host.controller';
import {
  createWorkspaceShellSignalEffectsControllerLoader,
  type WorkspaceShellSignalEffectsControllerLoaderOptions,
} from './workspace-shell-signal-effects-controller-loader.factory';

const SIGNAL_EFFECTS_LOAD_FAILURE_MESSAGE =
  'Workspace shell signal effects lazy-load failed';
const SIGNAL_EFFECTS_SETUP_FAILURE_MESSAGE =
  'Workspace shell signal effects setup failed';
const SIGNAL_EFFECTS_TEARDOWN_FAILURE_MESSAGE =
  'Workspace shell signal effects teardown failed';

export interface WorkspaceShellSignalEffectsHostDelegate {
  setup(): void;
}

export interface WorkspaceShellSignalEffectsLazyLoadHostOptions
  extends WorkspaceShellSignalEffectsControllerLoaderOptions {
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellSignalEffectsLazyLoadHostController {
  private readonly host: WorkspaceShellLazyDelegateCallHostController<
    WorkspaceShellSignalEffectsHostDelegate
  >;
  private readonly loadSignalEffectsController: () => Promise<WorkspaceShellSignalEffectsHostDelegate>;
  private setupInFlight = false;
  private setupCompleted = false;
  private lifecycleGeneration = 0;
  private isTornDown = false;

  constructor(private readonly options: WorkspaceShellSignalEffectsLazyLoadHostOptions) {
    this.loadSignalEffectsController =
      createWorkspaceShellSignalEffectsControllerLoader(options);
    this.host = new WorkspaceShellLazyDelegateCallHostController({
      createDelegate: () => this.loadSignalEffectsController(),
      loadFailureMessage: SIGNAL_EFFECTS_LOAD_FAILURE_MESSAGE,
      teardownFailureMessage: SIGNAL_EFFECTS_TEARDOWN_FAILURE_MESSAGE,
      warn: options.warn,
    });
  }

  setup(): void {
    if (this.isTornDown || this.setupInFlight || this.setupCompleted) {
      return;
    }

    const lifecycleGeneration = this.lifecycleGeneration;
    this.setupInFlight = true;
    void this.host.call(
      controller => {
        if (!this.isLifecycleCurrent(lifecycleGeneration)) {
          return;
        }

        try {
          controller.setup();
          this.setupCompleted = true;
        } catch (error) {
          this.setupInFlight = false;
          throw error;
        }
      },
      undefined,
      SIGNAL_EFFECTS_SETUP_FAILURE_MESSAGE,
      SIGNAL_EFFECTS_LOAD_FAILURE_MESSAGE,
    )
      .finally(() => {
        if (this.isLifecycleCurrent(lifecycleGeneration)) {
          this.setupInFlight = false;
        }
      });
  }

  teardown(): void {
    if (this.isTornDown) {
      return;
    }

    this.isTornDown = true;
    this.lifecycleGeneration += 1;
    this.setupInFlight = false;
    this.host.teardown();
  }

  private isLifecycleCurrent(lifecycleGeneration: number): boolean {
    return !this.isTornDown && this.lifecycleGeneration === lifecycleGeneration;
  }
}
