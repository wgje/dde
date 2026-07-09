/**
 * ActionQueue storage 的无状态配置与纯函数。
 *
 * 这些工具不依赖 Angular DI，供存储主服务与 owner-scoped 持久化协作服务复用。
 */
import { QUEUE_CONFIG } from '../config';
import type { DeadLetterItem, QueuedAction } from './action-queue.types';
import {
  isAuthPendingRetryError as isAuthPendingRetryErrorPure,
  isBrowserSuspensionError as isBrowserSuspensionErrorPure,
  isPartialRetryHandoffError as isPartialRetryHandoffErrorPure,
  isRateLimitRetryError as isRateLimitRetryErrorPure,
  isSyncRpcCapabilityRetryError as isSyncRpcCapabilityRetryErrorPure,
  normalizeRetryError as normalizeRetryErrorPure,
} from './action-queue-retry-serialization';

/**
 * 操作队列本地配置
 */
export const LOCAL_QUEUE_CONFIG = {
  /** 最大重试次数 */
  MAX_RETRIES: 5,
  /** 重试延迟基数（毫秒） */
  RETRY_BASE_DELAY: QUEUE_CONFIG.RETRY_BASE_DELAY,
  /** 队列存储键 */
  QUEUE_STORAGE_KEY: 'nanoflow.action-queue',
  /** 死信队列存储键 */
  DEAD_LETTER_STORAGE_KEY: 'nanoflow.dead-letter-queue',
  /** 最大队列大小 */
  MAX_QUEUE_SIZE: 100,
  /** 死信队列最大大小 */
  MAX_DEAD_LETTER_SIZE: 50,
  /** 死信队列条目最大存活时间（毫秒）- 24小时 */
  DEAD_LETTER_TTL: 24 * 60 * 60 * 1000,
  /** 无处理器操作超时（毫秒）- 5分钟后移入死信队列 */
  NO_PROCESSOR_TIMEOUT: QUEUE_CONFIG.NO_PROCESSOR_TIMEOUT,
  /** 业务错误模式（这些错误不需要重试） */
  BUSINESS_ERROR_PATTERNS: [
    'not found',
    'permission denied',
    'unauthorized',
    'forbidden',
    'row level security',
    'rls',
    'violates',
    'duplicate key',
    'unique constraint',
    'foreign key',
    'invalid input',
    'invalid sync operationid',
    'invalid sync operation id',
  ],
  /** 关键操作失败通知阈值 */
  CRITICAL_FAILURE_NOTIFY_THRESHOLD: 3,
  /** 低优先级队列最大大小 */
  LOW_PRIORITY_MAX_SIZE: 20,
} as const;

export interface QueueRetryError {
  code?: string;
  message: string;
  details?: Record<string, unknown>;
}

export type QueueRetryErrorClassification =
  | 'network'
  | 'timeout'
  | 'permission'
  | 'business'
  | 'deferred'
  | 'unknown';

export type LegacyQueueSource = 'legacy-global-queue' | 'legacy-idb-backup';

export interface LegacyActionReviewItem {
  action: QueuedAction;
  source: LegacyQueueSource;
  capturedAt: string;
  ownerUserId: string;
}

export const LEGACY_UNKNOWN_OWNER_USER_ID = '__legacy_unknown__';

const QUEUE_RETRY_ERROR_KEYWORDS: ReadonlyArray<{
  type: Exclude<QueueRetryErrorClassification, 'business' | 'deferred' | 'unknown'>;
  keywords: readonly string[];
}> = [
  {
    type: 'network',
    keywords: [
      'network',
      'failed to fetch',
      'networkerror',
      'connection',
      'offline',
      'browsernetworksuspendederror',
      'network io suspended',
      '离线',
      '网络',
    ],
  },
  {
    type: 'timeout',
    keywords: ['timeout', 'timed out', 'deadline exceeded', '超时'],
  },
  {
    type: 'permission',
    keywords: [
      'permission',
      'unauthorized',
      'forbidden',
      '401',
      '403',
      'jwt',
      'token',
      'policy',
      '42501',
      'autherror',
      'expired',
      '权限不足',
      '登录已过期',
      '未授权',
      '重新登录',
    ],
  },
];

function includesAnyKeyword(message: string, keywords: readonly string[]): boolean {
  return keywords.some(keyword => message.includes(keyword));
}

export function classifyQueueRetryError(error: string | QueueRetryError): QueueRetryErrorClassification {
  const normalizedError = normalizeRetryErrorPure(error);
  if (
    isBrowserSuspensionErrorPure(normalizedError)
    || isPartialRetryHandoffErrorPure(normalizedError)
    || isAuthPendingRetryErrorPure(normalizedError)
    || isRateLimitRetryErrorPure(normalizedError)
    || isSyncRpcCapabilityRetryErrorPure(normalizedError)
  ) {
    return 'deferred';
  }

  const message = normalizedError.message.toLowerCase();
  const keywordRule = QUEUE_RETRY_ERROR_KEYWORDS.find(rule => includesAnyKeyword(message, rule.keywords));
  if (keywordRule) {
    return keywordRule.type;
  }

  return LOCAL_QUEUE_CONFIG.BUSINESS_ERROR_PATTERNS
    .some(pattern => message.includes(pattern.toLowerCase()))
    ? 'business'
    : 'unknown';
}

export function resolveQueueRetryDelay(
  errorType: QueueRetryErrorClassification,
  retryCount: number,
): number {
  if (errorType === 'network') {
    return Math.min(QUEUE_CONFIG.RETRY_BASE_DELAY * (retryCount + 1), 5000);
  }

  if (errorType === 'timeout') {
    return QUEUE_CONFIG.RETRY_BASE_DELAY * Math.pow(1.5, retryCount);
  }

  return QUEUE_CONFIG.RETRY_BASE_DELAY * Math.pow(2, retryCount);
}

export function buildFailedOwnerDeadLetterReason(
  errorType: QueueRetryErrorClassification,
  errorMessage: string,
): string {
  if (errorType === 'business' || errorType === 'permission') {
    return `${errorType === 'business' ? '业务' : '权限'}错误: ${errorMessage}`;
  }

  return `超过最大重试次数 (${LOCAL_QUEUE_CONFIG.MAX_RETRIES}): ${errorMessage}`;
}

export function appendCappedDeadLetterItem(
  queue: DeadLetterItem[],
  item: DeadLetterItem,
): { queue: DeadLetterItem[]; overflow: number } {
  const updated = [...queue, item];
  const overflow = Math.max(0, updated.length - LOCAL_QUEUE_CONFIG.MAX_DEAD_LETTER_SIZE);
  return {
    queue: overflow > 0 ? updated.slice(overflow) : updated,
    overflow,
  };
}

export function getActionDescription(action: QueuedAction): string {
  const typeMap: Record<string, string> = { create: '创建', update: '更新', delete: '删除' };
  const entityMap: Record<string, string> = {
    project: '项目',
    task: '任务',
    connection: '连接',
    preference: '设置',
    'focus-session': '专注会话',
    'routine-task': '日常任务',
    'routine-completion': '日常计数',
  };
  return `${typeMap[action.type] || action.type}${entityMap[action.entityType] || action.entityType}`;
}

export function getActionLabel(action: QueuedAction): string {
  const typeLabels: Record<string, string> = { create: '创建', update: '更新', delete: '删除' };
  const entityLabels: Record<string, string> = {
    project: '项目',
    task: '任务',
    connection: '连接',
    preference: '偏好设置',
    'focus-session': '专注会话',
    'routine-task': '日常任务',
    'routine-completion': '日常计数',
  };
  return `${typeLabels[action.type]}${entityLabels[action.entityType]}`;
}
