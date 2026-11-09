import type { LocalBackupResult } from '../config/local-backup.config';

export interface LocalBackupRunContext {
  runtimeGeneration: number;
  runToken: number;
  userId: string | null;
}

interface LocalBackupSessionRuntimeAdapters {
  currentUserId(): string | null;
  restartAutoBackup(): void;
  setBackingUp(value: boolean): void;
  stopAutoBackup(): void;
}

export function buildStaleLocalBackupSessionResult(): LocalBackupResult {
  return { success: false, error: '会话已切换' };
}

export class LocalBackupSessionRuntimeController {
  private runtimeGeneration = 0;
  private runToken = 0;
  private destroyed = false;

  constructor(private readonly adapters: LocalBackupSessionRuntimeAdapters) {}

  beginRun(): LocalBackupRunContext {
    return {
      runtimeGeneration: this.runtimeGeneration,
      runToken: ++this.runToken,
      userId: this.adapters.currentUserId(),
    };
  }

  isRunCurrent(context: LocalBackupRunContext): boolean {
    return !this.destroyed
      && context.runtimeGeneration === this.runtimeGeneration
      && context.runToken === this.runToken
      && context.userId === this.adapters.currentUserId();
  }

  finishRun(context: LocalBackupRunContext): void {
    if (context.runToken === this.runToken) {
      this.adapters.setBackingUp(false);
    }
  }

  reset(): void {
    if (this.destroyed) return;

    const restartGeneration = ++this.runtimeGeneration;
    this.runToken += 1;
    this.adapters.stopAutoBackup();
    this.adapters.setBackingUp(false);

    queueMicrotask(() => {
      if (this.destroyed || restartGeneration !== this.runtimeGeneration) return;
      if (this.adapters.currentUserId()) {
        this.adapters.restartAutoBackup();
      }
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.runtimeGeneration += 1;
    this.runToken += 1;
    this.adapters.setBackingUp(false);
  }
}
