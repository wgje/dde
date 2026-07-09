export type PersistAuthContext = { userId: string | null; generation: number };

export class PersistAuthContextTracker {
  private currentGeneration = 0;
  private lastObservedUserId: string | null | undefined = undefined;

  get generation(): number {
    return this.currentGeneration;
  }

  capture(expectedUserId: string | null, currentUserId: string | null): PersistAuthContext {
    this.sync(currentUserId);
    return {
      userId: expectedUserId,
      generation: this.currentGeneration,
    };
  }

  isCurrent(context: PersistAuthContext, currentUserId: string | null): boolean {
    this.sync(currentUserId);
    return context.generation === this.currentGeneration && currentUserId === context.userId;
  }

  private sync(currentUserId: string | null): void {
    if (this.lastObservedUserId === undefined) {
      this.lastObservedUserId = currentUserId;
      this.currentGeneration = 1;
      return;
    }

    if (this.lastObservedUserId !== currentUserId) {
      this.lastObservedUserId = currentUserId;
      this.currentGeneration += 1;
    }
  }
}
