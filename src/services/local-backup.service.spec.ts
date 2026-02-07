import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Injector } from '@angular/core';
import { LocalBackupService } from './local-backup.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { ExportService } from './export.service';
import { UiStateService } from './ui-state.service';
import { PreferenceService } from './preference.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';

const mockLoggerCategory = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
};

describe('LocalBackupService', () => {
  let service: LocalBackupService;

  beforeEach(() => {
    const injector = Injector.create({
      providers: [
        { provide: LocalBackupService, useClass: LocalBackupService },
        { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
        { provide: ToastService, useValue: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() } },
        { provide: ExportService, useValue: { exportProjectToJson: vi.fn().mockReturnValue('{}') } },
        { provide: UiStateService, useValue: { isMobile: vi.fn(() => false) } },
        { provide: PreferenceService, useValue: { get: vi.fn(), set: vi.fn() } },
        { provide: SentryLazyLoaderService, useValue: { captureException: vi.fn() } },
      ],
    });
    service = injector.get(LocalBackupService);
  });

  describe('初始状态', () => {
    it('初始未授权', () => {
      expect(service.isAuthorized()).toBe(false);
    });

    it('初始目录名为 null', () => {
      expect(service.directoryName()).toBeNull();
    });

    it('初始无上次备份时间', () => {
      expect(service.lastBackupTime()).toBeNull();
    });

    it('初始未在备份中', () => {
      expect(service.isBackingUp()).toBe(false);
    });

    it('自动备份默认关闭', () => {
      expect(service.autoBackupEnabled()).toBe(false);
    });
  });

  describe('compatibility', () => {
    it('返回兼容性信息', () => {
      const compat = service.compatibility();
      expect(compat).toBeDefined();
      expect(compat).toHaveProperty('isSupported');
    });
  });

  describe('revokeDirectoryAccess', () => {
    it('撤销后状态为未授权', async () => {
      await service.revokeDirectoryAccess();
      expect(service.isAuthorized()).toBe(false);
      expect(service.directoryName()).toBeNull();
    });
  });

  describe('stopAutoBackup', () => {
    it('停止定时器', () => {
      service.stopAutoBackup();
      expect(service.autoBackupEnabled()).toBe(false);
    });
  });

  describe('setAutoBackupInterval', () => {
    it('设置备份间隔', () => {
      service.setAutoBackupInterval(60000);
      expect(service.autoBackupIntervalMs()).toBe(60000);
    });
  });

  describe('ngOnDestroy', () => {
    it('清理时不出错', () => {
      expect(() => service.ngOnDestroy()).not.toThrow();
    });
  });

  describe('requestDirectoryAccess', () => {
    it('不支持 File System Access API 时返回不可用', async () => {
      // In Node/test environment, showDirectoryPicker doesn't exist
      const result = await service.requestDirectoryAccess();
      expect(result).toHaveProperty('success');
      expect(result.success).toBe(false);
    });
  });

  describe('performBackup', () => {
    it('未授权时返回失败', async () => {
      const result = await service.performBackup([{
        id: 'p1', name: 'Test', tasks: [], connections: [],
      }]);
      expect(result.success).toBe(false);
    });
  });
});
