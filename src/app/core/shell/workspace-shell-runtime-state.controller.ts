export class WorkspaceShellRuntimeStateController {
  private isDestroyed = false;
  readonly destroyedDelegate = (): boolean => this.destroyed();
  readonly markDestroyedDelegate = (): void => this.markDestroyed();

  destroyed(): boolean {
    return this.isDestroyed;
  }

  markDestroyed(): void {
    this.isDestroyed = true;
  }
}
