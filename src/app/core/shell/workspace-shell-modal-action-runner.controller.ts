import type { WritableSignal } from '@angular/core';

export type WorkspaceShellModalAction<TModalCoord> = (
  modalCoord: TModalCoord,
) => Promise<void> | void;

export interface WorkspaceShellModalActionRunnerOptions<TModalCoord> {
  modalLoading: WritableSignal<Record<string, boolean>>;
  getModalCoord: () => Promise<TModalCoord | null>;
  isCoordinatorLoading?: (type: string) => boolean;
}

export class WorkspaceShellModalActionRunner<TModalCoord> {
  constructor(private readonly options: WorkspaceShellModalActionRunnerOptions<TModalCoord>) {}

  isLoading(type: string): boolean {
    const localLoading = this.options.modalLoading()[type];
    if (localLoading !== undefined) {
      return localLoading;
    }

    try {
      return this.options.isCoordinatorLoading?.(type) ?? false;
    } catch {
      return false;
    }
  }

  setLoading(type: string, loading: boolean): void {
    this.options.modalLoading.update(state => {
      const next = { ...state };
      if (loading) {
        next[type] = true;
      } else {
        delete next[type];
      }
      return next;
    });
  }

  async run(
    loadingType: string | null,
    action: WorkspaceShellModalAction<TModalCoord>,
  ): Promise<void> {
    if (loadingType && this.isLoading(loadingType)) {
      return;
    }

    if (loadingType) {
      this.setLoading(loadingType, true);
    }

    try {
      const modalCoord = await this.options.getModalCoord();
      if (!modalCoord) {
        return;
      }
      await action(modalCoord);
    } finally {
      if (loadingType) {
        this.setLoading(loadingType, false);
      }
    }
  }
}
