export type WorkspaceShellSidebarResizePendingGestureId = number;

export class WorkspaceShellSidebarResizePendingGestureController {
  private active = false;
  private generation = 0;
  private tornDown = false;

  start(): WorkspaceShellSidebarResizePendingGestureId | null {
    if (this.tornDown) return null;

    this.generation += 1;
    this.active = true;
    return this.generation;
  }

  cancel(): void {
    if (this.tornDown) return;

    this.generation += 1;
    this.active = false;
  }

  finish(
    gesture: WorkspaceShellSidebarResizePendingGestureId | null,
    active: boolean,
  ): boolean {
    if (!this.isCurrent(gesture)) return false;

    this.active = active;
    return true;
  }

  teardown(): void {
    if (this.tornDown) return;

    this.tornDown = true;
    this.generation += 1;
    this.active = false;
  }

  isResizingAny(delegateResizing: boolean): boolean {
    if (this.tornDown) return false;

    return this.active || delegateResizing;
  }

  isCurrent(gesture: WorkspaceShellSidebarResizePendingGestureId | null): boolean {
    return gesture !== null && !this.tornDown && gesture === this.generation;
  }

  isTornDown(): boolean {
    return this.tornDown;
  }
}
