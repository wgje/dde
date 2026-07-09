/**
 * Supabase 错误处理工具
 * 
 * 统一处理 Supabase 错误，提供友好的错误消息和错误分类
 */

import { isBrowserNetworkSuspendedError } from './browser-network-suspension';

/**
 * 增强的错误类型
 */
export interface EnhancedError extends Error {
  code?: string | number;
  status?: string | number;
  statusText?: string;
  details?: string;
  hint?: string;
  isRetryable: boolean;
  errorType: string;
  /**
   * The remote write may have reached the server but the client did not observe
   * the result. Retry paths must preserve operationId/CAS and reconcile instead
   * of treating this as a definitely failed write.
   */
  remoteOutcome?: 'unknown';
}

/**
 * Supabase 错误类型别名（用于类型兼容）
 */
export type SupabaseError = EnhancedError;

/**
 * Supabase 客户端访问失败分类（用于同步链路可观测）
 */
export type SupabaseClientFailureCategory = 'offline' | 'not_configured' | 'runtime_failure';

export interface SupabaseClientFailureInfo {
  category: SupabaseClientFailureCategory;
  message: string;
  retryable: boolean;
}

interface SupabaseErrorShape {
  code?: string | number;
  status?: string | number;
  statusText?: string;
  name?: string;
  message?: string;
  details?: string;
  hint?: string;
  error?: SupabaseErrorShape | null;
}

interface SupabaseErrorClassification {
  message?: string;
  errorType: string;
  remoteOutcome?: 'unknown';
}

/**
 * 可重试的错误类型
 */
const RETRYABLE_ERROR_TYPES = new Set([
  'NetworkTimeoutError',
  'ServiceUnavailableError',
  'GatewayError',
  'RequestTimeoutError',
  'TimeoutError',
  'NetworkError',
  'OfflineError',
  'BrowserNetworkSuspendedError',
  'AuthRetryableFetchError',
  'RateLimitError',  // 429 速率限制错误应该重试
  'UnknownServerError',  // 504 等服务端错误返回非 JSON 响应时的回退类型
  'HtmlResponseError',  // 【#95057880】CDN/代理返回 HTML 替代 JSON，临时网络/缓存问题
  // 【关键修复】外键约束错误不可重试（意味着引用的数据不存在）
  // 'ForeignKeyError', // 23503 已移除
]);

const UNKNOWN_REMOTE_OUTCOME_ERROR_TYPES = new Set([
  'NetworkTimeoutError',
  'RequestTimeoutError',
  'TimeoutError',
]);

function enhanceNativeError(error: Error): EnhancedError {
  // 【P2-10 修复】创建新 Error 而非直接修改原始 Error
  const enhanced = Object.create(error) as EnhancedError;
  Object.assign(enhanced, { message: error.message, name: error.name, stack: error.stack });

  return enhanced;
}

function classifyNativeErrorMessage(error: Error): SupabaseErrorClassification | null {
  if (isBrowserNetworkSuspendedError(error)) {
    return { message: error.message, errorType: 'BrowserNetworkSuspendedError' };
  }

  const lowerMsg = error.message.toLowerCase();

  // 【#95057880 修复】识别 HTML 响应错误
  // 当 CDN/代理返回 HTML 页面（如 index.html）替代 JSON 时，Supabase SDK 解析失败
  if (lowerMsg.includes('<!doctype') || lowerMsg.includes('<html') || lowerMsg.includes('unexpected token <')) {
    return { message: error.message, errorType: 'HtmlResponseError' };
  }

  if (lowerMsg.includes('failed to fetch') || lowerMsg.includes('network error') || lowerMsg.includes('networkerror')) {
    return { message: error.message, errorType: 'NetworkError' };
  }

  if (lowerMsg.includes('timeout') || lowerMsg.includes('timed out') || lowerMsg.includes('超时')) {
    // 【2026-05-16】中文 '超时' 防御层
    // RequestThrottleService.withTimeout 历史上抛 message 含中文的 Error，现已在源头修复
    // name='TimeoutError'，此处保留作为其他中文超时错误源的兜底。
    return { message: error.message, errorType: 'TimeoutError', remoteOutcome: 'unknown' };
  }

  if (lowerMsg.includes('offline') || lowerMsg.includes('no connection')) {
    return { message: error.message, errorType: 'OfflineError' };
  }

  if (lowerMsg.includes('unknown supabase error') || lowerMsg.includes('unknown error')) {
    // 【关键修复】Supabase 客户端无法解析 504/502/503 等非 JSON 响应时抛出此错误。
    return { message: error.message, errorType: 'UnknownServerError' };
  }

  return null;
}

function enhanceErrorInstance(error: Error): EnhancedError {
  const enhanced = enhanceNativeError(error);
  const classification = classifyNativeErrorMessage(error);

  if (classification) {
    enhanced.errorType = classification.errorType;
    enhanced.isRetryable = true;
    applyRemoteOutcomeClassification(enhanced, classification);
    if (classification.errorType === 'BrowserNetworkSuspendedError' || classification.errorType === 'HtmlResponseError' || classification.errorType === 'UnknownServerError') {
      enhanced.name = classification.errorType;
    }
    return enhanced;
  }

  if (!enhanced.isRetryable) {
    enhanced.isRetryable = RETRYABLE_ERROR_TYPES.has(enhanced.name);
  }
  if (!enhanced.errorType) {
    enhanced.errorType = enhanced.name;
  }
  applyUnknownRemoteOutcomeFromErrorType(enhanced);

  return enhanced;
}

function applyRemoteOutcomeClassification(
  enhanced: EnhancedError,
  classification: SupabaseErrorClassification,
): void {
  if (classification.remoteOutcome) {
    enhanced.remoteOutcome = classification.remoteOutcome;
    return;
  }

  applyUnknownRemoteOutcomeFromErrorType(enhanced);
}

function applyUnknownRemoteOutcomeFromErrorType(enhanced: EnhancedError): void {
  if (UNKNOWN_REMOTE_OUTCOME_ERROR_TYPES.has(enhanced.errorType)) {
    enhanced.remoteOutcome = 'unknown';
  }
}

function classifyStatusCode(code: string | number | undefined, message: string | undefined): SupabaseErrorClassification | null {
  switch (String(code ?? '')) {
    case '504':
      return { message: '服务器响应超时 (504 Gateway Timeout)', errorType: 'NetworkTimeoutError', remoteOutcome: 'unknown' };
    case '503':
      return { message: '服务暂时不可用 (503 Service Unavailable)', errorType: 'ServiceUnavailableError' };
    case '502':
      return { message: '网关错误 (502 Bad Gateway)', errorType: 'GatewayError' };
    case '408':
      return { message: '请求超时 (408 Request Timeout)', errorType: 'RequestTimeoutError', remoteOutcome: 'unknown' };
    case '429':
      return { message: '请求过于频繁 (429 Too Many Requests)', errorType: 'RateLimitError' };
    case '401':
      return { message: '未授权或登录已过期 (401 Unauthorized)', errorType: 'AuthError' };
    case '403':
      return { message: '权限不足 (403 Forbidden)', errorType: 'PermissionError' };
    case '42501':
      // Postgres RLS 策略违规，可能由过期 token 引起，也可能是真正的权限不足。
      return { message: '权限不足 (RLS Policy Violation)', errorType: 'PermissionError' };
    case '23503':
      return { message: '关联数据尚未同步 (Foreign Key Violation)', errorType: 'ForeignKeyError' };
    case 'P0001':
    case 'PGRST':
      return classifyPostgresBusinessError(message);
    default:
      return null;
  }
}

function classifyKnownSupabaseErrorName(
  name: string | undefined,
  message: string | undefined,
): SupabaseErrorClassification | null {
  if (name === 'AuthRetryableFetchError') {
    return {
      message: message ?? 'Supabase auth request failed temporarily',
      errorType: 'AuthRetryableFetchError',
    };
  }

  if (name === 'AuthRefreshDiscardedError') {
    return {
      message: message ?? 'Supabase auth refresh result was discarded',
      errorType: 'AuthRefreshDiscardedError',
    };
  }

  return null;
}

function classifyPostgresBusinessError(message: string | undefined): SupabaseErrorClassification {
  const lowerMsg = typeof message === 'string' ? message.toLowerCase() : '';

  if (lowerMsg.includes('version regression not allowed')) {
    return { message: '版本冲突：数据已被修改，请刷新后重试', errorType: 'VersionConflictError' };
  }

  if (
    lowerMsg.includes('task must have either title or content') ||
    lowerMsg.includes('invalid stage value') ||
    lowerMsg.includes('invalid rank value')
  ) {
    return { message, errorType: 'ValidationError' };
  }

  return { message, errorType: 'BusinessRuleError' };
}

function classifyMessageOnlyError(message: string | undefined): SupabaseErrorClassification | null {
  if (!message) {
    return null;
  }

  const lowerMsg = message.toLowerCase();
  if (lowerMsg.includes('network_io_suspended') || lowerMsg.includes('network io suspended')) {
    return { message, errorType: 'BrowserNetworkSuspendedError' };
  }
  if (lowerMsg.includes('timeout') || lowerMsg.includes('timed out') || lowerMsg.includes('超时')) {
    return { message, errorType: 'TimeoutError', remoteOutcome: 'unknown' };
  }
  if (lowerMsg.includes('network') || lowerMsg.includes('fetch')) {
    return { message, errorType: 'NetworkError' };
  }
  if (lowerMsg.includes('offline') || lowerMsg.includes('no connection')) {
    return { message, errorType: 'OfflineError' };
  }
  if (lowerMsg.includes('rate limit') || lowerMsg.includes('too many requests')) {
    return { message, errorType: 'RateLimitError' };
  }
  if (lowerMsg.includes('jwt') || lowerMsg.includes('session') || lowerMsg.includes('expired')) {
    return { message, errorType: 'AuthError' };
  }
  if (lowerMsg.includes('unknown supabase error') || lowerMsg.includes('unknown error')) {
    return {
      message: '服务器响应异常 (可能是 504/502/503 错误)，请稍后重试',
      errorType: 'UnknownServerError',
    };
  }

  return null;
}

function normalizeHtmlResponseClassification(message: string | undefined, fallbackType: string): SupabaseErrorClassification {
  if (
    typeof message === 'string' &&
    (message.includes('<!DOCTYPE') || message.includes('<html') || message.includes('<!doctype'))
  ) {
    return {
      message: '收到 HTML 响应（可能是 CDN 缓存或代理错误），请稍后重试',
      errorType: 'HtmlResponseError',
    };
  }

  return { message, errorType: fallbackType };
}

function normalizeSupabaseErrorShape(error: SupabaseErrorShape): SupabaseErrorShape {
  if (!error.error || typeof error.error !== 'object') {
    return error;
  }

  return {
    ...error.error,
    status: error.status,
    statusText: error.statusText,
  };
}

function getClassificationCode(error: SupabaseErrorShape): string | number | undefined {
  return error.code ?? error.status;
}

function classifySupabaseObjectError(error: SupabaseErrorShape): SupabaseErrorClassification {
  const code = getClassificationCode(error);
  const statusClassification = classifyStatusCode(code, error.message);
  const nameClassification = statusClassification
    ? null
    : classifyKnownSupabaseErrorName(error.name, error.message);
  const messageClassification = statusClassification ?? nameClassification ?? classifyMessageOnlyError(error.message) ?? {
    message: error.message,
    errorType: 'SupabaseError',
  };

  const htmlClassification = normalizeHtmlResponseClassification(
    messageClassification.message,
    messageClassification.errorType,
  );

  if (!htmlClassification.message) {
    return {
      message: '服务器响应异常 (可能是 504/502/503 错误)，请稍后重试',
      errorType: 'UnknownServerError',
    };
  }

  return htmlClassification;
}

function createEnhancedSupabaseError(error: SupabaseErrorShape, classification: SupabaseErrorClassification): EnhancedError {
  const err = new Error(classification.message) as EnhancedError;
  err.name = classification.errorType;
  err.code = getClassificationCode(error);
  err.status = error.status;
  err.statusText = error.statusText;
  err.details = error.details;
  err.hint = error.hint;
  err.isRetryable = RETRYABLE_ERROR_TYPES.has(classification.errorType);
  err.errorType = classification.errorType;
  applyRemoteOutcomeClassification(err, classification);

  return err;
}

/**
 * 将 Supabase 错误对象转换为标准 Error 实例
 * 
 * Supabase 返回的错误是普通对象 {code, details, hint, message}，需要转换才能被 Sentry 正确捕获
 * 此函数会识别常见的网络错误（504, 503, 502等）并提供更友好的错误消息
 * 
 * **错误识别优先级**:
 * 1. 优先通过 HTTP 状态码（code/status）判断错误类型
 * 2. 如果没有状态码，尝试从 message 内容识别
 * 3. 最后使用默认的 SupabaseError 类型
 * 
 * @param error - Supabase 错误对象或标准 Error
 * @returns 增强的 Error 实例，包含 isRetryable 和 errorType 属性
 */
export function supabaseErrorToError(error: unknown): EnhancedError {
  if (error instanceof Error) {
    return enhanceErrorInstance(error);
  }

  const errObj = normalizeSupabaseErrorShape(error as SupabaseErrorShape);
  return createEnhancedSupabaseError(errObj, classifySupabaseObjectError(errObj));
}

/**
 * 分类 Supabase 客户端获取失败原因
 */
export function classifySupabaseClientFailure(
  isConfigured: boolean,
  error?: unknown
): SupabaseClientFailureInfo {
  if (!isConfigured) {
    return {
      category: 'not_configured',
      message: 'Supabase 未配置',
      retryable: false
    };
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return {
      category: 'offline',
      message: '当前离线，跳过云端同步',
      retryable: true
    };
  }

  if (error) {
    const enhanced = supabaseErrorToError(error);
    if (enhanced.errorType === 'OfflineError' || enhanced.errorType === 'NetworkError') {
      return {
        category: 'offline',
        message: enhanced.message,
        retryable: true
      };
    }
  }

  return {
    category: 'runtime_failure',
    message: error instanceof Error ? error.message : 'Supabase 客户端初始化失败',
    retryable: true
  };
}

/**
 * 判断错误是否可重试
 * 
 * @param error - 错误对象
 * @returns 是否可重试
 */
export function isRetryableError(error: unknown): boolean {
  if (!error) return false;
  
  const enhanced = supabaseErrorToError(error);
  return enhanced.isRetryable;
}

/**
 * 获取用户友好的错误消息
 * 
 * @param error - 错误对象
 * @returns 用户友好的错误消息
 */
export function getFriendlyErrorMessage(error: unknown): string {
  const enhanced = supabaseErrorToError(error);
  
  // 对于可重试的错误，提供简洁的提示
  if (enhanced.isRetryable) {
    switch (enhanced.errorType) {
      case 'NetworkTimeoutError':
      case 'RequestTimeoutError':
      case 'TimeoutError':
        return '网络响应超时，已加入重试队列';
      case 'ServiceUnavailableError':
        return '服务暂时不可用，已加入重试队列';
      case 'GatewayError':
        return '网关错误，已加入重试队列';
      case 'NetworkError':
        return '网络连接失败，数据将自动重试同步';
      case 'OfflineError':
        return '当前离线，数据将在恢复连接后同步';
      case 'BrowserNetworkSuspendedError':
        return '浏览器恢复连接中，数据将在稍后自动重试同步';
      case 'UnknownServerError':
        return '服务器响应异常，已加入重试队列';
      case 'HtmlResponseError':
        return '网络响应异常（CDN 缓存），已加入重试队列';
      case 'ForeignKeyError':
        return '关联数据尚未同步，已加入重试队列';
      case 'VersionConflictError':
        return '版本冲突，数据已被修改，请刷新后重试';
      default:
        return '操作失败，已加入重试队列';
    }
  }
  
  // 对于不可重试的错误，返回详细消息
  return enhanced.message;
}
