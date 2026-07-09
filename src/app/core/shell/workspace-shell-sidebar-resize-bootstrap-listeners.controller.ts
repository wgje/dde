export type WorkspaceShellSidebarResizeDocumentListener = (
  eventName: string,
  listener: EventListener,
) => () => void;

export interface WorkspaceShellSidebarResizeBootstrapListenersControllerOptions {
  cleanupFailureMessage?: string;
  listenToDocument?: WorkspaceShellSidebarResizeDocumentListener;
  onMouseMove: (event: MouseEvent) => void;
  onMouseUp: () => void;
  warn: (message: string, error: unknown) => void;
}

const DEFAULT_CLEANUP_FAILURE_MESSAGE =
  '侧栏拖拽 bootstrap document listener 清理失败，已继续清理';
const DEFAULT_SETUP_FAILURE_MESSAGE =
  '侧栏拖拽 bootstrap document listener 注册失败，已跳过本次绑定';

export class WorkspaceShellSidebarResizeBootstrapListenersController {
  private removeMouseMoveListener: (() => void) | null = null;
  private removeMouseUpListener: (() => void) | null = null;
  private listenerGeneration = 0;

  constructor(
    private readonly options: WorkspaceShellSidebarResizeBootstrapListenersControllerOptions,
  ) {}

  setup(): void {
    if (!this.options.listenToDocument) return;

    this.teardown();
    const listenerGeneration = ++this.listenerGeneration;
    let removeMouseMoveListener: (() => void) | null = null;
    let removeMouseUpListener: (() => void) | null = null;
    try {
      removeMouseMoveListener = this.options.listenToDocument('mousemove', event => {
        if (listenerGeneration !== this.listenerGeneration) return;
        this.options.onMouseMove(event as MouseEvent);
      });
      removeMouseUpListener = this.options.listenToDocument('mouseup', () => {
        if (listenerGeneration !== this.listenerGeneration) return;
        this.options.onMouseUp();
      });
      this.removeMouseMoveListener = removeMouseMoveListener;
      this.removeMouseUpListener = removeMouseUpListener;
    } catch (error) {
      this.listenerGeneration += 1;
      this.removeDocumentListener(removeMouseMoveListener);
      this.removeDocumentListener(removeMouseUpListener);
      this.removeMouseMoveListener = null;
      this.removeMouseUpListener = null;
      this.warn(DEFAULT_SETUP_FAILURE_MESSAGE, error);
    }
  }

  teardown(): void {
    this.listenerGeneration += 1;
    this.removeDocumentListener(this.removeMouseMoveListener);
    this.removeDocumentListener(this.removeMouseUpListener);
    this.removeMouseMoveListener = null;
    this.removeMouseUpListener = null;
  }

  private removeDocumentListener(removeListener: (() => void) | null): void {
    if (!removeListener) return;

    try {
      removeListener();
    } catch (error) {
      this.warn(
        this.options.cleanupFailureMessage ?? DEFAULT_CLEANUP_FAILURE_MESSAGE,
        error,
      );
    }
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning sinks must not interrupt best-effort document listener cleanup.
    }
  }
}
