/**
 * ActionQueueStorageService 的「重试错误序列化 / 延后重试分类」纯函数模块。
 *
 * 从 ActionQueueStorageService「下切」出的无状态工具：在 QueueRetryError 与字符串消息之间
 * 互转，并对「应延后而非失败」的错误分类、计算延后间隔。全部纯函数（无 `this`、无副作用）。
 *
 * - normalizeRetryError / parseRetryErrorMessage / formatRetryError：QueueRetryError <-> "CODE | message"
 * - isBrowserSuspensionError / isPartialRetryHandoffError / isAuthPendingRetryError：延后类错误识别
 * - resolveDeferredRetryDelay / resolveBrowserSuspensionDelay：延后重试间隔计算
 * - describeDeferredRetryReason：延后原因归类（用于日志/观测）
 *
 * 为什么抽离：AGENTS.md §12 单文件 ≤ 800 行硬线；ActionQueueStorageService 长期越界，
 * 这些纯序列化/分类工具自洽且零依赖服务态，适合先行下切。
 */
import { QUEUE_CONFIG } from '../config';
import { getRemainingBrowserNetworkResumeDelayMs } from '../utils/browser-network-suspension';
import type { QueueRetryError } from './action-queue-storage.service';

export type DeferredRetryReason =
  | 'browser-network-suspended'
  | 'partial-retry-handoff'
  | 'auth-pending'
  | 'rate-limit'
  | 'sync-rpc-unavailable';

export function parseRetryErrorMessage(message: string): QueueRetryError {
  const parts = message.split('|').map(part => part.trim()).filter(part => part.length > 0);
  const firstPart = parts[0] ?? '';
  const looksLikeErrorCode = /^[A-Z0-9_]+$/.test(firstPart);

  if (!looksLikeErrorCode) {
    return { message };
  }

  return {
    code: firstPart,
    message: parts.slice(1).join(' | ') || message,
  };
}

export function normalizeRetryError(error: string | QueueRetryError): QueueRetryError {
  if (typeof error === 'string') {
    return parseRetryErrorMessage(error);
  }

  const message = typeof error.message === 'string' ? error.message : String(error.message ?? '');
  const parsed = parseRetryErrorMessage(message);
  return {
    code: typeof error.code === 'string' ? error.code : parsed.code,
    message: parsed.message,
    details: error.details && typeof error.details === 'object'
      ? error.details
      : undefined,
  };
}

export function formatRetryError(error: QueueRetryError): string {
  return [error.code, error.message].filter((part): part is string => typeof part === 'string' && part.length > 0).join(' | ');
}

export function isBrowserSuspensionError(error: QueueRetryError): boolean {
  if (error.details?.['reason'] === 'browser-network-suspended') {
    return true;
  }

  const msg = `${error.code ?? ''} ${error.message}`.toLowerCase();
  return msg.includes('browser-network-suspended')
    || msg.includes('browsernetworksuspendederror')
    || msg.includes('network io suspended')
    || (error.code === 'SYNC_OFFLINE' && error.message.includes('浏览器恢复连接中'))
    || msg.includes('resuming connection');
}

export function isPartialRetryHandoffError(error: QueueRetryError): boolean {
  return error.details?.['reason'] === 'partial-retry-handoff'
    || error.code === 'SYNC_RETRY_HANDOFF_PENDING';
}

export function isAuthPendingRetryError(error: QueueRetryError): boolean {
  if (error.details?.['reason'] === 'auth-pending'
    || error.code === 'SYNC_AUTH_PENDING'
    || error.code === 'SYNC_AUTH_EXPIRED') {
    return true;
  }

  const msg = `${error.code ?? ''} ${error.message}`.toLowerCase();
  return msg.includes('sync_auth_expired')
    || msg.includes('登录已过期')
    || msg.includes('token expired')
    || msg.includes('jwt expired')
    || msg.includes('session expired');
}

export function isRateLimitRetryError(error: QueueRetryError): boolean {
  if (error.details?.['reason'] === 'rate-limit') {
    return true;
  }

  const status = error.details?.['status'] ?? error.details?.['statusCode'] ?? error.details?.['httpStatus'];
  if (status === 429 || status === '429') {
    return true;
  }

  const msg = `${error.code ?? ''} ${error.message}`.toLowerCase();
  return msg.includes('429')
    || msg.includes('too many requests')
    || msg.includes('rate limit')
    || msg.includes('rate-limit')
    || msg.includes('ratelimit')
    || msg.includes('限流')
    || msg.includes('请求过多');
}

export function isSyncRpcCapabilityRetryError(error: QueueRetryError): boolean {
  return error.details?.['reason'] === 'sync-rpc-unavailable'
    && error.details?.['deferred'] === true
    && error.details?.['retryable'] === true;
}

export function resolveBrowserSuspensionDelay(error?: QueueRetryError): number {
  const requestedDelay = error?.details?.['resumeDelayMs'];
  if (typeof requestedDelay === 'number' && Number.isFinite(requestedDelay)) {
    return Math.max(0, requestedDelay);
  }

  return Math.max(100, getRemainingBrowserNetworkResumeDelayMs() + 50);
}

function resolveRateLimitRetryDelay(error: QueueRetryError): number {
  const retryAfterMs = error.details?.['retryAfterMs'];
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)) {
    return Math.max(0, retryAfterMs);
  }

  const retryAfterSeconds = error.details?.['retryAfterSeconds'];
  if (typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds)) {
    return Math.max(0, retryAfterSeconds * 1000);
  }

  const retryAfter = error.details?.['retryAfter'];
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
    return Math.max(0, retryAfter * 1000);
  }

  if (typeof retryAfter === 'string') {
    const retryAfterNumber = Number(retryAfter);
    if (Number.isFinite(retryAfterNumber)) {
      return Math.max(0, retryAfterNumber * 1000);
    }

    const retryAfterDate = Date.parse(retryAfter);
    if (Number.isFinite(retryAfterDate)) {
      return Math.max(0, retryAfterDate - Date.now());
    }
  }

  return QUEUE_CONFIG.RETRY_BASE_DELAY;
}

export function resolveDeferredRetryDelay(error: QueueRetryError): number {
  if (isRateLimitRetryError(error)) {
    return resolveRateLimitRetryDelay(error);
  }

  if (isSyncRpcCapabilityRetryError(error)) {
    return QUEUE_CONFIG.RETRY_BASE_DELAY;
  }

  if (isPartialRetryHandoffError(error)) {
    const requestedDelay = error.details?.['retryAfterMs'];
    if (typeof requestedDelay === 'number' && Number.isFinite(requestedDelay)) {
      return Math.max(0, requestedDelay);
    }

    return QUEUE_CONFIG.RETRY_BASE_DELAY;
  }

  // auth 认证过渡期使用固定基础间隔，避免降级到浏览器挂起延迟计算产生 100ms 快速重试噪声
  if (isAuthPendingRetryError(error)) {
    return QUEUE_CONFIG.RETRY_BASE_DELAY;
  }

  return resolveBrowserSuspensionDelay(error);
}

export function describeDeferredRetryReason(
  error: QueueRetryError,
): DeferredRetryReason {
  if (isRateLimitRetryError(error)) {
    return 'rate-limit';
  }

  if (isSyncRpcCapabilityRetryError(error)) {
    return 'sync-rpc-unavailable';
  }

  if (isPartialRetryHandoffError(error)) {
    return 'partial-retry-handoff';
  }

  if (isAuthPendingRetryError(error)) {
    return 'auth-pending';
  }

  return 'browser-network-suspended';
}
