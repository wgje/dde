/**
 * RetryQueue unknown-outcome（远端结果未知写入）对账辅助（§5.2 / §5.6）。
 *
 * 业务意图：推送 timeout/abort 后服务端可能已写入，直接重放会重复提交或在 REST CAS
 * 路径被误判成假版本冲突。重放前先对账：命中 → 按成功结算；未命中 → 清除标记正常重放；
 * 对账失败/无法判定 → 保持 unknown-outcome 状态整片延后（不消耗 retryCount、不得丢弃）。
 *
 * 从 retry-queue-runner.service.ts 下切（AGENTS §12 单文件 ≤ 800 行红线）。
 */
import type { CategoryLogger } from '../../../../services/logger.service';
import { isPermanentFailureError, PermanentFailureError } from '../../../../utils/permanent-failure-error';
import { createRetryQueueLastFailureFromUnknownError } from './retry-queue-failure-context';
import { classifyRetryQueueAuthBoundaryError } from './retry-queue-processing';
import type {
  RetryOperationHandler,
  RetryQueueItem,
  RetryQueueItemProcessResult,
  RetryQueueUnknownOutcomeReconcileResult,
} from './retry-queue.types';

export interface SettleOrDeferUnknownOutcomeOptions {
  item: RetryQueueItem;
  operationHandler: RetryOperationHandler;
  logger: CategoryLogger;
  warn: (message: string, data?: unknown) => void;
  isSettlementCurrent: () => boolean;
  /** 结算/延后统一走 runner 的 applyRetryAttemptResult，保持完成标记与预算语义一致 */
  applyRetryAttemptResult: (
    success: boolean,
    deferredByBrowserSuspension: boolean,
    serverPressure: boolean,
  ) => Promise<RetryQueueItemProcessResult>;
  persistQueueStateChange: () => Promise<boolean>;
  handleReconcileError: (error: unknown) => Promise<
    RetryQueueItemProcessResult | 'deferred-browser-suspension' | 'deferred-server-pressure' | 'retry-failed'
  >;
}

/**
 * unknown-outcome 项重放前对账；返回 null 表示继续正常重放路径
 * （项未标记、handler 无对账实现、或对账判定为 replay）。
 */
export async function settleOrDeferUnknownOutcomeRetryItem(
  options: SettleOrDeferUnknownOutcomeOptions,
): Promise<RetryQueueItemProcessResult | null> {
  const { item, operationHandler } = options;
  const reconcile = operationHandler.reconcileUnknownOutcome;
  if (item.lastFailure?.remoteOutcome !== 'unknown' || !reconcile) {
    return null;
  }

  let outcome: RetryQueueUnknownOutcomeReconcileResult;
  try {
    outcome = await reconcile.call(operationHandler, item);
  } catch (error) {
    if (shouldStopForStaleSettlement(options)) {
      return 'break';
    }
    if (shouldRouteReconcileError(error)) {
      return await routeReconcileError(options, error);
    }
    options.warn('unknown-outcome 对账查询异常，保持结果未知状态等待下一轮', {
      ...buildLogContext(item),
      error: error instanceof Error ? error.message : String(error),
    });
    return 'continue';
  }
  if (shouldStopForStaleSettlement(options)) {
    return 'break';
  }
  if (outcome === 'settled') {
    options.logger.info('unknown-outcome 对账命中：服务端已包含本次写入，跳过重放直接结算', buildLogContext(item));
    return await options.applyRetryAttemptResult(true, false, false);
  }
  if (outcome === 'unknown') {
    options.logger.info('unknown-outcome 对账未得出结论，保留队列项与 retryCount 等待下一轮', buildLogContext(item));
    return 'continue';
  }

  // 对账未命中：结果未知状态已解除，清除标记后按正常失败语义重放
  if (item.lastFailure) {
    const previousFailure = item.lastFailure;
    delete item.lastFailure;
    if (!await options.persistQueueStateChange()) {
      item.lastFailure = previousFailure;
      options.warn('unknown-outcome 标记清除未能持久化，保留队列项等待下一轮', buildLogContext(item));
      return 'break';
    }
  }
  return null;
}

function shouldStopForStaleSettlement(options: SettleOrDeferUnknownOutcomeOptions): boolean {
  if (options.isSettlementCurrent()) {
    return false;
  }
  options.warn('owner/session 已切换，忽略旧 RetryQueue 切片的晚到对账结果并保留 unknown marker',
    buildLogContext(options.item));
  return true;
}

function shouldRouteReconcileError(error: unknown): boolean {
  return isPermanentFailureError(error)
    || classifyRetryQueueAuthBoundaryError(error).kind === 'pause'
    || (error as { isRetryable?: unknown } | null)?.isRetryable === false;
}

async function routeReconcileError(
  options: SettleOrDeferUnknownOutcomeOptions,
  error: unknown,
): Promise<RetryQueueItemProcessResult> {
  const routedError = isPermanentFailureError(error)
    || classifyRetryQueueAuthBoundaryError(error).kind === 'pause'
    ? error
    : new PermanentFailureError(
      'Unknown-outcome reconciliation failed permanently',
      error instanceof Error ? error : new Error(String(error)),
      buildLogContext(options.item),
    );
  const result = await options.handleReconcileError(routedError);
  if (result === 'continue' || result === 'break') {
    return result;
  }
  return await options.applyRetryAttemptResult(
    false,
    result === 'deferred-browser-suspension',
    result === 'deferred-server-pressure',
  );
}

function buildLogContext(item: RetryQueueItem): Record<string, unknown> {
  return { type: item.type, id: item.data.id, operationId: item.operationId };
}

/** 重放失败若属「远端结果未知」类（timeout/abort），回写标记供下一轮对账。 */
export async function markRetryQueueItemUnknownOutcome(
  item: RetryQueueItem,
  error: unknown,
  persistQueueStateChange: () => Promise<boolean>,
): Promise<boolean> {
  const lastFailure = createRetryQueueLastFailureFromUnknownError(error);
  if (!lastFailure) {
    return true;
  }
  item.lastFailure = lastFailure;
  return await persistQueueStateChange();
}
