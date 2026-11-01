export interface ProjectShellContentResizeFrameControllerOptions {
  applyMove(clientX: number): void;
}

export class ProjectShellContentResizeFrameController {
  private frameId: number | null = null;
  private generation = 0;

  constructor(
    private readonly options: ProjectShellContentResizeFrameControllerOptions,
  ) {}

  schedule(clientX: number): void {
    if (this.frameId !== null) return;

    const generation = this.generation + 1;
    this.generation = generation;
    let frameId: number | null = null;
    try {
      frameId = this.requestFrame(() =>
        this.applyScheduledMove(clientX, frameId, generation));
    } catch {
      this.frameId = null;
      this.options.applyMove(clientX);
      return;
    }
    this.frameId = frameId;
  }

  clear(): void {
    if (this.frameId === null) return;

    const frameId = this.frameId;
    this.generation += 1;
    this.frameId = null;
    try {
      this.cancelFrame(frameId);
    } catch {
      // Generation invalidation keeps stale frames from applying after cleanup.
    }
  }

  private applyScheduledMove(
    clientX: number,
    frameId: number | null,
    generation: number,
  ): void {
    if (this.generation !== generation || this.frameId !== frameId) {
      return;
    }

    this.frameId = null;
    this.options.applyMove(clientX);
  }

  private requestFrame(callback: FrameRequestCallback): number {
    return typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(callback)
      : setTimeout(() => callback(Date.now()), 16) as unknown as number;
  }

  private cancelFrame(frameId: number): void {
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(frameId);
      return;
    }

    clearTimeout(frameId);
  }
}
