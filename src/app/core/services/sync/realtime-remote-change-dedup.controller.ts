export interface RealtimeRemoteChangePayload {
  eventType?: string;
  projectId?: string;
}

export interface StaleRealtimeRemoteChangePayload {
  payloadProjectId: string;
  currentProjectId: string;
  eventType?: string;
}

export type RealtimeRemoteChangeDedupResult =
  | { status: 'started'; key: string; token: number }
  | { status: 'active-duplicate'; key: string }
  | { status: 'recent-duplicate'; key: string };

export interface RealtimeRemoteChangeDedupLogger {
  debug(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
}

export interface RealtimeRemoteChangeDedupRunOptions {
  callback: ((payload: RealtimeRemoteChangePayload) => Promise<void> | void) | null;
  failureMessage: string;
  logger: RealtimeRemoteChangeDedupLogger;
}

export function createEffectiveRealtimeRemoteChangePayload(
  payload: RealtimeRemoteChangePayload | undefined,
  currentProjectId: string | null,
): RealtimeRemoteChangePayload {
  return payload ?? {
    eventType: 'manual',
    projectId: currentProjectId ?? undefined,
  };
}

export function getStaleRealtimeRemoteChangePayload(
  payload: RealtimeRemoteChangePayload,
  currentProjectId: string | null,
): StaleRealtimeRemoteChangePayload | null {
  if (
    payload.projectId === undefined
    || currentProjectId === null
    || payload.projectId === currentProjectId
  ) {
    return null;
  }

  return {
    payloadProjectId: payload.projectId,
    currentProjectId,
    eventType: payload.eventType,
  };
}

export class RealtimeRemoteChangeDedupController {
  private readonly activeKeys = new Map<string, number>();
  private readonly recentKeys = new Map<string, ReturnType<typeof globalThis.setTimeout>>();
  private clearGeneration = 0;
  private nextToken = 0;

  constructor(private readonly dedupWindowMs: number) {}

  begin(payload: RealtimeRemoteChangePayload): RealtimeRemoteChangeDedupResult {
    const key = this.createKey(payload);

    if (this.activeKeys.has(key)) {
      return { status: 'active-duplicate', key };
    }

    if (this.recentKeys.has(key)) {
      return { status: 'recent-duplicate', key };
    }

    this.nextToken += 1;
    this.activeKeys.set(key, this.nextToken);
    return { status: 'started', key, token: this.nextToken };
  }

  markRecent(key: string): void {
    const existingTimer = this.recentKeys.get(key);
    if (existingTimer !== undefined) {
      globalThis.clearTimeout(existingTimer);
    }

    const timer = globalThis.setTimeout(() => {
      if (this.recentKeys.get(key) === timer) {
        this.recentKeys.delete(key);
      }
    }, this.dedupWindowMs);
    this.recentKeys.set(key, timer);
  }

  finish(key: string, token?: number): void {
    if (token === undefined || this.activeKeys.get(key) === token) {
      this.activeKeys.delete(key);
    }
  }

  async run(
    payload: RealtimeRemoteChangePayload,
    options: RealtimeRemoteChangeDedupRunOptions,
  ): Promise<boolean> {
    if (!options.callback) {
      return false;
    }

    const dedup = this.begin(payload);
    if (dedup.status === 'active-duplicate') {
      this.debug(options.logger, '跳过重复的立即远程同步触发', payload);
      return false;
    }
    if (dedup.status === 'recent-duplicate') {
      this.debug(options.logger, '跳过远程变更窗口内的重复同步触发', payload);
      return false;
    }

    const runClearGeneration = this.clearGeneration;
    try {
      await options.callback(payload);
      if (
        runClearGeneration === this.clearGeneration
        && this.activeKeys.get(dedup.key) === dedup.token
      ) {
        this.markRecent(dedup.key);
      }
      return true;
    } catch (error) {
      this.warn(options.logger, options.failureMessage, { error, payload });
      return false;
    } finally {
      this.finish(dedup.key, dedup.token);
    }
  }

  clear(): void {
    this.clearGeneration += 1;
    this.activeKeys.clear();
    this.recentKeys.forEach(timer => {
      globalThis.clearTimeout(timer);
    });
    this.recentKeys.clear();
  }

  private createKey(payload: RealtimeRemoteChangePayload): string {
    // 去重身份按项目归一：polling/reconnect/realtime/manual 最终都触发同一个
    // 活动项目拉取回调，按 eventType 分键会让一次重连的轮询首 tick 与
    // reconnect 扇出各自放行，同一秒对弱网发出两次全量拉取
    return `remote-change:${payload.projectId ?? ''}`;
  }

  private debug(
    logger: RealtimeRemoteChangeDedupLogger,
    message: string,
    data?: unknown,
  ): void {
    try {
      logger.debug(message, data);
    } catch {
      // Diagnostic sinks must not affect remote-change dedup behavior.
    }
  }

  private warn(
    logger: RealtimeRemoteChangeDedupLogger,
    message: string,
    data?: unknown,
  ): void {
    try {
      logger.warn(message, data);
    } catch {
      // Diagnostic sinks must not affect remote-change dedup behavior.
    }
  }
}
