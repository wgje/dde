import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Injector } from '@angular/core';
import { VirusScanService } from './virus-scan.service';
import { SupabaseClientService } from './supabase-client.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';

const mockLoggerCategory = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
};

describe('VirusScanService', () => {
  let service: VirusScanService;

  beforeEach(() => {
    const injector = Injector.create({
      providers: [
        { provide: VirusScanService, useClass: VirusScanService },
        { provide: SupabaseClientService, useValue: { client: null, getClient: vi.fn(() => null) } },
        { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
        { provide: ToastService, useValue: { show: vi.fn(), error: vi.fn(), warning: vi.fn() } },
        { provide: SentryLazyLoaderService, useValue: { captureException: vi.fn() } },
      ],
    });

    service = injector.get(VirusScanService);
  });

  describe('signals 初始状态', () => {
    it('scanningCount 初始为 0', () => {
      expect(service.scanningCount()).toBe(0);
    });

    it('lastScanResult 初始为 null', () => {
      expect(service.lastScanResult()).toBeNull();
    });
  });

  describe('calculateFileHash', () => {
    it('返回 SHA-256 十六进制字符串', async () => {
      const blob = new Blob(['hello world'], { type: 'text/plain' });
      const hash = await service.calculateFileHash(blob);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('相同内容产生相同 hash', async () => {
      const blob1 = new Blob(['test content']);
      const blob2 = new Blob(['test content']);
      const hash1 = await service.calculateFileHash(blob1);
      const hash2 = await service.calculateFileHash(blob2);
      expect(hash1).toBe(hash2);
    });

    it('不同内容产生不同 hash', async () => {
      const blob1 = new Blob(['aaa']);
      const blob2 = new Blob(['bbb']);
      const hash1 = await service.calculateFileHash(blob1);
      const hash2 = await service.calculateFileHash(blob2);
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('createScanMetadata', () => {
    it('将 ScanResult 转换为 metadata', () => {
      const scanResult = {
        safe: true,
        scannedAt: new Date().toISOString(),
        fileHash: 'abc123',
        threats: [] as string[],
        status: 'clean' as const,
        scanner: 'test',
      };
      const metadata = service.createScanMetadata(scanResult as any);
      expect(metadata).toBeDefined();
      expect(metadata.lastScannedAt).toBe(scanResult.scannedAt);
      expect(metadata.scanHistory).toHaveLength(1);
    });
  });

  describe('scanBeforeUpload', () => {
    it('扫描小文件返回结果', async () => {
      const file = new Blob(['test'], { type: 'text/plain' });
      const result = await service.scanBeforeUpload(file, 'test.txt');
      // 无 Supabase 客户端时应返回安全（降级）或失败
      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    });
  });

  describe('checkServiceHealth', () => {
    it('无客户端时返回不健康', async () => {
      const healthy = await service.checkServiceHealth();
      expect(healthy).toBe(false);
    });
  });
});
