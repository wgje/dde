export interface ActionQueueProcessSettledSummary {
  processed: number;
  failed: number;
  movedToDeadLetter: number;
  remaining: number;
  remoteSuccessCount: number;
  resolvedNoOpCount: number;
}

export class ActionQueueLifecycleController {
  private onStart: (() => void) | null = null;
  private onEnd: (() => void) | null = null;
  private onSettled: ((summary: ActionQueueProcessSettledSummary) => void) | null = null;
  private activeTokens = new Set<number>();
  private remoteSuccessActionIdsByToken = new Map<number, Set<string>>();
  private resolvedNoOpActionIdsByToken = new Map<number, Set<string>>();
  private actionTokenById = new Map<string, number>();
  private nextToken = 0;

  setCallbacks(
    onStart: () => void,
    onEnd: () => void,
    onSettled?: (summary: ActionQueueProcessSettledSummary) => void,
  ): void {
    this.onStart = onStart;
    this.onEnd = onEnd;
    this.onSettled = onSettled ?? null;
  }

  clearCallbacks(): void {
    this.onStart = null;
    this.onEnd = null;
    this.onSettled = null;
  }

  begin(): number {
    const token = ++this.nextToken;
    const shouldNotifyStart = this.activeTokens.size === 0;
    this.activeTokens.add(token);
    this.remoteSuccessActionIdsByToken.set(token, new Set<string>());
    this.resolvedNoOpActionIdsByToken.set(token, new Set<string>());
    if (shouldNotifyStart) {
      this.invokeLifecycleCallback(this.onStart);
    }
    return token;
  }

  end(token: number): void {
    if (!this.activeTokens.delete(token)) {
      return;
    }

    if (this.activeTokens.size === 0) {
      this.invokeLifecycleCallback(this.onEnd);
    }
  }

  releaseAll(): boolean {
    if (this.activeTokens.size === 0) {
      return false;
    }

    this.activeTokens.clear();
    this.invokeLifecycleCallback(this.onEnd);
    return true;
  }

  notifySettled(summary: ActionQueueProcessSettledSummary): void {
    try {
      this.onSettled?.(summary);
    } catch {
      // View callbacks must not interrupt queue lifecycle bookkeeping.
    }
  }

  trackAction(token: number, actionId: string): void {
    this.actionTokenById.set(actionId, token);
    if (!this.remoteSuccessActionIdsByToken.has(token)) {
      this.remoteSuccessActionIdsByToken.set(token, new Set<string>());
    }
    if (!this.resolvedNoOpActionIdsByToken.has(token)) {
      this.resolvedNoOpActionIdsByToken.set(token, new Set<string>());
    }
  }

  untrackAction(actionId: string): void {
    this.actionTokenById.delete(actionId);
  }

  markActionSyncedRemotely(actionId: string): boolean {
    const token = this.actionTokenById.get(actionId);
    if (token === undefined) return false;
    this.remoteSuccessActionIdsByToken.get(token)?.add(actionId);
    return true;
  }

  markActionResolvedWithoutRemote(actionId: string): boolean {
    const token = this.actionTokenById.get(actionId);
    if (token === undefined) return false;
    this.resolvedNoOpActionIdsByToken.get(token)?.add(actionId);
    return true;
  }

  getActionOutcomeCounts(token: number): Pick<ActionQueueProcessSettledSummary, 'remoteSuccessCount' | 'resolvedNoOpCount'> {
    return {
      remoteSuccessCount: this.remoteSuccessActionIdsByToken.get(token)?.size ?? 0,
      resolvedNoOpCount: this.resolvedNoOpActionIdsByToken.get(token)?.size ?? 0,
    };
  }

  clearActionOutcomes(token: number): void {
    this.remoteSuccessActionIdsByToken.delete(token);
    this.resolvedNoOpActionIdsByToken.delete(token);
    for (const [actionId, actionToken] of this.actionTokenById) {
      if (actionToken === token) {
        this.actionTokenById.delete(actionId);
      }
    }
  }

  private invokeLifecycleCallback(callback: (() => void) | null): void {
    try {
      callback?.();
    } catch {
      // View callbacks must not interrupt queue lifecycle bookkeeping.
    }
  }
}
