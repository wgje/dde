import { Injectable } from '@angular/core';

/**
 * 日志级别
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4
}

/**
 * 日志条目
 */
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  category: string;
  message: string;
  data?: unknown;
}

/**
 * 统一日志服务
 * 替代分散的 console.log/warn/error 调用
 * 
 * 功能：
 * - 统一的日志级别控制
 * - 生产环境自动禁用 debug/info 日志
 * - 可选的日志持久化（用于调试）
 * - 结构化日志输出
 */
@Injectable({
  providedIn: 'root'
})
export class LoggerService {
  /** 当前日志级别 */
  private level: LogLevel;
  
  /** 最近的日志条目（用于调试面板） */
  private recentLogs: LogEntry[] = [];
  private maxLogEntries = 100;
  
  /** 是否启用持久化日志 */
  private persistLogs = false;
  
  /**
   * CategoryLogger 缓存
   * 上限 MAX_CATEGORY_LOGGERS，超出后淘汰最早创建的条目。
   * 当前项目约 140 个静态类别，256 足够覆盖并留有余量。
   */
  private static readonly MAX_CATEGORY_LOGGERS = 256;
  private categoryLoggers = new Map<string, CategoryLogger>();
  
  constructor() {
    this.level = this.resolveInitialLevel();
  }

  /**
   * 默认控制台策略：默认安静，显式开启才输出 info/debug。
   * 这样可避免开发态启动期被大量初始化日志淹没。
   */
  private resolveInitialLevel(): LogLevel {
    const explicitLevel = this.readExplicitLogLevel();
    if (explicitLevel !== null) {
      return explicitLevel;
    }

    if (this.isVerboseConsoleEnabled()) {
      return LogLevel.DEBUG;
    }

    return LogLevel.WARN;
  }

  /**
   * 支持 localStorage 覆盖日志级别：
   * nanoflow.logLevel=debug|info|warn|error|none
   */
  private readExplicitLogLevel(): LogLevel | null {
    if (typeof window === 'undefined') {
      return null;
    }

    let rawLevel: string | null = null;
    try {
      rawLevel = window.localStorage.getItem('nanoflow.logLevel')?.trim().toLowerCase() ?? null;
    } catch {
      rawLevel = null;
    }

    switch (rawLevel) {
      case 'debug':
        return LogLevel.DEBUG;
      case 'info':
        return LogLevel.INFO;
      case 'warn':
      case 'warning':
        return LogLevel.WARN;
      case 'error':
        return LogLevel.ERROR;
      case 'none':
        return LogLevel.NONE;
      default:
        return null;
    }
  }

  private isVerboseConsoleEnabled(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }

    try {
      return window.localStorage.getItem('nanoflow.verbose') === 'true';
    } catch {
      return false;
    }
  }
  
  /**
   * 设置日志级别
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }
  
  /**
   * 启用/禁用日志持久化
   */
  setPersist(enabled: boolean): void {
    this.persistLogs = enabled;
    if (!enabled) {
      this.recentLogs = [];
    }
  }
  
  /**
   * 获取最近的日志
   */
  getRecentLogs(): ReadonlyArray<LogEntry> {
    return this.recentLogs;
  }
  
  /**
   * 清除日志
   */
  clearLogs(): void {
    this.recentLogs = [];
  }
  
  /**
   * DEBUG 级别日志
   * 仅在开发环境显示
   */
  debug(category: string, message: string, data?: unknown): void {
    this.log(LogLevel.DEBUG, category, message, data);
  }
  
  /**
   * INFO 级别日志
   * 开发环境显示，生产环境隐藏
   */
  info(category: string, message: string, data?: unknown): void {
    this.log(LogLevel.INFO, category, message, data);
  }
  
  /**
   * WARN 级别日志
   * 所有环境显示
   */
  warn(category: string, message: string, data?: unknown): void {
    this.log(LogLevel.WARN, category, message, data);
  }
  
  /**
   * ERROR 级别日志
   * 所有环境显示
   */
  error(category: string, message: string, data?: unknown): void {
    this.log(LogLevel.ERROR, category, message, data);
  }
  
  /**
   * 核心日志方法
   */
  private log(level: LogLevel, category: string, message: string, data?: unknown): void {
    if (level < this.level) return;

    // 安全：清洗敏感字段
    const sanitizedData = this.sanitizeData(data);

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      data: sanitizedData
    };

    // 持久化日志
    if (this.persistLogs) {
      this.recentLogs.push(entry);
      if (this.recentLogs.length > this.maxLogEntries) {
        this.recentLogs.shift();
      }
    }

    // 控制台输出：LoggerService 是唯一允许使用 console 的地方
    const prefix = `[${this.getLevelName(level)}] [${category}]`;
    const args = sanitizedData !== undefined ? [prefix, message, sanitizedData] : [prefix, message];

    /* eslint-disable no-console -- LoggerService 是唯一合法的 console 输出入口 */
    switch (level) {
      case LogLevel.DEBUG:
        console.debug(...args);
        break;
      case LogLevel.INFO:
        console.info(...args);
        break;
      case LogLevel.WARN:
        console.warn(...args);
        break;
      case LogLevel.ERROR:
        console.error(...args);
        break;
    }
    /* eslint-enable no-console */
  }
  
  /**
   * 敏感字段列表
   * 这些字段在日志中会被替换为 [REDACTED]
   */
  // M-1 fix: 所有条目统一小写，因为查询时使用 key.toLowerCase() 匹配
  private static readonly SENSITIVE_FIELDS = new Set([
    'password',
    'token',
    'accesstoken',
    'access_token',
    'refreshtoken',
    'refresh_token',
    'secret',
    'apikey',
    'api_key',
    'authorization',
    'auth',
    'secretkey',
    'secret_key',
    'encryptionkey',
    'encryption_key',
    'signingkey',
    'signing_key',
    'credential',
    'credentials',
    'private',
    'privatekey',
    'private_key',
  ]);
  
  /**
   * 清洗敏感数据
   * 递归遍历对象，将敏感字段替换为 [REDACTED]
   */
  private sanitizeData(data: unknown, depth = 0): unknown {
    // 防止无限递归
    if (depth > 5) return '[MAX_DEPTH]';

    if (data === null || data === undefined) {
      return data;
    }

    // Error 的 message / stack / cause 默认不可枚举，需显式保留
    if (data instanceof Error) {
      const errorData = data as Error & { cause?: unknown };
      const result: Record<string, unknown> = {
        name: errorData.name,
        message: this.sanitizeData(errorData.message, depth + 1),
      };

      if (errorData.stack) {
        result.stack = this.sanitizeData(errorData.stack, depth + 1);
      }

      if (errorData.cause !== undefined) {
        result.cause = this.sanitizeData(errorData.cause, depth + 1);
      }

      // 兼容自定义 Error 子类上的可枚举字段
      for (const [key, value] of Object.entries(errorData as unknown as Record<string, unknown>)) {
        if (key in result) continue;
        const lowerKey = key.toLowerCase();
        if (LoggerService.SENSITIVE_FIELDS.has(lowerKey)) {
          result[key] = '[REDACTED]';
        } else if (typeof value === 'string' && value.startsWith('eyJ') && value.length > 50) {
          result[key] = '[JWT_REDACTED]';
        } else {
          result[key] = this.sanitizeData(value, depth + 1);
        }
      }

      return result;
    }

    // 字符串：检查是否像 JWT token
    if (typeof data === 'string') {
      // JWT token 模式：eyJ... 开头
      if (data.startsWith('eyJ') && data.length > 50) {
        return '[JWT_REDACTED]';
      }
      return data;
    }

    // 非对象类型直接返回
    if (typeof data !== 'object') {
      return data;
    }

    // 数组：递归处理每个元素
    if (Array.isArray(data)) {
      return data.map(item => this.sanitizeData(item, depth + 1));
    }

    // 对象：检查并清洗敏感字段
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      if (LoggerService.SENSITIVE_FIELDS.has(lowerKey)) {
        result[key] = '[REDACTED]';
      } else if (typeof value === 'string' && value.startsWith('eyJ') && value.length > 50) {
        // JWT token 值
        result[key] = '[JWT_REDACTED]';
      } else {
        result[key] = this.sanitizeData(value, depth + 1);
      }
    }
    return result;
  }
  
  /**
   * 获取日志级别名称
   */
  private getLevelName(level: LogLevel): string {
    switch (level) {
      case LogLevel.DEBUG: return 'DEBUG';
      case LogLevel.INFO: return 'INFO';
      case LogLevel.WARN: return 'WARN';
      case LogLevel.ERROR: return 'ERROR';
      default: return 'UNKNOWN';
    }
  }
  
  /**
   * 创建带固定分类的子日志器
   */
  createLogger(category: string): CategoryLogger {
    return new CategoryLogger(this, category);
  }
  
  /**
   * 创建带固定分类的子日志器（简写方法）
   * 使用缓存避免重复创建
   */
  category(category: string): CategoryLogger {
    let logger = this.categoryLoggers.get(category);
    if (!logger) {
      // 简易 FIFO 淘汰：超出上限时移除最早插入的条目
      if (this.categoryLoggers.size >= LoggerService.MAX_CATEGORY_LOGGERS) {
        const oldest = this.categoryLoggers.keys().next().value;
        if (oldest !== undefined) this.categoryLoggers.delete(oldest);
      }
      logger = new CategoryLogger(this, category);
      this.categoryLoggers.set(category, logger);
    }
    return logger;
  }
}

/**
 * 带固定分类的日志器
 * 方便在特定服务/组件中使用
 */
export class CategoryLogger {
  constructor(
    private logger: LoggerService,
    private category: string
  ) {}
  
  debug(message: string, data?: unknown): void {
    this.logger.debug(this.category, message, data);
  }
  
  info(message: string, data?: unknown): void {
    this.logger.info(this.category, message, data);
  }
  
  warn(message: string, data?: unknown): void {
    this.logger.warn(this.category, message, data);
  }
  
  error(message: string, data?: unknown): void {
    this.logger.error(this.category, message, data);
  }
}
