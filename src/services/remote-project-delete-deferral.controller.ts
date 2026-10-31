export interface RemoteProjectDeleteSessionContext {
  userId: string;
  sessionGeneration: number;
}

interface RemoteProjectDeleteProbe {
  accessible: boolean;
}

interface RemoteProjectDeleteDeferralControllerOptions {
  hasPendingWrite(projectId: string, ownerUserId: string): boolean;
  isSessionCurrent(context: RemoteProjectDeleteSessionContext, projectId: string): boolean;
  probe(projectId: string): Promise<RemoteProjectDeleteProbe | null>;
  apply(projectId: string): void;
  debug(message: string, context: Record<string, unknown>): void;
  info(message: string, context: Record<string, unknown>): void;
  warn(message: string, context: Record<string, unknown>): void;
}

export class RemoteProjectDeleteDeferralController {
  private readonly deferred = new Map<string, RemoteProjectDeleteSessionContext>();
  private reevaluationRequested = false;
  private reevaluationInFlight: Promise<void> | null = null;
  private destroyed = false;

  constructor(private readonly options: RemoteProjectDeleteDeferralControllerOptions) {}

  handle(
    projectId: string,
    context: RemoteProjectDeleteSessionContext,
    forceDefer = false,
  ): 'applied' | 'deferred' | 'stale-session' {
    if (!this.options.isSessionCurrent(context, projectId)) {
      return 'stale-session';
    }

    if (forceDefer || this.options.hasPendingWrite(projectId, context.userId)) {
      this.deferred.set(projectId, context);
      this.options.debug('延迟远程项目删除，等待本地写入状态确定', {
        projectId,
        ownerUserId: context.userId,
        forceDefer,
      });
      return 'deferred';
    }

    this.deferred.delete(projectId);
    this.options.apply(projectId);
    return 'applied';
  }

  cancel(projectId: string): void {
    this.deferred.delete(projectId);
  }

  requestReevaluation(): void {
    if (this.destroyed || this.deferred.size === 0) return;
    this.reevaluationRequested = true;
    if (this.reevaluationInFlight) return;

    this.reevaluationInFlight = this.drainReevaluationRequests()
      .finally(() => {
        this.reevaluationInFlight = null;
        if (this.reevaluationRequested) this.requestReevaluation();
      });
  }

  destroy(): void {
    this.destroyed = true;
    this.reevaluationRequested = false;
    this.deferred.clear();
  }

  private async drainReevaluationRequests(): Promise<void> {
    while (this.reevaluationRequested && !this.destroyed) {
      this.reevaluationRequested = false;
      await this.reevaluateOnce();
    }
  }

  private async reevaluateOnce(): Promise<void> {
    for (const [projectId, context] of [...this.deferred]) {
      if (this.destroyed) return;
      if (!this.options.isSessionCurrent(context, projectId)) {
        this.deferred.delete(projectId);
        continue;
      }
      if (this.options.hasPendingWrite(projectId, context.userId)) continue;

      const probe = await this.probeSafely(projectId);
      if (this.destroyed || this.deferred.get(projectId) !== context) continue;
      if (!this.options.isSessionCurrent(context, projectId)) {
        this.deferred.delete(projectId);
        continue;
      }
      if (this.options.hasPendingWrite(projectId, context.userId)) continue;
      if (probe === null) {
        this.options.warn('延迟项目删除重评估缺少权威探针，继续保留本地数据', { projectId });
        continue;
      }
      if (probe.accessible) {
        this.deferred.delete(projectId);
        this.options.info('延迟项目删除已被当前远端可访问状态取消', { projectId });
        continue;
      }

      this.deferred.delete(projectId);
      this.options.apply(projectId);
      this.options.info('延迟项目删除经权威探针确认后已应用', { projectId });
    }
  }

  private async probeSafely(projectId: string): Promise<RemoteProjectDeleteProbe | null> {
    try {
      return await this.options.probe(projectId);
    } catch (error) {
      this.options.warn('延迟项目删除权威探针失败，继续保留本地数据', { projectId, error });
      // eslint-disable-next-line no-restricted-syntax -- 探针失败是显式 unknown，必须保留本地数据等待后续重评估
      return null;
    }
  }
}
