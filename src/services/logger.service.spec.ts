/**
 * LoggerService 单元测试
 * 
 * 测试覆盖：
 * - 日志级别控制
 * - 日志持久化
 * - CategoryLogger 子日志器
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { LoggerService, LogLevel, CategoryLogger } from './logger.service';

describe('LoggerService', () => {
  let service: LoggerService;
  let consoleSpy: {
    debug: ReturnType<typeof vi.spyOn>;
    info: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
  };
  
  beforeEach(() => {
    // Mock console methods
    consoleSpy = {
      debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
    
    TestBed.configureTestingModule({
      providers: [LoggerService],
    });
    
    service = TestBed.inject(LoggerService);
    // 确保在开发模式下测试（所有级别可见）
    service.setLevel(LogLevel.DEBUG);
  });
  
  afterEach(() => {
    vi.restoreAllMocks();
  });
  
  describe('日志级别控制', () => {
    it('DEBUG 级别应输出所有日志', () => {
      service.setLevel(LogLevel.DEBUG);
      
      service.debug('TestCategory', 'debug message');
      service.info('TestCategory', 'info message');
      service.warn('TestCategory', 'warn message');
      service.error('TestCategory', 'error message');
      
      expect(consoleSpy.debug).toHaveBeenCalled();
      expect(consoleSpy.info).toHaveBeenCalled();
      expect(consoleSpy.warn).toHaveBeenCalled();
      expect(consoleSpy.error).toHaveBeenCalled();
    });
    
    it('WARN 级别应只输出 warn 和 error', () => {
      service.setLevel(LogLevel.WARN);
      
      service.debug('TestCategory', 'debug message');
      service.info('TestCategory', 'info message');
      service.warn('TestCategory', 'warn message');
      service.error('TestCategory', 'error message');
      
      expect(consoleSpy.debug).not.toHaveBeenCalled();
      expect(consoleSpy.info).not.toHaveBeenCalled();
      expect(consoleSpy.warn).toHaveBeenCalled();
      expect(consoleSpy.error).toHaveBeenCalled();
    });
    
    it('ERROR 级别应只输出 error', () => {
      service.setLevel(LogLevel.ERROR);
      
      service.debug('TestCategory', 'debug message');
      service.info('TestCategory', 'info message');
      service.warn('TestCategory', 'warn message');
      service.error('TestCategory', 'error message');
      
      expect(consoleSpy.debug).not.toHaveBeenCalled();
      expect(consoleSpy.info).not.toHaveBeenCalled();
      expect(consoleSpy.warn).not.toHaveBeenCalled();
      expect(consoleSpy.error).toHaveBeenCalled();
    });
    
    it('NONE 级别应禁用所有日志', () => {
      service.setLevel(LogLevel.NONE);
      
      service.debug('TestCategory', 'debug message');
      service.info('TestCategory', 'info message');
      service.warn('TestCategory', 'warn message');
      service.error('TestCategory', 'error message');
      
      expect(consoleSpy.debug).not.toHaveBeenCalled();
      expect(consoleSpy.info).not.toHaveBeenCalled();
      expect(consoleSpy.warn).not.toHaveBeenCalled();
      expect(consoleSpy.error).not.toHaveBeenCalled();
    });
  });
  
  describe('日志格式', () => {
    it('应包含级别和分类前缀', () => {
      service.warn('MyService', 'test message');
      
      expect(consoleSpy.warn).toHaveBeenCalledWith(
        '[WARN] [MyService]',
        'test message'
      );
    });
    
    it('附加数据应作为第三个参数传递', () => {
      const data = { id: 1, name: 'test' };
      service.error('MyService', 'error occurred', data);
      
      expect(consoleSpy.error).toHaveBeenCalledWith(
        '[ERROR] [MyService]',
        'error occurred',
        data
      );
    });
  });
  
  describe('日志持久化', () => {
    it('默认应不持久化日志', () => {
      service.debug('Test', 'message');
      
      expect(service.getRecentLogs()).toHaveLength(0);
    });
    
    it('启用持久化后应存储日志', () => {
      service.setPersist(true);
      
      service.debug('Test', 'message 1');
      service.info('Test', 'message 2');
      service.warn('Test', 'message 3');
      
      const logs = service.getRecentLogs();
      expect(logs).toHaveLength(3);
      expect(logs[0].level).toBe(LogLevel.DEBUG);
      expect(logs[1].level).toBe(LogLevel.INFO);
      expect(logs[2].level).toBe(LogLevel.WARN);
    });
    
    it('禁用持久化应清除现有日志', () => {
      service.setPersist(true);
      service.debug('Test', 'message');
      expect(service.getRecentLogs()).toHaveLength(1);
      
      service.setPersist(false);
      
      expect(service.getRecentLogs()).toHaveLength(0);
    });
    
    it('clearLogs 应清除所有日志', () => {
      service.setPersist(true);
      service.debug('Test', 'message 1');
      service.debug('Test', 'message 2');
      expect(service.getRecentLogs()).toHaveLength(2);
      
      service.clearLogs();
      
      expect(service.getRecentLogs()).toHaveLength(0);
    });
    
    it('日志条目应包含正确的结构', () => {
      service.setPersist(true);
      const testData = { key: 'value' };
      
      service.info('TestCategory', 'test message', testData);
      
      const logs = service.getRecentLogs();
      expect(logs[0]).toMatchObject({
        level: LogLevel.INFO,
        category: 'TestCategory',
        message: 'test message',
        data: testData,
      });
      expect(logs[0].timestamp).toBeDefined();
    });
  });
  
  describe('CategoryLogger', () => {
    it('category() 应返回带固定分类的子日志器', () => {
      const categoryLogger = service.category('MyComponent');
      
      expect(categoryLogger).toBeInstanceOf(CategoryLogger);
    });
    
    it('CategoryLogger 应使用固定分类', () => {
      const categoryLogger = service.category('MyComponent');
      
      categoryLogger.warn('test message');
      
      expect(consoleSpy.warn).toHaveBeenCalledWith(
        '[WARN] [MyComponent]',
        'test message'
      );
    });
    
    it('category() 应缓存同一分类的日志器', () => {
      const logger1 = service.category('SameCategory');
      const logger2 = service.category('SameCategory');
      
      expect(logger1).toBe(logger2);
    });
    
    it('不同分类应返回不同的日志器', () => {
      const logger1 = service.category('Category1');
      const logger2 = service.category('Category2');
      
      expect(logger1).not.toBe(logger2);
    });
    
    it('createLogger 应创建新的日志器实例', () => {
      const logger1 = service.createLogger('Same');
      const logger2 = service.createLogger('Same');
      
      // createLogger 不缓存，每次返回新实例
      expect(logger1).not.toBe(logger2);
    });
    
    it('CategoryLogger 所有方法应正常工作', () => {
      const categoryLogger = service.category('AllMethods');
      
      categoryLogger.debug('debug');
      categoryLogger.info('info');
      categoryLogger.warn('warn');
      categoryLogger.error('error');
      
      expect(consoleSpy.debug).toHaveBeenCalled();
      expect(consoleSpy.info).toHaveBeenCalled();
      expect(consoleSpy.warn).toHaveBeenCalled();
      expect(consoleSpy.error).toHaveBeenCalled();
    });
  });
});
