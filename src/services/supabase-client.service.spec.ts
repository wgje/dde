import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Injector } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { LoggerService } from './logger.service';

const mockLoggerCategory = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
};

describe('SupabaseClientService', () => {
  let service: SupabaseClientService;

  beforeEach(() => {
    const injector = Injector.create({
      providers: [
        { provide: SupabaseClientService, useClass: SupabaseClientService },
        { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
      ],
    });
    service = injector.get(SupabaseClientService);
  });

  describe('初始状态', () => {
    it('configurationError 信号存在', () => {
      expect(service.configurationError).toBeDefined();
    });

    it('isOfflineMode 信号存在', () => {
      expect(service.isOfflineMode).toBeDefined();
    });
  });

  describe('isConfigured', () => {
    it('无环境配置时为特定值', () => {
      expect(typeof service.isConfigured).toBe('boolean');
    });
  });

  describe('reset', () => {
    it('重置不出错', () => {
      expect(() => service.reset()).not.toThrow();
    });
  });

  describe('getSession', () => {
    it('返回 session 数据', async () => {
      const result = await service.getSession();
      expect(result).toBeDefined();
      expect(result.data).toBeDefined();
    });
  });
});
