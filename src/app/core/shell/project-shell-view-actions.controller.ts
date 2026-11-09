import type {
  ProjectShellFlowIntentSource,
} from './project-shell-flow-intent.controller';

type ProjectShellView = 'text' | 'flow';

export interface ProjectShellViewActionsControllerOptions {
  activateFlowIntent: (source: ProjectShellFlowIntentSource) => void;
  flowCommand: {
    centerOnNode(taskId: string, animate: boolean): void;
    retryDiagram(): void;
  };
  isMobile: () => boolean;
  logger: {
    debug(message: string): void;
  };
  routeController: {
    cancelFlowStateAwareTimers(): void;
    setActiveView(view: ProjectShellView): void;
  };
}

export class ProjectShellViewActionsController {
  constructor(private readonly options: ProjectShellViewActionsControllerOptions) {}

  switchToFlow(): void {
    this.options.routeController.cancelFlowStateAwareTimers();
    this.options.activateFlowIntent('click');
    this.options.routeController.setActiveView('flow');
  }

  switchToText(): void {
    this.options.logger.debug('switchToText 被调用');
    this.options.routeController.cancelFlowStateAwareTimers();
    this.options.routeController.setActiveView('text');
  }

  focusFlowNode(taskId: string): void {
    if (this.options.isMobile()) return;

    this.options.activateFlowIntent('click');
    this.options.flowCommand.centerOnNode(taskId, false);
  }

  retryTextView(): void {
    this.options.routeController.setActiveView('text');
  }

  retryFlowView(): void {
    this.options.activateFlowIntent('click');
    this.options.routeController.setActiveView('flow');
    this.options.flowCommand.retryDiagram();
  }
}
