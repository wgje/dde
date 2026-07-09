export interface ActionQueueFrozenPersistenceControllerOptions {
  isQueueFrozen: () => boolean;
  saveQueueToStorage: () => void;
  retryCooldownMs?: number;
  now?: () => number;
}

const DEFAULT_FROZEN_PERSIST_RETRY_COOLDOWN_MS = 30_000;

export class ActionQueueFrozenPersistenceController {
  private lastFrozenPersistAttemptAt: number | null = null;
  private readonly retryCooldownMs: number;
  private readonly now: () => number;

  constructor(private readonly options: ActionQueueFrozenPersistenceControllerOptions) {
    this.retryCooldownMs = options.retryCooldownMs ?? DEFAULT_FROZEN_PERSIST_RETRY_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
  }

  persist(): void {
    if (!this.options.isQueueFrozen()) {
      this.options.saveQueueToStorage();
      return;
    }

    const now = this.now();
    if (
      this.lastFrozenPersistAttemptAt !== null
      && now - this.lastFrozenPersistAttemptAt < this.retryCooldownMs
    ) {
      return;
    }

    this.lastFrozenPersistAttemptAt = now;
    this.options.saveQueueToStorage();
  }
}
