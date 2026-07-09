import {
  WorkspaceShellSidebarResizeAsyncDelegateHostController,
} from './workspace-shell-sidebar-resize-async-delegate-host.controller';

export interface WorkspaceShellSidebarResizeAsyncDelegate {
  isResizingAny(): boolean;
  onMouseMove(event: MouseEvent): void;
  onMouseUp(): void;
  startContentResize(event: MouseEvent): void;
  startSidebarResize(event: MouseEvent): void;
  teardown(): void;
}

export interface WorkspaceShellSidebarResizeAsyncDelegateOptions {
  loadDelegate: () => Promise<WorkspaceShellSidebarResizeAsyncDelegate>;
  resolveFailureMessage: (target: 'sidebar' | 'content') => string;
  resolveStartFailureMessage?: (target: 'sidebar' | 'content') => string;
  teardownFailureMessage: string;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellSidebarResizeAsyncDelegateController {
  private readonly delegateHost: WorkspaceShellSidebarResizeAsyncDelegateHostController;
  private active = false;
  private gestureId = 0;
  private pendingMouseMoveEvent: MouseEvent | null = null;

  constructor(private readonly options: WorkspaceShellSidebarResizeAsyncDelegateOptions) {
    this.delegateHost = new WorkspaceShellSidebarResizeAsyncDelegateHostController({
      loadDelegate: options.loadDelegate,
      loadFailureMessage: options.resolveFailureMessage('sidebar'),
      teardownFailureMessage: options.teardownFailureMessage,
      warn: options.warn,
    });
  }

  isResizingAny(): boolean {
    if (!this.active) return false;

    const delegate = this.delegateHost.loadedDelegate;
    if (!delegate) return true;

    try {
      return delegate.isResizingAny();
    } catch (error) {
      this.failActiveGesture('sidebar resize state check failed', error);
      return false;
    }
  }

  startSidebarResize(event: MouseEvent): void {
    this.start(event, 'sidebar');
  }

  startContentResize(event: MouseEvent): void {
    this.start(event, 'content');
  }

  onMouseMove(event: MouseEvent): void {
    const delegate = this.delegateHost.loadedDelegate;
    if (!delegate && this.active) {
      this.pendingMouseMoveEvent = event;
      return;
    }

    try {
      delegate?.onMouseMove(event);
    } catch (error) {
      this.failActiveGesture('sidebar mousemove failed', error);
    }
  }

  onMouseUp(): void {
    this.gestureId += 1;
    this.active = false;
    this.clearPendingEvents();
    try {
      this.delegateHost.loadedDelegate?.onMouseUp();
    } catch (error) {
      this.warn('sidebar mouseup failed', error);
    }
  }

  teardown(): void {
    this.gestureId += 1;
    this.active = false;
    this.clearPendingEvents();
    this.delegateHost.teardown();
  }

  private start(event: MouseEvent, target: 'sidebar' | 'content'): void {
    if (!event.defaultPrevented) {
      event.preventDefault();
    }
    const gestureId = this.gestureId + 1;
    this.gestureId = gestureId;
    this.active = true;
    this.clearPendingEvents();

    let startFailureMessage: string;
    let loadFailureMessage: string;
    try {
      startFailureMessage = this.resolveStartFailureMessage(target);
      loadFailureMessage = this.options.resolveFailureMessage(target);
    } catch (error) {
      this.failActiveGesture(
        `${target} resize start failure message resolution failed`,
        error,
      );
      return;
    }

    void this.delegateHost.call(
      delegate => this.startLoadedDelegate(delegate, event, target, gestureId),
      false,
      startFailureMessage,
      loadFailureMessage,
    )
      .then(started => {
        if (started || gestureId !== this.gestureId) return;
        this.active = false;
        this.clearPendingEvents();
      });
  }

  private resolveStartFailureMessage(target: 'sidebar' | 'content'): string {
    return this.options.resolveStartFailureMessage?.(target)
      ?? this.options.resolveFailureMessage(target);
  }

  private startLoadedDelegate(
    delegate: WorkspaceShellSidebarResizeAsyncDelegate,
    event: MouseEvent,
    target: 'sidebar' | 'content',
    gestureId: number,
  ): boolean {
    if (gestureId !== this.gestureId || !this.active) {
      return false;
    }

    if (target === 'sidebar') {
      delegate.startSidebarResize(event);
    } else {
      delegate.startContentResize(event);
    }

    this.flushPendingEvents(delegate);
    return true;
  }

  private flushPendingEvents(delegate: WorkspaceShellSidebarResizeAsyncDelegate): void {
    const pendingMouseMoveEvent = this.pendingMouseMoveEvent;
    this.clearPendingEvents();

    if (pendingMouseMoveEvent) {
      delegate.onMouseMove(pendingMouseMoveEvent);
    }

    this.active = delegate.isResizingAny();
  }

  private clearPendingEvents(): void {
    this.pendingMouseMoveEvent = null;
  }

  private failActiveGesture(message: string, error: unknown): void {
    this.gestureId += 1;
    this.active = false;
    this.clearPendingEvents();
    this.warn(message, error);
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning sinks must not re-open sidebar resize event failure paths.
    }
  }
}
