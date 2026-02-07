import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Injector, DestroyRef } from '@angular/core';
import { AttachmentService } from './attachment.service';
import { SupabaseClientService } from './supabase-client.service';
import { LoggerService } from './logger.service';
import { Attachment } from '../models';

const mockLoggerCategory = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
};

// We need to check if FileTypeValidatorService and VirusScanService exist
// and import them dynamically

describe('AttachmentService', () => {
  let service: AttachmentService;

  beforeEach(async () => {
    // Dynamic imports to handle possible path differences
    const { FileTypeValidatorService } = await import('./file-type-validator.service');
    const { VirusScanService } = await import('./virus-scan.service');

    const injector = Injector.create({
      providers: [
        { provide: AttachmentService, useClass: AttachmentService },
        { provide: SupabaseClientService, useValue: { client: null, getClient: vi.fn(() => null) } },
        { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
        { provide: FileTypeValidatorService, useValue: { validate: vi.fn().mockReturnValue({ ok: true }) } },
        { provide: VirusScanService, useValue: { scanFile: vi.fn().mockResolvedValue({ safe: true }) } },
        { provide: DestroyRef, useValue: { onDestroy: vi.fn() } },
      ],
    });

    service = injector.get(AttachmentService);
  });

  describe('markAsDeleted / isDeleted / restoreDeleted', () => {
    it('标记删除并检测', () => {
      const att: Attachment = {
        id: 'a1', type: 'file', name: 'test.txt',
        url: 'https://example.com/test.txt', createdAt: new Date().toISOString(),
      };
      const deleted = service.markAsDeleted(att);
      expect(service.isDeleted(deleted)).toBe(true);
      expect(deleted.deletedAt).toBeDefined();
    });

    it('恢复删除', () => {
      const att: Attachment = {
        id: 'a1', type: 'file', name: 'test.txt',
        url: 'https://example.com/test.txt', createdAt: new Date().toISOString(),
        deletedAt: new Date().toISOString(),
      };
      const restored = service.restoreDeleted(att);
      expect(service.isDeleted(restored)).toBe(false);
      expect(restored.deletedAt).toBeUndefined();
    });
  });

  describe('filterActive', () => {
    it('过滤掉已删除的附件', () => {
      const attachments: Attachment[] = [
        { id: 'a1', type: 'file', name: 'active.txt', url: 'u1', createdAt: new Date().toISOString() },
        { id: 'a2', type: 'file', name: 'deleted.txt', url: 'u2', createdAt: new Date().toISOString(), deletedAt: new Date().toISOString() },
      ];
      const active = service.filterActive(attachments);
      expect(active.length).toBe(1);
      expect(active[0].id).toBe('a1');
    });
  });

  describe('canAddAttachment', () => {
    it('限制内可以添加', () => {
      expect(service.canAddAttachment(0)).toBe(true);
    });
  });

  describe('setUrlRefreshCallback / clearUrlRefreshCallback', () => {
    it('设置和清除回调不出错', () => {
      const callback = vi.fn();
      expect(() => service.setUrlRefreshCallback(callback)).not.toThrow();
      expect(() => service.clearUrlRefreshCallback()).not.toThrow();
    });
  });

  describe('clearMonitoredAttachments', () => {
    it('清除监控不出错', () => {
      expect(() => service.clearMonitoredAttachments()).not.toThrow();
    });
  });

  describe('getActiveUploadCount', () => {
    it('初始为 0', () => {
      expect(service.getActiveUploadCount()).toBe(0);
    });
  });

  describe('cancelAllUploads', () => {
    it('无活动上传时不出错', () => {
      expect(() => service.cancelAllUploads()).not.toThrow();
    });
  });

  describe('uploadFile', () => {
    it('无 Supabase 客户端时返回失败', async () => {
      const file = new File(['test'], 'test.txt', { type: 'text/plain' });
      const result = await service.uploadFile('user1', 'proj1', 'task1', file);
      expect(result.success).toBe(false);
    });
  });
});
