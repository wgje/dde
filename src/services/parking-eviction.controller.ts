import type {
  EvictionToken,
  EvictionTokenMap,
  ParkingNotice,
  ParkingNoticeEvictionItem,
  Task,
  TaskParkingMeta,
} from '../models';

export interface ParkingEvictionControllerOptions {
  undoTimeoutMs: number;
  noticeMinVisibleMs: number;
  noticeFallbackTimeoutMs: number;
  now?: () => number;
  idFactory?: () => string;
}

export type MarkEvictionTokenUsedResult =
  | { status: 'restored'; token: EvictionToken }
  | { status: 'missing' }
  | { status: 'expired'; token: EvictionToken }
  | { status: 'used'; token: EvictionToken };

export class ParkingEvictionController {
  private readonly tokens: EvictionTokenMap = new Map();
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(private readonly options: ParkingEvictionControllerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  createToken(task: Task, previousParkingMeta: TaskParkingMeta | null = task.parkingMeta ?? null): EvictionToken | null {
    if (!previousParkingMeta) return null;

    const now = this.now();
    const token: EvictionToken = {
      tokenId: this.idFactory(),
      taskId: task.id,
      taskTitle: task.title,
      previousParkingMeta: { ...previousParkingMeta },
      createdAt: now,
      expiresAt: now + this.options.undoTimeoutMs,
      usedAt: null,
    };
    this.tokens.set(token.tokenId, token);
    return token;
  }

  markTokenUsed(tokenId: string): MarkEvictionTokenUsedResult {
    const token = this.tokens.get(tokenId);
    if (!token) {
      return { status: 'missing' };
    }
    const now = this.now();
    if (this.isTokenExpiredAt(token, now)) {
      this.tokens.delete(tokenId);
      return { status: 'expired', token };
    }
    if (token.usedAt !== null) {
      return { status: 'used', token };
    }

    token.usedAt = now;
    this.tokens.set(tokenId, token);
    return { status: 'restored', token };
  }

  consumeToken(tokenId: string): void {
    const token = this.tokens.get(tokenId);
    if (!token) return;
    token.usedAt = this.now();
    this.tokens.set(tokenId, token);
  }

  getToken(tokenId: string): EvictionToken | null {
    const token = this.tokens.get(tokenId) ?? null;
    if (!token) return null;
    if (this.isTokenExpiredAt(token, this.now())) {
      this.tokens.delete(tokenId);
      return null;
    }
    return token;
  }

  pruneExpiredTokens(): void {
    if (this.tokens.size === 0) return;

    const now = this.now();
    for (const [tokenId, token] of this.tokens.entries()) {
      if (this.isTokenExpiredAt(token, now) || token.usedAt !== null) {
        this.tokens.delete(tokenId);
      }
    }
  }

  createNotice(items: ParkingNoticeEvictionItem[]): ParkingNotice {
    if (items.length === 1) {
      const item = items[0];
      return {
        id: this.idFactory(),
        type: 'eviction',
        taskId: item.taskId,
        taskTitle: item.taskTitle,
        minVisibleMs: this.options.noticeMinVisibleMs,
        fallbackTimeoutMs: this.options.noticeFallbackTimeoutMs,
        reason: '72 小时未访问，已自动移回任务列表。',
        evictionTokenId: item.evictionTokenId,
        actions: [
          { key: 'undo-eviction', label: '撤回' },
          { key: 'keep-parked', label: '关闭' },
        ],
      };
    }

    return {
      id: this.idFactory(),
      type: 'eviction',
      taskId: items[0].taskId,
      taskTitle: `${items.length} 个停泊任务已移回任务列表`,
      minVisibleMs: this.options.noticeMinVisibleMs,
      fallbackTimeoutMs: this.options.noticeFallbackTimeoutMs,
      reason: '72 小时未访问，已自动清理，可逐条撤回。',
      evictionItems: items,
      actions: [
        { key: 'keep-parked', label: '关闭' },
      ],
    };
  }

  private isTokenExpiredAt(token: EvictionToken, now: number): boolean {
    return token.expiresAt <= now;
  }
}
