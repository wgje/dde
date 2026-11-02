import { signal } from '@angular/core';

interface FlowTaskDetailPlannerSaveControllerOptions {
  isScopeActive: (taskId: string) => boolean;
  markForCheck: () => void;
}

export class FlowTaskDetailPlannerSaveController {
  readonly state = signal<'idle' | 'saving' | 'failed'>('idle');
  private requestId = 0;
  private scopeTaskId: string | null = null;
  private destroyed = false;

  constructor(private readonly options: FlowTaskDetailPlannerSaveControllerOptions) {}

  setScope(taskId: string | null): void {
    if (taskId === this.scopeTaskId) {
      return;
    }

    this.scopeTaskId = taskId;
    this.invalidate();
  }

  async persist(taskId: string, save: () => Promise<boolean>): Promise<boolean> {
    const ownsState = this.isScopeCurrent(taskId);
    const requestId = ownsState ? ++this.requestId : null;
    if (requestId !== null) {
      this.state.set('saving');
    }

    let saved = false;
    try {
      saved = await save();
    } catch {
      saved = false;
    }

    if (requestId !== null && this.isRequestCurrent(taskId, requestId)) {
      this.state.set(saved ? 'idle' : 'failed');
      this.options.markForCheck();
    }
    return saved;
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.scopeTaskId = null;
    this.invalidate();
  }

  private isScopeCurrent(taskId: string): boolean {
    return !this.destroyed
      && this.scopeTaskId === taskId
      && this.options.isScopeActive(taskId);
  }

  private isRequestCurrent(taskId: string, requestId: number): boolean {
    return requestId === this.requestId && this.isScopeCurrent(taskId);
  }

  private invalidate(): void {
    this.requestId += 1;
    this.state.set('idle');
  }
}
