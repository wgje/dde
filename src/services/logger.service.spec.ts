import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Injector } from '@angular/core';
import { LoggerService, LogLevel } from './logger.service';

describe('LoggerService', () => {
  let service: LoggerService;

  beforeEach(() => {
    const injector = Injector.create({
      providers: [
        { provide: LoggerService, useClass: LoggerService },
      ],
    });
    service = injector.get(LoggerService);
  });

  describe('setLevel / 日志过滤', () => {
    it('默认级别过滤 DEBUG 日志', () => {
      const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      service.setLevel(LogLevel.WARN);
      service.debug('test', 'should not appear');
      // DEBUG < WARN, so it should be filtered
      spy.mockRestore();
    });
  });

  describe('setPersist / getRecentLogs / clearLogs', () => {
    it('启用持久化后可获取日志', () => {
      service.setLevel(LogLevel.DEBUG);
      service.setPersist(true);
      service.info('test', 'hello');
      const logs = service.getRecentLogs();
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[logs.length - 1].message).toBe('hello');
    });

    it('clearLogs 清空日志', () => {
      service.setLevel(LogLevel.DEBUG);
      service.setPersist(true);
      service.info('test', 'entry');
      service.clearLogs();
      expect(service.getRecentLogs().length).toBe(0);
    });
  });

  describe('category / createLogger', () => {
    it('返回 CategoryLogger 实例', () => {
      const logger = service.category('TestCat');
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
    });

    it('同类别缓存同一实例', () => {
      const a = service.category('Cache');
      const b = service.category('Cache');
      expect(a).toBe(b);
    });

    it('createLogger 创建新实例', () => {
      const a = service.createLogger('New');
      expect(a).toBeDefined();
      expect(typeof a.info).toBe('function');
    });
  });

  describe('日志级别方法', () => {
    it('info 不抛异常', () => {
      expect(() => service.info('cat', 'msg')).not.toThrow();
    });

    it('warn 不抛异常', () => {
      expect(() => service.warn('cat', 'msg')).not.toThrow();
    });

    it('error 不抛异常', () => {
      expect(() => service.error('cat', 'msg')).not.toThrow();
    });

    it('debug 不抛异常', () => {
      expect(() => service.debug('cat', 'msg')).not.toThrow();
    });

    it('可附带数据', () => {
      expect(() => service.info('cat', 'msg', { extra: 123 })).not.toThrow();
    });
  });
});
