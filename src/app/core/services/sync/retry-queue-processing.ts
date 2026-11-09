import { isValidUUID } from '../../../../utils/validation';
import { supabaseErrorToError } from '../../../../utils/supabase-error';

export type RetryQueueBlockReason =
  | 'already-processing'
  | 'empty'
  | 'missing-handler'
  | 'offline-or-circuit-open'
  | 'session-expired';

export interface RetryQueueProcessGate {
  isProcessing: boolean;
  queueLength: number;
  hasHandler: boolean;
  isOnline: boolean;
  sessionExpired: boolean;
  circuitBreakerReady: boolean;
}

export type RetryQueueProcessDecision =
  | { allowed: true }
  | { allowed: false; reason: RetryQueueBlockReason };

export interface RetryQueueSliceBudgetInput {
  maxItems?: number;
  maxDurationMs?: number;
}

export interface RetryQueueSliceBudget {
  maxItems: number;
  maxDurationMs: number;
}

export type RetryQueueAuthBoundaryPauseReason =
  | 'auth-session-boundary'
  | 'auth-client-unready';

export type RetryQueueAuthBoundaryDecision =
  | { kind: 'process' }
  | { kind: 'pause'; reason: RetryQueueAuthBoundaryPauseReason };

const AUTH_SESSION_BOUNDARY_ERROR_TYPES = new Set([
  'AuthError',
  'AuthRefreshDiscardedError',
]);

const AUTH_CLIENT_UNREADY_ERROR_TYPES = new Set([
  'AuthRetryableFetchError',
]);

const SERVER_PRESSURE_ERROR_TYPES = new Set([
  'RateLimitError',
  'ServiceUnavailableError',
  'GatewayError',
  'NetworkTimeoutError',
  'UnknownServerError',
  'HtmlResponseError',
  // 弱网基础设施失败：挂起型客户端超时与断网/门户劫持不是业务失败，
  // 回放层必须整片延后（不消耗 retryCount），否则 flap 数轮即把队列项烧进隔离区
  'TimeoutError',
  'RequestTimeoutError',
  'NetworkError',
  'OfflineError',
]);

function isUnauthorizedStatus(value: unknown): boolean {
  return value === 401 || value === '401';
}

function normalizeStatusCode(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }

  return null;
}

function readStatusCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const candidate = error as {
    status?: unknown;
    code?: unknown;
    error?: { status?: unknown; code?: unknown } | null;
  };
  return normalizeStatusCode(candidate.status)
    ?? normalizeStatusCode(candidate.code)
    ?? normalizeStatusCode(candidate.error?.status)
    ?? normalizeStatusCode(candidate.error?.code);
}

function isServerPressureStatus(status: number | null): boolean {
  return status === 429 || (status !== null && status >= 500 && status <= 599);
}

export function classifyRetryQueueAuthBoundaryError(error: unknown): RetryQueueAuthBoundaryDecision {
  if (!error) {
    return { kind: 'process' };
  }

  const enhanced = supabaseErrorToError(error);
  const errorType = enhanced.errorType || enhanced.name;
  if (AUTH_CLIENT_UNREADY_ERROR_TYPES.has(errorType)) {
    return { kind: 'pause', reason: 'auth-client-unready' };
  }

  if (
    AUTH_SESSION_BOUNDARY_ERROR_TYPES.has(errorType) ||
    isUnauthorizedStatus(enhanced.code) ||
    isUnauthorizedStatus(enhanced.status)
  ) {
    return { kind: 'pause', reason: 'auth-session-boundary' };
  }

  return { kind: 'process' };
}

export function isRetryQueueServerPressureError(error: unknown): boolean {
  if (!error || (typeof error !== 'object' && !(error instanceof Error))) {
    return false;
  }

  // 推送层 rethrow 的已增强错误直接按原始 errorType 判定，
  // 避免 supabaseErrorToError 二次包装丢失分类
  const rawErrorType = (error as { errorType?: unknown }).errorType;
  if (typeof rawErrorType === 'string' && SERVER_PRESSURE_ERROR_TYPES.has(rawErrorType)) {
    return true;
  }

  if (isServerPressureStatus(readStatusCode(error))) {
    return true;
  }

  const enhanced = supabaseErrorToError(error);
  if (isServerPressureStatus(readStatusCode(enhanced))) {
    return true;
  }

  return SERVER_PRESSURE_ERROR_TYPES.has(enhanced.errorType)
    || SERVER_PRESSURE_ERROR_TYPES.has(enhanced.name);
}

export function normalizeRetryQueueSliceBudget(
  input: RetryQueueSliceBudgetInput,
): RetryQueueSliceBudget {
  return {
    maxItems: typeof input.maxItems === 'number' && input.maxItems > 0
      ? input.maxItems
      : Number.POSITIVE_INFINITY,
    maxDurationMs: typeof input.maxDurationMs === 'number' && input.maxDurationMs > 0
      ? input.maxDurationMs
      : Number.POSITIVE_INFINITY,
  };
}

export function shouldProcessRetryQueue(gate: RetryQueueProcessGate): RetryQueueProcessDecision {
  if (!gate.isOnline || !gate.circuitBreakerReady) {
    return { allowed: false, reason: 'offline-or-circuit-open' };
  }

  if (gate.isProcessing) {
    return { allowed: false, reason: 'already-processing' };
  }

  if (gate.queueLength === 0) {
    return { allowed: false, reason: 'empty' };
  }

  if (!gate.hasHandler) {
    return { allowed: false, reason: 'missing-handler' };
  }

  if (gate.sessionExpired) {
    return { allowed: false, reason: 'session-expired' };
  }

  return { allowed: true };
}

export interface StaleProcessingLockInput {
  isProcessing: boolean;
  lastProcessTime: number;
  now: number;
  timeoutMs: number;
}

export function shouldRecoverStaleProcessingLock(input: StaleProcessingLockInput): boolean {
  return input.isProcessing
    && input.lastProcessTime > 0
    && input.now - input.lastProcessTime > input.timeoutMs;
}

export interface RetryAttemptInput {
  success: boolean;
  retryCount: number;
  maxRetries: number;
  terminalFailure: boolean;
  deferredByBrowserSuspension: boolean;
  browserSuspendedNow: boolean;
  serverPressure?: boolean;
}

export type RetryAttemptClassification =
  | { kind: 'success' }
  | { kind: 'deferred-browser-suspension' }
  | { kind: 'deferred-server-pressure' }
  | { kind: 'terminal' }
  | { kind: 'retry-exhausted'; nextRetryCount: number }
  | { kind: 'retryable'; nextRetryCount: number };

export function classifyRetryAttempt(input: RetryAttemptInput): RetryAttemptClassification {
  if (input.success) {
    return { kind: 'success' };
  }

  if (input.deferredByBrowserSuspension || input.browserSuspendedNow) {
    return { kind: 'deferred-browser-suspension' };
  }

  if (input.serverPressure) {
    return { kind: 'deferred-server-pressure' };
  }

  if (input.terminalFailure) {
    return { kind: 'terminal' };
  }

  const nextRetryCount = input.retryCount + 1;
  if (nextRetryCount >= input.maxRetries) {
    return { kind: 'retry-exhausted', nextRetryCount };
  }

  return { kind: 'retryable', nextRetryCount };
}

export type RetryQueuePreflightEntityType = 'task' | 'project' | 'connection' | 'blackbox';
export type RetryQueuePreflightOperation = 'upsert' | 'delete';

export interface RetryQueuePreflightItem {
  id: string;
  type: RetryQueuePreflightEntityType;
  operation: RetryQueuePreflightOperation;
  data?: {
    id?: unknown;
    updatedAt?: unknown;
  } | null;
  projectId?: string;
  sourceUserId?: string;
  writeIntent?: string;
}

export type RetryQueueItemTerminalReason =
  | 'missing-project-id'
  | 'invalid-data-id'
  | 'task-upsert-missing-updated-at'
  | 'drop-legacy-local-user'
  | 'drop-legacy-missing-source-user';

export type RetryQueueItemPreflightDecision =
  | { kind: 'process' }
  | { kind: 'missing-from-queue' }
  | { kind: 'remove-terminal'; reason: RetryQueueItemTerminalReason }
  | { kind: 'quarantine'; reason: string };

export interface RetryQueueItemPreflightInput {
  item: RetryQueuePreflightItem;
  existsInQueue: boolean;
  currentUserId?: string | null;
  localModeUserId: string;
  shouldSilentlyDropUnownedLegacyItem: boolean;
}

function isTaskUpsertMissingUpdatedAt(item: RetryQueuePreflightItem): boolean {
  if (item.type !== 'task' || item.operation !== 'upsert') {
    return false;
  }

  const updatedAt = item.data?.updatedAt;
  return typeof updatedAt !== 'string' || updatedAt.trim().length === 0;
}

function isTaskUpsertMissingWriteIntent(item: RetryQueuePreflightItem): boolean {
  return item.type === 'task'
    && item.operation === 'upsert'
    && (typeof item.writeIntent !== 'string' || item.writeIntent.trim().length === 0);
}

function classifyRetryQueueItemOwnerBoundary(
  input: RetryQueueItemPreflightInput,
): RetryQueueItemPreflightDecision | null {
  const { item } = input;
  if (item.sourceUserId === input.localModeUserId) {
    if (input.shouldSilentlyDropUnownedLegacyItem) {
      return { kind: 'remove-terminal', reason: 'drop-legacy-local-user' };
    }

    return { kind: 'quarantine', reason: 'legacy local-user 重试项禁止自动上云' };
  }

  if (item.sourceUserId && input.currentUserId && item.sourceUserId !== input.currentUserId) {
    return {
      kind: 'quarantine',
      reason: `跨账号重试项来源 ${item.sourceUserId} 与当前账号 ${input.currentUserId} 不匹配`,
    };
  }

  if (!item.sourceUserId) {
    if (input.shouldSilentlyDropUnownedLegacyItem) {
      return { kind: 'remove-terminal', reason: 'drop-legacy-missing-source-user' };
    }

    return { kind: 'quarantine', reason: 'legacy 重试项缺少来源元数据，无法安全判断归属' };
  }

  return null;
}

export function classifyRetryQueueItemPreflight(
  input: RetryQueueItemPreflightInput,
): RetryQueueItemPreflightDecision {
  const { item } = input;

  if (!input.existsInQueue) {
    return { kind: 'missing-from-queue' };
  }

  if ((item.type === 'task' || item.type === 'connection') && !item.projectId) {
    return { kind: 'remove-terminal', reason: 'missing-project-id' };
  }

  const dataId = item.data?.id;
  const requiresUuidEntityId = item.type === 'task' || item.type === 'connection' || item.type === 'blackbox';
  if (
    requiresUuidEntityId &&
    (
      typeof dataId !== 'string' ||
      dataId.length === 0 ||
      !isValidUUID(dataId)
    )
  ) {
    return { kind: 'remove-terminal', reason: 'invalid-data-id' };
  }

  if (isTaskUpsertMissingUpdatedAt(item)) {
    return { kind: 'remove-terminal', reason: 'task-upsert-missing-updated-at' };
  }

  const ownerBoundaryDecision = classifyRetryQueueItemOwnerBoundary(input);
  if (ownerBoundaryDecision) return ownerBoundaryDecision;

  if (isTaskUpsertMissingWriteIntent(item)) {
    return {
      kind: 'quarantine',
      reason: 'legacy task upsert 缺少 writeIntent，禁止猜测为 full upsert',
    };
  }

  return { kind: 'process' };
}
