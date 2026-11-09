import type { Subscription } from 'rxjs';
import type { ConflictEvent } from '../../../services/sync-coordinator.service';

export interface WorkspaceShellConflictHandlerControllerOptions {
  subscribeToConflictEvents: (listener: (event: ConflictEvent) => void) => Subscription;
  setPendingConflict: (event: ConflictEvent) => void;
  openConflictModal: (event: ConflictEvent) => Promise<void> | void;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellConflictHandlerController {
  private conflictSubscription: Subscription | null = null;

  constructor(private readonly options: WorkspaceShellConflictHandlerControllerOptions) {}

  setup(): void {
    this.cleanup();
    this.conflictSubscription = this.options.subscribeToConflictEvents((event) => {
      this.options.setPendingConflict(event);
      this.openConflictModalSafely(event);
    });
  }

  cleanup(): void {
    const conflictSubscription = this.conflictSubscription;
    this.conflictSubscription = null;
    try {
      conflictSubscription?.unsubscribe();
    } catch (error) {
      this.warn('Workspace conflict subscription cleanup failed', error);
    }
  }

  private openConflictModalSafely(event: ConflictEvent): void {
    try {
      void Promise.resolve(this.options.openConflictModal(event)).catch((error: unknown) => {
        this.warn('Workspace conflict modal open failed', error);
      });
    } catch (error) {
      this.warn('Workspace conflict modal open failed', error);
    }
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning sinks must not interrupt conflict event or cleanup boundaries.
    }
  }
}
