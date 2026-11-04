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

export type ActionQueueOwnerReloadPreflight = (
  token: ActionQueueOwnerReloadToken,
  isCurrent: () => boolean,
) => Promise<ActionQueueOwnerReloadPreflightResult>;

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
    await this.reloadWith(
      token => this.dependencies.preflight(token),
      true,
    );
  }

  reloadForRestoreReadback(
    preflight: ActionQueueOwnerReloadPreflight,
    verifyOwnership: () => Promise<boolean>,
  ): Promise<boolean> {
    return this.reloadWith(preflight, false, verifyOwnership);
  }

  private async reloadWith(
    preflight: ActionQueueOwnerReloadPreflight,
    activateAfterPublication: boolean,
    verifyReadbackOwnership?: () => Promise<boolean>,
  ): Promise<boolean> {
    const token = this.dependencies.beginLoad();
    const hasReadbackOwnership = async (): Promise<boolean> => {
      if (!verifyReadbackOwnership) return true;
      try {
        return await verifyReadbackOwnership();
      } catch {
        return false;
      }
    };
    try {
      const preflightResult = await preflight(
        token,
        () => this.dependencies.isLoadCurrent(token),
      );
      if (preflightResult.status !== 'CLEAR') {
        this.finishWithoutPublication(token, 'failed', 'preflight', preflightResult.reason);
        return false;
      }
    } catch (error) {
      this.finishWithoutPublication(token, 'failed', 'preflight', error);
      return false;
    }
    if (!this.dependencies.isLoadCurrent(token)
      || (verifyReadbackOwnership && !await hasReadbackOwnership())
      || !this.dependencies.isLoadCurrent(token)) {
      this.dependencies.completeLoad(token, 'stale');
      return false;
    }
    const preimage = this.dependencies.captureState();
    let staged: ActionQueueOwnerReloadStage<TQueue, TDeadLetter>;
    try {
      staged = await this.dependencies.stage(token);
    } catch (error) {
      this.finishWithoutPublication(token, 'failed', 'staging', error);
      return false;
    }
    if (staged.outcome !== 'ready' || !staged.state) {
      this.dependencies.completeLoad(token, staged.outcome);
      return false;
    }
    if (!this.dependencies.isLoadCurrent(token)
      || (verifyReadbackOwnership && !await hasReadbackOwnership())
      || !this.dependencies.isLoadCurrent(token)) {
      this.dependencies.completeLoad(token, 'stale');
      return false;
    }
    try {
      this.dependencies.publishState(staged.state);
      if (!this.dependencies.isLoadCurrent(token)
        || (verifyReadbackOwnership && !await hasReadbackOwnership())
        || !this.dependencies.isLoadCurrent(token)
        || !this.dependencies.statesMatch(staged.state, this.dependencies.captureState())) {
        throw new StaleOwnerStoragePublicationError();
      }
      if (activateAfterPublication) {
        this.dependencies.completeLoad(token, 'ready');
        if (!this.dependencies.isLoadedCurrent(token)) {
          throw new StaleOwnerStoragePublicationError();
        }
        this.dependencies.activate(token);
      } else {
        this.dependencies.completeLoad(token, 'failed');
      }
      return true;
    } catch (error) {
      const tokenIsCurrent = this.dependencies.isLoadCurrent(token);
      const stale = error instanceof StaleOwnerStoragePublicationError || !tokenIsCurrent;
      const rollbackVerified = tokenIsCurrent ? this.restorePreimage(preimage) : false;
      if (tokenIsCurrent) this.dependencies.invalidateLoaded(token);
      this.dependencies.completeLoad(token, stale ? 'stale' : 'failed');
      this.dependencies.warn('ActionQueue owner storage publication failed', {
        ownerUserId: token.ownerUserId,
        generation: token.generation,
        rollbackVerified,
        error,
      });
      return false;
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
