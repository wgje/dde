import type { BlackBoxEntry } from '../models/focus';
import {
  ErrorCodes,
  failure,
  success,
  type OperationError,
  type Result,
} from '../utils/result';
import type { BlackBoxService } from './black-box.service';

type DeferredGateMutation =
  | { kind: 'mark-read'; entryId: string; ownerUserId: string | null }
  | { kind: 'mark-completed'; entryId: string; ownerUserId: string | null }
  | {
      kind: 'snooze';
      entryId: string;
      snoozeUntil: string;
      targetSnoozeCount?: number;
      ownerUserId: string | null;
    };

interface GateDeferredMutationLogger {
  warn(scope: string, message: string, data?: unknown): void;
}

export interface GateDeferredMutationControllerOptions {
  blackBoxService: Pick<
    BlackBoxService,
    'markAsReadDurably' | 'markAsCompletedDurably' | 'snoozeDurably'
  >;
  logger: GateDeferredMutationLogger;
  getOwnerUserId: () => string | null;
}

/**
 * 决策在 UI 确认（动画开始）到 settling 落库之间只存在于内存；
 * 移动端"处理完就划掉 app"会让进程在这个窗口内被杀，已读/完成/打盹
 * 决策无痕丢失（§5.6 Explainable）。持久暂存一份，下次 checkGate 补写。
 */
export const GATE_DEFERRED_MUTATION_STORAGE_KEY = 'nanoflow.gate.deferred-mutation.v1';

export class GateDeferredMutationController {
  private mutation: DeferredGateMutation | null = null;

  constructor(private readonly options: GateDeferredMutationControllerOptions) {}

  get hasPending(): boolean {
    return this.mutation !== null;
  }

  setMarkRead(entryId: string): void {
    this.mutation = { kind: 'mark-read', entryId, ownerUserId: this.getCurrentOwnerUserId() };
    this.persistPendingMutation();
  }

  setMarkCompleted(entryId: string): void {
    this.mutation = { kind: 'mark-completed', entryId, ownerUserId: this.getCurrentOwnerUserId() };
    this.persistPendingMutation();
  }

  setSnooze(entryId: string, snoozeUntil: string, targetSnoozeCount?: number): void {
    this.mutation = {
      kind: 'snooze',
      entryId,
      snoozeUntil,
      targetSnoozeCount,
      ownerUserId: this.getCurrentOwnerUserId(),
    };
    this.persistPendingMutation();
  }

  clear(): void {
    const mutationOwnerUserId = this.mutation?.ownerUserId ?? null;
    const currentOwnerUserId = this.getCurrentOwnerUserId();
    this.mutation = null;
    this.discardLegacyPersistedMutation();
    if (currentOwnerUserId !== null) {
      this.clearPersistedMutation(currentOwnerUserId);
    }
    if (mutationOwnerUserId !== null && mutationOwnerUserId === currentOwnerUserId) {
      this.clearPersistedMutation(mutationOwnerUserId);
    }
  }

  /**
   * 启动补写：上一会话在确认动画窗口内被杀时，决策仍在持久暂存里。
   * 补写一次；失败（条目不存在/本地持久化失败）则丢弃并告警——
   * 保留毒化暂存会让每次 checkGate 重复失败。无暂存时等价于 clear()。
   */
  async restorePersistedMutation(): Promise<void> {
    this.discardLegacyPersistedMutation();
    const ownerUserId = this.getCurrentOwnerUserId();
    const stored = ownerUserId === null ? null : this.readPersistedMutation(ownerUserId);
    if (!stored) {
      this.mutation = null;
      return;
    }

    this.mutation = stored;
    const result = await this.flush();
    if (!result.ok) {
      this.options.logger.warn('Gate', 'Restored deferred gate mutation could not be replayed; dropping', {
        kind: stored.kind,
        entryId: stored.entryId,
        message: result.error.message,
      });
      this.clear();
    }
  }

  private persistPendingMutation(): void {
    const mutation = this.mutation;
    if (typeof localStorage === 'undefined' || mutation?.ownerUserId == null) {
      return;
    }
    try {
      this.discardLegacyPersistedMutation();
      localStorage.setItem(this.getStorageKey(mutation.ownerUserId), JSON.stringify(mutation));
    } catch {
      // 暂存失败不阻断大门流程：退化为旧行为（决策仅存内存）
    }
  }

  private clearPersistedMutation(ownerUserId: string): void {
    if (typeof localStorage === 'undefined') {
      return;
    }
    try {
      localStorage.removeItem(this.getStorageKey(ownerUserId));
    } catch {
      // 清除失败留给下次补写路径按无效暂存处理
    }
  }

  private readPersistedMutation(ownerUserId: string): DeferredGateMutation | null {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    try {
      const storageKey = this.getStorageKey(ownerUserId);
      const raw = localStorage.getItem(storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<DeferredGateMutation>;
      if (
        typeof parsed?.entryId !== 'string'
        || parsed.entryId.length === 0
        || parsed.ownerUserId !== ownerUserId
        || (parsed.kind !== 'mark-read' && parsed.kind !== 'mark-completed' && parsed.kind !== 'snooze')
      ) {
        localStorage.removeItem(storageKey);
        return null;
      }
      if (parsed.kind === 'snooze') {
        const snoozeUntil = (parsed as { snoozeUntil?: unknown }).snoozeUntil;
        const targetSnoozeCount = (parsed as { targetSnoozeCount?: unknown }).targetSnoozeCount;
        if (typeof snoozeUntil !== 'string' || snoozeUntil.length === 0) {
          localStorage.removeItem(storageKey);
          return null;
        }
        if (targetSnoozeCount !== undefined
          && (typeof targetSnoozeCount !== 'number'
            || !Number.isSafeInteger(targetSnoozeCount)
            || targetSnoozeCount < 1)) {
          localStorage.removeItem(storageKey);
          return null;
        }
        return {
          kind: 'snooze',
          entryId: parsed.entryId,
          snoozeUntil,
          ...(typeof targetSnoozeCount === 'number' ? { targetSnoozeCount } : {}),
          ownerUserId,
        };
      }
      return { kind: parsed.kind, entryId: parsed.entryId, ownerUserId };
    } catch {
      // eslint-disable-next-line no-restricted-syntax -- 返回 null 语义正确：暂存解析失败按无有效延迟操作处理
      return null;
    }
  }

  async flush(): Promise<Result<BlackBoxEntry | null, OperationError>> {
    const mutation = this.mutation;
    if (!mutation) {
      return success(null);
    }

    if (mutation.ownerUserId === null || mutation.ownerUserId !== this.getCurrentOwnerUserId()) {
      return this.failOwnerChangedMutation(mutation, 'before');
    }
    let result: Result<BlackBoxEntry, OperationError>;
    try {
      if (mutation.kind === 'mark-read') {
        result = await this.options.blackBoxService.markAsReadDurably(mutation.entryId);
      } else if (mutation.kind === 'mark-completed') {
        result = await this.options.blackBoxService.markAsCompletedDurably(mutation.entryId);
      } else {
        result = await this.options.blackBoxService.snoozeDurably(
          mutation.entryId,
          mutation.snoozeUntil,
          mutation.targetSnoozeCount,
        );
      }
    } catch (error) {
      this.options.logger.warn('Gate', 'Deferred gate mutation threw', {
        kind: mutation.kind,
        entryId: mutation.entryId,
        message: error instanceof Error ? error.message : String(error),
      });
      return failure(ErrorCodes.OPERATION_FAILED, '大门延迟操作本地持久化失败', {
        kind: mutation.kind,
        entryId: mutation.entryId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!result.ok) {
      this.options.logger.warn('Gate', 'Deferred gate mutation failed', {
        kind: mutation.kind,
        entryId: mutation.entryId,
        message: result.error.message,
      });
      return result;
    }

    if (this.mutation !== mutation || mutation.ownerUserId !== this.getCurrentOwnerUserId()) {
      return this.failOwnerChangedMutation(mutation, 'during');
    }

    this.mutation = null;
    this.clearPersistedMutation(mutation.ownerUserId);
    return result;
  }

  private failOwnerChangedMutation(
    mutation: DeferredGateMutation,
    phase: 'before' | 'during',
  ): Result<BlackBoxEntry | null, OperationError> {
    if (this.mutation === mutation) {
      this.mutation = null;
    }
    const beforeFlush = phase === 'before';
    this.options.logger.warn('Gate', beforeFlush
      ? 'Deferred gate mutation owner changed before flush'
      : 'Deferred gate mutation owner changed during flush', {
      kind: mutation.kind,
      entryId: mutation.entryId,
      ownerUserId: mutation.ownerUserId,
    });
    return failure(
      ErrorCodes.OPERATION_FAILED,
      beforeFlush ? '大门延迟操作所属账号已切换' : '大门延迟操作完成时账号已切换',
    );
  }

  private getCurrentOwnerUserId(): string | null {
    const ownerUserId = this.options.getOwnerUserId()?.trim();
    return ownerUserId || null;
  }

  private getStorageKey(ownerUserId: string): string {
    return `${GATE_DEFERRED_MUTATION_STORAGE_KEY}.${encodeURIComponent(ownerUserId)}`;
  }

  private discardLegacyPersistedMutation(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      if (localStorage.getItem(GATE_DEFERRED_MUTATION_STORAGE_KEY) !== null) {
        localStorage.removeItem(GATE_DEFERRED_MUTATION_STORAGE_KEY);
        this.options.logger.warn('Gate', 'Dropped ownerless legacy deferred gate mutation');
      }
    } catch {
      // Legacy cleanup is best-effort; scoped state remains authoritative.
    }
  }
}
