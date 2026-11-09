export class WorkspaceShellSidebarResizePendingMouseMoveController {
  private pendingEvent: MouseEvent | null = null;

  queue(event: MouseEvent): void {
    this.pendingEvent = event;
  }

  clear(): void {
    this.pendingEvent = null;
  }

  flush(action: (event: MouseEvent) => void): void {
    const pendingEvent = this.pendingEvent;
    this.clear();

    if (pendingEvent) {
      action(pendingEvent);
    }
  }
}
