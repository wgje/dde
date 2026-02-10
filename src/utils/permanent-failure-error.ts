/**
 * 永久失败错误 - 用于标记不可重试的错误（版本冲突、会话过期等）
 * 
 * 与临时网络错误不同，永久失败错误不应加入重试队列：
 * - 版本冲突（VersionConflictError）：需要用户刷新后重新操作
 * - 会话过期（SessionExpiredError）：需要用户重新登录
 * 
 * @example
 * ```typescript
 * throw new PermanentFailureError(
 *   'Version conflict',
 *   originalError,
 *   { taskId: '123', operation: 'pushTask' }
 * );
 * ```
 */
export class PermanentFailureError extends Error {
  /**
   * 标记这是永久失败错误
   * 用于 processRetryQueue 识别并跳过重试
   */
  readonly isPermanentFailure = true;

  /**
   * 原始错误对象（如果存在）
   * 用于错误追踪和调试
   */
  readonly originalError?: Error;

  /**
   * 额外的上下文信息
   * 例如：taskId, projectId, operation 等
   */
  readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    originalError?: Error,
    context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'PermanentFailureError';
    this.originalError = originalError;
    this.context = context;

    // 保持正确的原型链（TypeScript/ES5 兼容性）
    Object.setPrototypeOf(this, PermanentFailureError.prototype);
  }

  /**
   * 获取完整的错误信息（包含原始错误）
   */
  getFullMessage(): string {
    if (this.originalError) {
      return `${this.message} (原因: ${this.originalError.message})`;
    }
    return this.message;
  }

  /**
   * 转换为 JSON 格式（用于日志记录）
   * 【P3-13 修复】生产环境不包含堆栈信息，避免信息泄露
   */
  toJSON(): Record<string, unknown> {
    const json: Record<string, unknown> = {
      name: this.name,
      message: this.message,
      isPermanentFailure: this.isPermanentFailure,
      originalError: this.originalError ? {
        name: this.originalError.name,
        message: this.originalError.message
      } : undefined,
      context: this.context,
    };
    // 仅开发环境包含堆栈
    if (typeof ngDevMode === 'undefined' || ngDevMode) {
      json['stack'] = this.stack;
    }
    return json;
  }
}

/**
 * 类型守卫：检查错误是否为 PermanentFailureError
 * 
 * @example
 * ```typescript
 * try {
 *   await pushTask(task);
 * } catch (e) {
 *   if (isPermanentFailureError(e)) {
 *     // 不加入重试队列
 *     logger.warn('永久失败', e.toJSON());
 *   } else {
 *     // 可重试错误，加入队列
 *     retryQueue.push(task);
 *   }
 * }
 * ```
 */
export function isPermanentFailureError(error: unknown): error is PermanentFailureError {
  return error instanceof PermanentFailureError ||
    (error instanceof Error && (error as unknown as { isPermanentFailure?: boolean }).isPermanentFailure === true);
}
