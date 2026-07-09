import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Injector } from '@angular/core';
import { VirusScanService } from './virus-scan.service';
import { SupabaseClientService } from './supabase-client.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { SCAN_STATUS } from '../config/virus-scan.config';

const mockLoggerCategory = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
};

class DataUrlFileReader {
  result: string | null = null;
  onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
  onerror: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;

  readAsDataURL(_blob: Blob): void {
    this.result = 'data:text/plain;base64,dGVzdA==';
    queueMicrotask(() => {
      this.onload?.call(this as unknown as FileReader, { target: this } as unknown as ProgressEvent<FileReader>);
    });
  }
}

function createFunctionsHttpError(body: Record<string, unknown>, message = 'Edge Function returned a non-2xx status code') {
  return {
    message,
    context: {
      json: vi.fn().mockResolvedValue(body),
    },
  };
}

describe('VirusScanService', () => {
  let service: VirusScanService;
  let invokeMock: ReturnType<typeof vi.fn>;
  let toastMock: { show: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; warning: ReturnType<typeof vi.fn> };
  let sentryMock: { captureException: ReturnType<typeof vi.fn>; captureMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('FileReader', DataUrlFileReader);
    invokeMock = vi.fn();
    toastMock = { show: vi.fn(), error: vi.fn(), warning: vi.fn() };
    sentryMock = { captureException: vi.fn(), captureMessage: vi.fn() };

    const injector = Injector.create({
      providers: [
        { provide: VirusScanService, useClass: VirusScanService },
        {
          provide: SupabaseClientService,
          useValue: {
            client: vi.fn(() => ({
              functions: { invoke: invokeMock },
            })),
            getClient: vi.fn(() => null),
          },
        },
        { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
        { provide: ToastService, useValue: toastMock },
        { provide: SentryLazyLoaderService, useValue: sentryMock },
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
        fileId: 'file-1',
        safe: true,
        scannedAt: new Date().toISOString(),
        fileHash: 'abc123',
        threats: [] as string[],
        status: 'clean' as const,
        scanner: 'test',
      };
      const metadata = service.createScanMetadata(scanResult);
      expect(metadata).toBeDefined();
      expect(metadata.fileId).toBe('file-1');
      expect(metadata.lastScannedAt).toBe(scanResult.scannedAt);
      expect(metadata.fileHash).toBe('abc123');
      expect(metadata.scanHistory).toHaveLength(1);
    });

    it('本地 skipped 结果不应写入假服务端扫描 fileId', () => {
      const scanResult = {
        fileId: 'local-skip-placeholder',
        scannedAt: '2026-06-06T00:00:00.000Z',
        status: SCAN_STATUS.SKIPPED,
        scanner: 'local',
        threatDescription: '跳过扫描: safe_type',
      };

      const metadata = service.createScanMetadata(scanResult);

      expect(metadata.fileId).toBeUndefined();
      expect(metadata.scanStatus).toBe(SCAN_STATUS.SKIPPED);
      expect(metadata.scanHistory).toEqual([
        expect.objectContaining({
          status: SCAN_STATUS.SKIPPED,
          scanner: 'local',
        }),
      ]);
    });
  });

  describe('scanBeforeUpload', () => {
    it('扫描小文件返回结果', async () => {
      invokeMock.mockResolvedValue({
        data: { status: SCAN_STATUS.CLEAN, fileId: 'file-1', fileHash: 'abc123' },
        error: null,
      });
      const file = new Blob(['test'], { type: 'text/plain' });
      const result = await service.scanBeforeUpload(file, 'test.txt');
      expect(result).toEqual(expect.objectContaining({
        success: true,
        result: expect.objectContaining({
          fileId: 'file-1',
          fileHash: 'abc123',
          status: SCAN_STATUS.CLEAN,
        }),
      }));
      expect(service.lastScanResult()).toEqual(expect.objectContaining({ fileId: 'file-1' }));
      expect(service.scanningCount()).toBe(0);
    });

    it('检测到威胁时拒绝上传并上报', async () => {
      invokeMock.mockResolvedValue({
        data: {
          status: SCAN_STATUS.THREAT_DETECTED,
          fileId: 'file-threat',
          threatName: 'EICAR-Test-File',
          threatDescription: 'test malware signature',
        },
        error: null,
      });

      const file = new Blob(['x5o suspicious'], { type: 'text/plain' });
      const result = await service.scanBeforeUpload(file, 'bad.txt');

      expect(result).toEqual(expect.objectContaining({
        success: false,
        errorCode: 'THREAT_DETECTED',
        result: expect.objectContaining({
          fileId: 'file-threat',
          threatName: 'EICAR-Test-File',
        }),
      }));
      expect(toastMock.error).toHaveBeenCalledWith('安全警告', expect.stringContaining('EICAR-Test-File'), { duration: 10000 });
      expect(sentryMock.captureMessage).toHaveBeenCalledWith(
        'Malware detected in uploaded file',
        expect.objectContaining({ level: 'warning' }),
      );
      expect(service.scanningCount()).toBe(0);
    });

    it('Edge Function 返回失败且 data 为 null 时按扫描失败处理', async () => {
      invokeMock.mockResolvedValue({
        data: null,
        error: { message: 'scan service unavailable' },
      });

      const file = new Blob(['test'], { type: 'text/plain' });
      const result = await service.scanBeforeUpload(file, 'test.txt');

      expect(result).toEqual(expect.objectContaining({
        success: false,
        errorCode: 'SCAN_FAILED',
        error: 'scan service unavailable',
      }));
      expect(service.lastScanResult()).toBeNull();
      expect(service.scanningCount()).toBe(0);
    });

    it('Edge Function 返回 FunctionsHttpError body 时应保留扫描业务错误', async () => {
      invokeMock.mockResolvedValue({
        data: null,
        error: createFunctionsHttpError({ error: '扫描服务暂不可用，请稍后重试' }),
      });

      const file = new Blob(['test'], { type: 'text/plain' });
      const result = await service.scanBeforeUpload(file, 'test.txt');

      expect(result).toEqual(expect.objectContaining({
        success: false,
        errorCode: 'SCAN_FAILED',
        error: '扫描服务暂不可用，请稍后重试',
      }));
      expect(service.scanningCount()).toBe(0);
    });

    it('Edge Function 网络中断时应标记为可恢复网络错误', async () => {
      invokeMock.mockRejectedValue(new TypeError('Failed to fetch'));

      const file = new Blob(['test'], { type: 'text/plain' });
      const result = await service.scanBeforeUpload(file, 'test.txt');

      expect(result).toEqual(expect.objectContaining({
        success: false,
        errorCode: 'NETWORK_ERROR',
      }));
      expect(service.lastScanResult()).toBeNull();
      expect(service.scanningCount()).toBe(0);
    });

    it('Edge Function 返回 failed 状态时应 fail closed 拒绝上传', async () => {
      invokeMock.mockResolvedValue({
        data: { status: SCAN_STATUS.FAILED, fileId: 'file-failed' },
        error: null,
      });

      const file = new Blob(['test'], { type: 'text/plain' });
      const result = await service.scanBeforeUpload(file, 'test.txt');

      expect(result).toEqual(expect.objectContaining({
        success: false,
        errorCode: 'SCAN_FAILED',
        result: expect.objectContaining({
          fileId: 'file-failed',
          status: SCAN_STATUS.FAILED,
        }),
      }));
      expect(service.lastScanResult()).toEqual(expect.objectContaining({
        fileId: 'file-failed',
        status: SCAN_STATUS.FAILED,
      }));
      expect(service.scanningCount()).toBe(0);
    });
  });

  describe('checkBeforeDownload', () => {
    it('扫描状态缺少有效 scannedAt 时应 fail closed 阻止下载', async () => {
      invokeMock.mockResolvedValue({
        data: {
          status: SCAN_STATUS.CLEAN,
          fileId: 'file-clean-without-scan-time',
          scanner: 'clamav',
        },
        error: null,
      });

      const result = await service.checkBeforeDownload('file-clean-without-scan-time');

      expect(result).toEqual(expect.objectContaining({
        success: false,
        error: '扫描状态已过期，请等待重新扫描',
      }));
    });

    it('扫描状态缺少 scannedAt 时不应依赖 Date shim 的 undefined 解析行为', async () => {
      const NativeDate = Date;
      class LenientUndefinedDate extends NativeDate {
        constructor(value?: unknown) {
          if (arguments.length === 0 || value === undefined) {
            super('2026-06-13T00:00:00.000Z');
            return;
          }
          super(value as string);
        }

        static now = NativeDate.now.bind(NativeDate);
        static parse = NativeDate.parse.bind(NativeDate);
        static UTC = NativeDate.UTC.bind(NativeDate);
      }

      vi.stubGlobal('Date', LenientUndefinedDate);
      invokeMock.mockResolvedValue({
        data: {
          status: SCAN_STATUS.CLEAN,
          fileId: 'file-clean-with-date-shim',
          scanner: 'clamav',
        },
        error: null,
      });

      try {
        const result = await service.checkBeforeDownload('file-clean-with-date-shim');

        expect(result).toEqual(expect.objectContaining({
          success: false,
          error: '扫描状态已过期，请等待重新扫描',
        }));
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe('checkServiceHealth', () => {
    it('无客户端时返回不健康', async () => {
      const healthy = await service.checkServiceHealth();
      expect(healthy).toBe(false);
    });
  });
});
