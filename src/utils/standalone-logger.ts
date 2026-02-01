/**
 * 独立日志工具函数
 * 
 * 用于无法注入 LoggerService 的场景（如函数式守卫、独立工具函数）
 * 在生产环境中会被静默处理，开发环境中输出到控制台
 * 
 * 使用场景：
 * - 函数式守卫（CanActivateFn）
 * - 纯函数工具
 * - 模块初始化代码
 */

/* eslint-disable no-console */

import { environment } from '../environments/environment';

/** 日志级别 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 日志前缀 */
const LOG_PREFIX = '[NanoFlow]';

/**
 * 检查是否应该输出日志
 * 生产环境只输出 warn 和 error
 */
function shouldLog(level: LogLevel): boolean {
  if (!environment.production) {
    return true; // 开发环境输出所有日志
  }
  // 生产环境只输出 warn 和 error
  return level === 'warn' || level === 'error';
}

/**
 * 格式化日志消息
 */
function formatMessage(category: string, message: string): string {
  return `${LOG_PREFIX}[${category}] ${message}`;
}

/**
 * 创建带分类的日志记录器
 * 
 * @example
 * ```typescript
 * const log = createStandaloneLogger('AuthGuard');
 * log.warn('localStorage 访问失败', error);
 * ```
 */
export function createStandaloneLogger(category: string) {
  return {
    debug: (message: string, ...args: unknown[]) => {
      if (shouldLog('debug')) {
        console.debug(formatMessage(category, message), ...args);
      }
    },
    info: (message: string, ...args: unknown[]) => {
      if (shouldLog('info')) {
        console.info(formatMessage(category, message), ...args);
      }
    },
    warn: (message: string, ...args: unknown[]) => {
      if (shouldLog('warn')) {
        console.warn(formatMessage(category, message), ...args);
      }
    },
    error: (message: string, ...args: unknown[]) => {
      if (shouldLog('error')) {
        console.error(formatMessage(category, message), ...args);
      }
    }
  };
}

// 预创建常用分类的日志记录器
export const guardLogger = createStandaloneLogger('Guard');
export const utilLogger = createStandaloneLogger('Util');
export const securityLogger = createStandaloneLogger('Security');
