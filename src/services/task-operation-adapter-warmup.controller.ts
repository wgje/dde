export interface TaskOperationAdapterWarmupRuntime {
  activeProjectId(): unknown;
  isEditing(): unknown;
  hasPendingLocalChanges(): unknown;
  clearHistory(): unknown;
}

export class TaskOperationAdapterWarmupController {
  private warmupPromise: Promise<void> | null = null;

  constructor(private readonly runtime: TaskOperationAdapterWarmupRuntime) {}

  warmup(): Promise<void> {
    if (this.warmupPromise) return this.warmupPromise;

    this.warmupPromise = Promise.resolve().then(() => {
      void this.runtime.activeProjectId();
      void this.runtime.isEditing();
      void this.runtime.hasPendingLocalChanges();
      void this.runtime.clearHistory();
    }).finally(() => {
      this.warmupPromise = null;
    });

    return this.warmupPromise;
  }
}
