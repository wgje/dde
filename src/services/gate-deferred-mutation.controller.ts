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
  | { kind: 'mark-read'; entryId: string }
  | { kind: 'mark-completed'; entryId: string }
  | { kind: 'snooze'; entryId: string; snoozeUntil: string };

interface GateDeferredMutationLogger {
  warn(scope: string, message: string, data?: unknown): void;
}

export interface GateDeferredMutationControllerOptions {
  blackBoxService: Pick<
    BlackBoxService,
    'markAsReadDurably' | 'markAsCompletedDurably' | 'snoozeDurably'
  >;
  logger: GateDeferredMutationLogger;
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
    this.mutation = { kind: 'mark-read', entryId };
    this.persistPendingMutation();
  }

  setMarkCompleted(entryId: string): void {
    this.mutation = { kind: 'mark-completed', entryId };
    this.persistPendingMutation();
  }

  setSnooze(entryId: string, snoozeUntil: string): void {
    this.mutation = { kind: 'snooze', entryId, snoozeUntil };
    this.persistPendingMutation();
  }

  clear(): void {
    this.mutation = null;
    this.clearPersistedMutation();
  }

  /**
   * 启动补写：上一会话在确认动画窗口内被杀时，决策仍在持久暂存里。
   * 补写一次；失败（条目不存在/本地持久化失败）则丢弃并告警——
   * 保留毒化暂存会让每次 checkGate 重复失败。无暂存时等价于 clear()。
   */
  async restorePersistedMutation(): Promise<void> {
    const stored = this.readPersistedMutation();
    if (!stored) {
      this.clear();
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
    if (typeof localStorage === 'undefined' || this.mutation === null) {
      return;
    }
    try {
      localStorage.setItem(GATE_DEFERRED_MUTATION_STORAGE_KEY, JSON.stringify(this.mutation));
    } catch {
      // 暂存失败不阻断大门流程：退化为旧行为（决策仅存内存）
    }
  }

  private clearPersistedMutation(): void {
    if (typeof localStorage === 'undefined') {
      return;
    }
    try {
      localStorage.removeItem(GATE_DEFERRED_MUTATION_STORAGE_KEY);
    } catch {
      // 清除失败留给下次补写路径按无效暂存处理
    }
  }

  private readPersistedMutation(): DeferredGateMutation | null {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    try {
      const raw = localStorage.getItem(GATE_DEFERRED_MUTATION_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<DeferredGateMutation>;
      if (
        typeof parsed?.entryId !== 'string'
        || parsed.entryId.length === 0
        || (parsed.kind !== 'mark-read' && parsed.kind !== 'mark-completed' && parsed.kind !== 'snooze')
      ) {
        return null;
      }
      if (parsed.kind === 'snooze') {
        const snoozeUntil = (parsed as { snoozeUntil?: unknown }).snoozeUntil;
        if (typeof snoozeUntil !== 'string' || snoozeUntil.length === 0) return null;
        return { kind: 'snooze', entryId: parsed.entryId, snoozeUntil };
      }
      return { kind: parsed.kind, entryId: parsed.entryId };
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

    let result: Result<BlackBoxEntry, OperationError>;

    try {
      if (mutation.kind === 'mark-read') {
        result = await this.options.blackBoxService.markAsReadDurably(mutation.entryId);
      } else if (mutation.kind === 'mark-completed') {
        result = await this.options.blackBoxService.markAsCompletedDurably(mutation.entryId);
      } else {
        result = await this.options.blackBoxService.snoozeDurably(mutation.entryId, mutation.snoozeUntil);
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

    this.mutation = null;
    this.clearPersistedMutation();
    return result;
  }
}
