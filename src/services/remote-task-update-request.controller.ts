export class RemoteTaskUpdateRequestController {
  private nextRequestId = 0;
  private readonly currentRequestIdByTask = new Map<string, number>();
  private destroyed = false;

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  start(projectId: string, taskId: string): number {
    const requestId = ++this.nextRequestId;
    this.currentRequestIdByTask.set(this.getTaskKey(projectId, taskId), requestId);
    return requestId;
  }

  getCurrentRequestId(projectId: string, taskId: string): number {
    return this.currentRequestIdByTask.get(this.getTaskKey(projectId, taskId)) ?? 0;
  }

  isCurrent(projectId: string, taskId: string, requestId: number): boolean {
    return !this.destroyed && this.getCurrentRequestId(projectId, taskId) === requestId;
  }

  destroy(): void {
    this.destroyed = true;
    this.currentRequestIdByTask.clear();
  }

  reset(): void {
    this.destroyed = false;
    this.currentRequestIdByTask.clear();
  }

  private getTaskKey(projectId: string, taskId: string): string {
    return JSON.stringify([projectId, taskId]);
  }
}
