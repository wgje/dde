const ACTIONS_DOCUMENT_CLICK_LISTENER_TEARDOWN_FAILURE_MESSAGE =
  'Workspace shell actions controller 文档点击监听清理失败，已继续清理';

export interface WorkspaceShellActionsDocumentClickListenerControllerOptions {
  listenToDocument?: (eventName: string, listener: EventListener) => () => void;
  onDocumentClick: (event: MouseEvent) => void;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellActionsDocumentClickListenerController {
  private removeListener: (() => void) | null = null;
  private isTornDown = false;

  constructor(
    private readonly options: WorkspaceShellActionsDocumentClickListenerControllerOptions,
  ) {}

  setup(): void {
    if (this.isTornDown || !this.options.listenToDocument) {
      return;
    }

    this.removeListenerSafely();
    this.removeListener = this.options.listenToDocument('click', event => {
      this.options.onDocumentClick(event as MouseEvent);
    });
  }

  teardown(): void {
    if (this.isTornDown) {
      return;
    }

    this.isTornDown = true;
    this.removeListenerSafely();
  }

  private removeListenerSafely(): void {
    const removeListener = this.removeListener;
    if (!removeListener) {
      return;
    }

    this.removeListener = null;
    try {
      removeListener();
    } catch (error) {
      this.warn(ACTIONS_DOCUMENT_CLICK_LISTENER_TEARDOWN_FAILURE_MESSAGE, error);
    }
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning sinks must not interrupt listener cleanup.
    }
  }
}
