import type { OwnerStorageRestoreOutcome } from './action-queue-restore-barrier.controller';
import { buildActionQueueOwnerReloadDependencies } from './action-queue-retry-supersession.controller';

export interface ActionQueueOwnerReloadToken {
  ownerUserId: string;
  generation: number;
}

export interface ActionQueueOwnerReloadState<TQueue, TDeadLetter> {
  queue: readonly TQueue[];
  queueSize: number;
  deadLetters: readonly TDeadLetter[];
  deadLetterSize: number;
  queueFrozen: boolean;
  queueFreezeReason: string | null;
}

export interface ActionQueueOwnerReloadStage<TQueue, TDeadLetter> {
  outcome: OwnerStorageRestoreOutcome;
  state?: ActionQueueOwnerReloadState<TQueue, TDeadLetter>;
}

export type ActionQueueOwnerReloadPreflightResult =
  | { status: 'CLEAR' }
  | { status: 'HOLD'; reason: string };

export interface ActionQueueOwnerReloadDependencies<TQueue, TDeadLetter> {
  beginLoad: () => ActionQueueOwnerReloadToken;
  isLoadCurrent: (token: ActionQueueOwnerReloadToken) => boolean;
  preflight: (token: ActionQueueOwnerReloadToken) => Promise<ActionQueueOwnerReloadPreflightResult>;
  completeLoad: (
    token: ActionQueueOwnerReloadToken,
    outcome: OwnerStorageRestoreOutcome,
  ) => void;
  isLoadedCurrent: (token: ActionQueueOwnerReloadToken) => boolean;
  invalidateLoaded: (token: ActionQueueOwnerReloadToken) => void;
  captureState: () => ActionQueueOwnerReloadState<TQueue, TDeadLetter>;
  stage: (
    token: ActionQueueOwnerReloadToken,
  ) => Promise<ActionQueueOwnerReloadStage<TQueue, TDeadLetter>>;
  publishState: (state: ActionQueueOwnerReloadState<TQueue, TDeadLetter>) => void;
  statesMatch: (
    expected: ActionQueueOwnerReloadState<TQueue, TDeadLetter>,
    actual: ActionQueueOwnerReloadState<TQueue, TDeadLetter>,
  ) => boolean;
  activate: (token: ActionQueueOwnerReloadToken) => void;
  warn: (message: string, context: Record<string, unknown>) => void;
}

export interface ActionQueueOwnerReloadFactoryDependencies<TQueue, TDeadLetter, TRetryBridge> {
  ownerStorageLoad: {
    begin(): ActionQueueOwnerReloadToken;
    isCurrent(token: ActionQueueOwnerReloadToken): boolean;
    complete(token: ActionQueueOwnerReloadToken, outcome: OwnerStorageRestoreOutcome): void;
    isExactLoaded(ownerUserId: string, generation: number): boolean;
    invalidateExactLoaded(ownerUserId: string, generation: number): void;
  };
  preActionQueueFence: {
    run(input: { ownerUserId: string; isCurrent(): boolean }): Promise<
      { status: 'CLEAR' } | { status: 'HOLD'; reason: string }
    >;
  };
  storage: {
    captureCurrentOwnerStorageState(): ActionQueueOwnerReloadState<TQueue, TDeadLetter>;
    stageCurrentOwnerStorage(
      generation: number,
      ownerUserId: string,
      getCurrentGeneration: () => number,
    ): Promise<ActionQueueOwnerReloadStage<TQueue, TDeadLetter>>;
    publishCurrentOwnerStorageState(state: ActionQueueOwnerReloadState<TQueue, TDeadLetter>): void;
    currentOwnerStorageStateMatches(state: ActionQueueOwnerReloadState<TQueue, TDeadLetter>): boolean;
    setupNetworkListeners(): void;
    removeNetworkListeners(): void;
    requestQueueProcessing(reason: string): void;
  };
  retryQueue: { configureActionQueueSupersessionBridge(bridge: TRetryBridge): void };
  createRetryBridge(): TRetryBridge;
  warn(message: string, context: Record<string, unknown>): void;
}

export function createActionQueueOwnerReloadController<TQueue, TDeadLetter, TRetryBridge>(
  dependencies: ActionQueueOwnerReloadFactoryDependencies<TQueue, TDeadLetter, TRetryBridge>,
): ActionQueueOwnerReloadController<TQueue, TDeadLetter> {
  return new ActionQueueOwnerReloadController(
    buildActionQueueOwnerReloadDependencies(dependencies),
  );
}

export class ActionQueueOwnerReloadController<TQueue, TDeadLetter> {
  constructor(private readonly dependencies: ActionQueueOwnerReloadDependencies<TQueue, TDeadLetter>) {}

  async reload(): Promise<void> {
    const token = this.dependencies.beginLoad();
    try {
      const preflight = await this.dependencies.preflight(token);
      if (preflight.status !== 'CLEAR') {
        this.finishWithoutPublication(token, 'failed', 'preflight', preflight.reason);
        return;
      }
    } catch (error) {
      this.finishWithoutPublication(token, 'failed', 'preflight', error);
      return;
    }
    const preimage = this.dependencies.captureState();
    let staged: ActionQueueOwnerReloadStage<TQueue, TDeadLetter>;
    try {
      staged = await this.dependencies.stage(token);
    } catch (error) {
      this.finishWithoutPublication(token, 'failed', 'staging', error);
      return;
    }
    if (staged.outcome !== 'ready' || !staged.state) {
      this.dependencies.completeLoad(token, staged.outcome);
      return;
    }
    if (!this.dependencies.isLoadCurrent(token)) {
      this.dependencies.completeLoad(token, 'stale');
      return;
    }
    try {
      this.dependencies.publishState(staged.state);
      const current = this.dependencies.captureState();
      if (!this.dependencies.isLoadCurrent(token)
        || !this.dependencies.statesMatch(staged.state, current)) {
        throw new StaleOwnerStoragePublicationError();
      }
      this.dependencies.completeLoad(token, 'ready');
      if (!this.dependencies.isLoadedCurrent(token)) {
        throw new StaleOwnerStoragePublicationError();
      }
      this.dependencies.activate(token);
    } catch (error) {
      const stale = error instanceof StaleOwnerStoragePublicationError;
      const rollbackVerified = this.restorePreimage(preimage);
      this.dependencies.invalidateLoaded(token);
      this.dependencies.completeLoad(token, stale ? 'stale' : 'failed');
      this.dependencies.warn('ActionQueue owner storage publication failed', {
        ownerUserId: token.ownerUserId,
        generation: token.generation,
        rollbackVerified,
        error,
      });
    }
  }

  private restorePreimage(state: ActionQueueOwnerReloadState<TQueue, TDeadLetter>): boolean {
    try {
      this.dependencies.publishState(state);
      return this.dependencies.statesMatch(state, this.dependencies.captureState());
    } catch {
      return false;
    }
  }

  private finishWithoutPublication(
    token: ActionQueueOwnerReloadToken,
    outcome: OwnerStorageRestoreOutcome,
    phase: string,
    error: unknown,
  ): void {
    this.dependencies.completeLoad(token, outcome);
    this.dependencies.warn('ActionQueue owner storage staging failed', {
      ownerUserId: token.ownerUserId,
      generation: token.generation,
      phase,
      error,
    });
  }
}

class StaleOwnerStoragePublicationError extends Error {
  constructor() {
    super('owner storage publication became stale before loaded');
  }
}
