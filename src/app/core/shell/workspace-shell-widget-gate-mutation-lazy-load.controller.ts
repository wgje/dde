import type {
  WorkspaceShellWidgetGateMutation,
  WorkspaceShellWidgetGateMutationController,
} from './workspace-shell-widget-gate-mutation.controller';

type WorkspaceShellWidgetGateMutationDelegate = Pick<
  WorkspaceShellWidgetGateMutationController,
  'apply'
>;

export interface WorkspaceShellWidgetGateMutationLazyLoadControllerOptions {
  loadController: () => Promise<WorkspaceShellWidgetGateMutationDelegate>;
}

export class WorkspaceShellWidgetGateMutationLazyLoadController
implements WorkspaceShellWidgetGateMutationDelegate {
  private controllerPromise: Promise<WorkspaceShellWidgetGateMutationDelegate> | null = null;

  constructor(
    private readonly options: WorkspaceShellWidgetGateMutationLazyLoadControllerOptions,
  ) {}

  async apply(intent: WorkspaceShellWidgetGateMutation): Promise<void> {
    const controller = await this.loadController();
    await controller.apply(intent);
  }

  private loadController(): Promise<WorkspaceShellWidgetGateMutationDelegate> {
    return (this.controllerPromise ??= this.options.loadController());
  }
}
