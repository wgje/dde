import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Injector, DestroyRef } from '@angular/core';
import { AttachmentService } from './attachment.service';
import { SupabaseClientService } from './supabase-client.service';
import { LoggerService } from './logger.service';
import { Attachment } from '../models';
import { SCAN_STATUS } from '../config/virus-scan.config';
import { ActionQueueService } from './action-queue.service';
import { AttachmentUploadOutboxService } from './attachment-upload-outbox.service';
import { AttachmentCleanupOutboxService } from './attachment-cleanup-outbox.service';
import { registerAttachmentServiceUrlRefreshRaceSpecs } from './attachment-service-url-refresh-race.spec-helpers';
import {
  createQueuedAttachmentUploadBarrierHarness,
  type QueuedAttachmentUploadBarrier,
} from './action-queue-attachment-processors.spec-helpers';

const mockLoggerCategory = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
};

// We need to check if FileTypeValidatorService and VirusScanService exist
// and import them dynamically

describe('AttachmentService', () => {
  let service: AttachmentService;
  let destroyService: () => void = () => undefined;
  type AttachmentServicePrivate = {
    urlRefreshTimer: ReturnType<typeof setInterval> | null;
    startUrlRefreshMonitor: () => void;
    stopUrlRefreshMonitor: () => void;
  };
  let mockVirusScan: {
    scanBeforeUpload: ReturnType<typeof vi.fn>;
    createScanMetadata: ReturnType<typeof vi.fn>;
    checkBeforeDownload: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    // Dynamic imports to handle possible path differences
    const { FileTypeValidatorService } = await import('./file-type-validator.service');
    const { VirusScanService } = await import('./virus-scan.service');
    mockVirusScan = {
      scanBeforeUpload: vi.fn().mockResolvedValue({
        success: true,
        result: {
          fileId: 'scan-1',
          fileHash: 'hash-1',
          status: SCAN_STATUS.CLEAN,
          scannedAt: '2026-06-06T00:00:00.000Z',
          scanner: 'test',
        },
      }),
      createScanMetadata: vi.fn(() => ({ fileId: 'scan-1', scanStatus: SCAN_STATUS.CLEAN, lastScannedAt: '2026-06-06T00:00:00.000Z', fileHash: 'hash-1', scanHistory: [] })),
      checkBeforeDownload: vi.fn().mockResolvedValue({ success: true }),
    };

    const destroyCallbacks: Array<() => void> = [];
    const injector = Injector.create({
      providers: [
        { provide: AttachmentService, useClass: AttachmentService },
        { provide: SupabaseClientService, useValue: { client: null, getClient: vi.fn(() => null) } },
        { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
        { provide: FileTypeValidatorService, useValue: { validate: vi.fn().mockReturnValue({ ok: true }), validateFile: vi.fn().mockResolvedValue({ valid: true }) } },
        { provide: VirusScanService, useValue: mockVirusScan },
        { provide: ActionQueueService, useValue: { enqueueDurably: vi.fn().mockResolvedValue('queued') } },
        { provide: AttachmentUploadOutboxService, useValue: { savePendingUpload: vi.fn().mockResolvedValue(undefined) } },
        { provide: AttachmentCleanupOutboxService, useValue: { enqueuePaths: vi.fn().mockResolvedValue([]), removePendingCleanups: vi.fn() } },
        {
          provide: DestroyRef,
          useValue: { onDestroy: vi.fn((callback: () => void) => { destroyCallbacks.push(callback); }) },
        },
      ],
    });

    service = injector.get(AttachmentService);
    let destroyed = false;
    destroyService = () => {
      if (destroyed) return;
      destroyed = true;
      for (const callback of destroyCallbacks.splice(0)) callback();
      (injector as Injector & { destroy: () => void }).destroy();
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('service construction', () => {
    it('requires VirusScanService because upload flow fails closed through scan RPCs', async () => {
      const { FileTypeValidatorService } = await import('./file-type-validator.service');
      const { VirusScanService } = await import('./virus-scan.service');

      const injector = Injector.create({
        providers: [
          { provide: AttachmentService, useClass: AttachmentService },
          { provide: SupabaseClientService, useValue: { client: null, getClient: vi.fn(() => null) } },
          { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
          { provide: FileTypeValidatorService, useValue: { validateFile: vi.fn().mockResolvedValue({ valid: true }) } },
          { provide: VirusScanService, useValue: mockVirusScan },
          { provide: ActionQueueService, useValue: { enqueueDurably: vi.fn().mockResolvedValue('queued') } },
          { provide: AttachmentUploadOutboxService, useValue: { savePendingUpload: vi.fn().mockResolvedValue(undefined) } },
          { provide: AttachmentCleanupOutboxService, useValue: { enqueuePaths: vi.fn().mockResolvedValue([]), removePendingCleanups: vi.fn() } },
          { provide: DestroyRef, useValue: { onDestroy: vi.fn() } },
        ],
      });

      expect(() => injector.get(AttachmentService)).not.toThrow();
    });
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

  describe('URL refresh monitor lifecycle', () => {
    it('已有数值为 0 的 URL 刷新句柄时不应重复启动', () => {
      const privateService = service as unknown as AttachmentServicePrivate;
      if (privateService.urlRefreshTimer !== null) {
        clearInterval(privateService.urlRefreshTimer);
      }
      privateService.urlRefreshTimer = 0 as unknown as ReturnType<typeof setInterval>;
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

      privateService.startUrlRefreshMonitor();

      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(privateService.urlRefreshTimer).toBe(0);
    });

    it('停止时应清理数值为 0 的 URL 刷新句柄', () => {
      const privateService = service as unknown as AttachmentServicePrivate;
      if (privateService.urlRefreshTimer !== null) {
        clearInterval(privateService.urlRefreshTimer);
      }
      privateService.urlRefreshTimer = 0 as unknown as ReturnType<typeof setInterval>;
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

      privateService.stopUrlRefreshMonitor();

      expect(clearIntervalSpy).toHaveBeenCalledWith(0);
      expect(privateService.urlRefreshTimer).toBeNull();
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
    it('无 Supabase 客户端时仍先返回本地附件并持久化上传 outbox', async () => {
      const enqueueDurably = vi.fn().mockResolvedValue('queued-attachment-upload');
      const savePendingUpload = vi.fn().mockResolvedValue(undefined);
      const removePendingUpload = vi.fn().mockResolvedValue(undefined);
      const { FileTypeValidatorService } = await import('./file-type-validator.service');
      const { VirusScanService } = await import('./virus-scan.service');
      const injector = Injector.create({
        providers: [
          { provide: AttachmentService, useClass: AttachmentService },
          { provide: SupabaseClientService, useValue: { isConfigured: false, client: vi.fn(() => null) } },
          { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
          { provide: FileTypeValidatorService, useValue: { validateFile: vi.fn().mockResolvedValue({ valid: true }) } },
          { provide: VirusScanService, useValue: mockVirusScan },
          { provide: ActionQueueService, useValue: { enqueueDurably } },
          { provide: AttachmentUploadOutboxService, useValue: { savePendingUpload, removePendingUpload } },
          { provide: AttachmentCleanupOutboxService, useValue: { enqueuePaths: vi.fn().mockResolvedValue([]), removePendingCleanups: vi.fn() } },
          { provide: DestroyRef, useValue: { onDestroy: vi.fn() } },
        ],
      });
      const uploadService = injector.get(AttachmentService);
      const file = new File(['test'], 'test.txt', { type: 'text/plain' });
      const result = await uploadService.uploadFile('user1', 'proj1', 'task1', file);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.attachment.url).toBe(`nanoflow-local-attachment://${result.attachment.id}`);
      expect(result.attachment.scanMetadata?.scanStatus).toBe(SCAN_STATUS.PENDING);
      expect(mockVirusScan.scanBeforeUpload).not.toHaveBeenCalled();
      expect(savePendingUpload).toHaveBeenCalledWith(expect.objectContaining({
        attachmentId: result.attachment.id,
        blobKey: result.attachment.id,
        blob: file,
      }));
      expect(enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
        type: 'create',
        entityType: 'attachment',
        entityId: result.attachment.id,
        payload: expect.objectContaining({
          attachment: result.attachment,
          blobKey: result.attachment.id,
          fileName: 'test.txt',
          mimeType: 'text/plain',
          sourceUserId: 'user1',
          taskId: 'task1',
          projectId: 'proj1',
        }),
      }));
    });

    it('导入 override 会贯通 attachmentId、operationId 和 owner-scoped queue', async () => {
      const { FileTypeValidatorService } = await import('./file-type-validator.service');
      const { VirusScanService } = await import('./virus-scan.service');
      const enqueueDurablyForOwner = vi.fn().mockResolvedValue('queued-import');
      const enqueueDurably = vi.fn();
      const savePendingUpload = vi.fn().mockResolvedValue(undefined);
      const removePendingUpload = vi.fn().mockResolvedValue(undefined);
      const injector = Injector.create({
        providers: [
          { provide: AttachmentService, useClass: AttachmentService },
          { provide: SupabaseClientService, useValue: { isConfigured: false, client: vi.fn(() => null) } },
          { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
          { provide: FileTypeValidatorService, useValue: { validateFile: vi.fn().mockResolvedValue({ valid: true }) } },
          { provide: VirusScanService, useValue: mockVirusScan },
          { provide: ActionQueueService, useValue: { enqueueDurably, enqueueDurablyForOwner } },
          { provide: AttachmentUploadOutboxService, useValue: { savePendingUpload, removePendingUpload } },
          { provide: AttachmentCleanupOutboxService, useValue: { enqueuePaths: vi.fn().mockResolvedValue([]), removePendingCleanups: vi.fn() } },
          { provide: DestroyRef, useValue: { onDestroy: vi.fn() } },
        ],
      });
      const uploadService = injector.get(AttachmentService);
      const result = await uploadService.uploadFile(
        'user1',
        'proj1',
        'task1',
        new File(['test'], 'test.txt', { type: 'text/plain' }),
        { attachmentId: 'import-attachment-1', operationId: 'attachment-import:package:0:import-attachment-1' },
      );

      expect(result.success).toBe(true);
      expect(savePendingUpload).toHaveBeenCalledWith(expect.objectContaining({
        attachmentId: 'import-attachment-1',
        blobKey: 'import-attachment-1',
        operationId: 'attachment-import:package:0:import-attachment-1',
      }));
      expect(enqueueDurablyForOwner).toHaveBeenCalledWith('user1', expect.objectContaining({
        operationId: 'attachment-import:package:0:import-attachment-1',
      }));
      expect(enqueueDurably).not.toHaveBeenCalled();
    });

    it('扫描服务离线时先返回本地附件并持久化上传 outbox', async () => {
      const { FileTypeValidatorService } = await import('./file-type-validator.service');
      const { VirusScanService } = await import('./virus-scan.service');
      const enqueueDurably = vi.fn().mockResolvedValue('queued-attachment-upload');
      const savePendingUpload = vi.fn().mockResolvedValue(undefined);
      const removePendingUpload = vi.fn().mockResolvedValue(undefined);
      mockVirusScan.scanBeforeUpload.mockResolvedValueOnce({
        success: false,
        error: '未连接到服务',
        errorCode: 'SERVICE_UNAVAILABLE',
      });
      const client = vi.fn(() => null);
      const injector = Injector.create({
        providers: [
          { provide: AttachmentService, useClass: AttachmentService },
          { provide: SupabaseClientService, useValue: { isConfigured: true, client } },
          { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
          { provide: FileTypeValidatorService, useValue: { validateFile: vi.fn().mockResolvedValue({ valid: true }) } },
          { provide: VirusScanService, useValue: mockVirusScan },
          { provide: ActionQueueService, useValue: { enqueueDurably } },
          { provide: AttachmentUploadOutboxService, useValue: { savePendingUpload, removePendingUpload } },
          { provide: AttachmentCleanupOutboxService, useValue: { enqueuePaths: vi.fn().mockResolvedValue([]), removePendingCleanups: vi.fn() } },
          { provide: DestroyRef, useValue: { onDestroy: vi.fn() } },
        ],
      });
      const uploadService = injector.get(AttachmentService);
      const file = new File(['offline'], 'offline.txt', { type: 'text/plain' });

      const result = await uploadService.uploadFile('user1', 'proj1', 'task1', file);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.attachment.url).toBe(`nanoflow-local-attachment://${result.attachment.id}`);
      expect(result.attachment.scanMetadata?.scanStatus).toBe(SCAN_STATUS.PENDING);
      expect(savePendingUpload).toHaveBeenCalledWith(expect.objectContaining({
        attachmentId: result.attachment.id,
        blobKey: result.attachment.id,
        blob: file,
      }));
      expect(enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
        type: 'create',
        entityType: 'attachment',
        entityId: result.attachment.id,
        payload: expect.objectContaining({
          attachment: result.attachment,
          blobKey: result.attachment.id,
          fileName: 'offline.txt',
          mimeType: 'text/plain',
          sourceUserId: 'user1',
          taskId: 'task1',
          projectId: 'proj1',
        }),
      }));
    });

    it('扫描通过时也应先返回本地附件并持久化上传 outbox 而不前台上传 Storage', async () => {
      const { FileTypeValidatorService } = await import('./file-type-validator.service');
      const { VirusScanService } = await import('./virus-scan.service');
      const enqueueDurably = vi.fn().mockResolvedValue('queued-attachment-upload');
      const savePendingUpload = vi.fn().mockResolvedValue(undefined);
      const removePendingUpload = vi.fn().mockResolvedValue(undefined);
      const upload = vi.fn().mockResolvedValue({ data: { path: 'uploaded' }, error: null });
      const storage = { from: vi.fn(() => ({ upload })) };
      const client = vi.fn(() => ({ storage }));
      const injector = Injector.create({
        providers: [
          { provide: AttachmentService, useClass: AttachmentService },
          { provide: SupabaseClientService, useValue: { isConfigured: true, client } },
          { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
          { provide: FileTypeValidatorService, useValue: { validateFile: vi.fn().mockResolvedValue({ valid: true }) } },
          { provide: VirusScanService, useValue: mockVirusScan },
          { provide: ActionQueueService, useValue: { enqueueDurably } },
          { provide: AttachmentUploadOutboxService, useValue: { savePendingUpload, removePendingUpload } },
          { provide: AttachmentCleanupOutboxService, useValue: { enqueuePaths: vi.fn().mockResolvedValue([]), removePendingCleanups: vi.fn() } },
          { provide: DestroyRef, useValue: { onDestroy: vi.fn() } },
        ],
      });
      const uploadService = injector.get(AttachmentService);
      const file = new File(['clean'], 'clean.txt', { type: 'text/plain' });

      const result = await uploadService.uploadFile('user1', 'proj1', 'task1', file);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.attachment.url).toBe(`nanoflow-local-attachment://${result.attachment.id}`);
      expect(result.attachment.scanMetadata?.scanStatus).toBe(SCAN_STATUS.CLEAN);
      expect(savePendingUpload).toHaveBeenCalledWith(expect.objectContaining({
        attachmentId: result.attachment.id,
        blobKey: result.attachment.id,
        blob: file,
      }));
      expect(enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
        type: 'create',
        entityType: 'attachment',
        entityId: result.attachment.id,
        payload: expect.objectContaining({
          attachment: result.attachment,
          blobKey: result.attachment.id,
          fileName: 'clean.txt',
          mimeType: 'text/plain',
          sourceUserId: 'user1',
          taskId: 'task1',
          projectId: 'proj1',
        }),
      }));
      expect(upload).not.toHaveBeenCalled();
    });

    it('扫描服务离线但附件创建未 durable 入队时应清理 pending blob 并返回失败', async () => {
      const { FileTypeValidatorService } = await import('./file-type-validator.service');
      const { VirusScanService } = await import('./virus-scan.service');
      const enqueueDurably = vi.fn().mockResolvedValue('');
      const savePendingUpload = vi.fn().mockResolvedValue(undefined);
      const removePendingUpload = vi.fn().mockResolvedValue(undefined);
      mockVirusScan.scanBeforeUpload.mockResolvedValueOnce({
        success: false,
        error: '未连接到服务',
        errorCode: 'SERVICE_UNAVAILABLE',
      });
      const client = vi.fn(() => null);
      const injector = Injector.create({
        providers: [
          { provide: AttachmentService, useClass: AttachmentService },
          { provide: SupabaseClientService, useValue: { isConfigured: true, client } },
          { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
          { provide: FileTypeValidatorService, useValue: { validateFile: vi.fn().mockResolvedValue({ valid: true }) } },
          { provide: VirusScanService, useValue: mockVirusScan },
          { provide: ActionQueueService, useValue: { enqueueDurably } },
          { provide: AttachmentUploadOutboxService, useValue: { savePendingUpload, removePendingUpload } },
          { provide: AttachmentCleanupOutboxService, useValue: { enqueuePaths: vi.fn().mockResolvedValue([]), removePendingCleanups: vi.fn() } },
          { provide: DestroyRef, useValue: { onDestroy: vi.fn() } },
        ],
      });
      const uploadService = injector.get(AttachmentService);
      const file = new File(['offline'], 'offline.txt', { type: 'text/plain' });

      const result = await uploadService.uploadFile('user1', 'proj1', 'task1', file);

      expect(result).toEqual({
        success: false,
        error: '附件上传队列持久化失败',
      });
      expect(savePendingUpload).toHaveBeenCalled();
      expect(enqueueDurably).toHaveBeenCalled();
      expect(removePendingUpload).toHaveBeenCalled();
    });

    it('后台上传生成签名 URL 失败时应清理已上传对象并返回失败', async () => {
      const { FileTypeValidatorService } = await import('./file-type-validator.service');
      const { VirusScanService } = await import('./virus-scan.service');
      const upload = vi.fn().mockResolvedValue({ data: { path: 'uploaded' }, error: null });
      const createSignedUrl = vi.fn().mockResolvedValue({
        data: null,
        error: new Error('signed url failed'),
      });
      const remove = vi.fn().mockResolvedValue({ data: [], error: null });
      const bucket = { upload, createSignedUrl, remove };
      const storage = {
        from: vi.fn(() => bucket),
      };
      const client = vi.fn(() => ({ storage }));
      const injector = Injector.create({
        providers: [
          { provide: AttachmentService, useClass: AttachmentService },
          { provide: SupabaseClientService, useValue: { isConfigured: true, client } },
          { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
          { provide: FileTypeValidatorService, useValue: { validateFile: vi.fn().mockResolvedValue({ valid: true }) } },
          { provide: VirusScanService, useValue: mockVirusScan },
          { provide: ActionQueueService, useValue: { enqueueDurably: vi.fn().mockResolvedValue('queued') } },
          { provide: AttachmentUploadOutboxService, useValue: { savePendingUpload: vi.fn().mockResolvedValue(undefined) } },
          { provide: AttachmentCleanupOutboxService, useValue: { enqueuePaths: vi.fn().mockResolvedValue([]), removePendingCleanups: vi.fn() } },
          { provide: DestroyRef, useValue: { onDestroy: vi.fn() } },
        ],
      });
      const uploadService = injector.get(AttachmentService);

      await expect(uploadService.uploadQueuedAttachment({
        attachment: {
          id: 'attachment-1',
          type: 'document',
          name: 'test.txt',
          url: 'nanoflow-local-attachment://attachment-1',
          createdAt: '2026-06-01T00:00:00.000Z',
        },
        blobKey: 'attachment-1',
        fileName: 'test.txt',
        mimeType: 'text/plain',
        projectId: 'proj1',
        taskId: 'task1',
        userId: 'user1',
        sourceUserId: 'user1',
      }, new Blob(['test'], { type: 'text/plain' }))).rejects.toBeTruthy();
      expect(remove).toHaveBeenCalledWith([
        'user1/proj1/task1/attachment-1.txt',
      ]);
    });

    it('后台重放遇到同一路径对象已存在时应继续生成签名 URL 并返回已上传附件', async () => {
      const { FileTypeValidatorService } = await import('./file-type-validator.service');
      const { VirusScanService } = await import('./virus-scan.service');
      const duplicateObjectError = {
        statusCode: '409',
        code: 'ResourceAlreadyExists',
        message: 'The resource already exists',
      };
      const upload = vi.fn().mockResolvedValue({ data: null, error: duplicateObjectError });
      const createSignedUrl = vi.fn().mockResolvedValue({
        data: { signedUrl: 'https://example.test/signed/attachment-1' },
        error: null,
      });
      const remove = vi.fn().mockResolvedValue({ data: [], error: null });
      const bucket = { upload, createSignedUrl, remove };
      const storage = {
        from: vi.fn(() => bucket),
      };
      const client = vi.fn(() => ({ storage }));
      const injector = Injector.create({
        providers: [
          { provide: AttachmentService, useClass: AttachmentService },
          { provide: SupabaseClientService, useValue: { isConfigured: true, client } },
          { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
          { provide: FileTypeValidatorService, useValue: { validateFile: vi.fn().mockResolvedValue({ valid: true }) } },
          { provide: VirusScanService, useValue: mockVirusScan },
          { provide: ActionQueueService, useValue: { enqueueDurably: vi.fn().mockResolvedValue('queued') } },
          { provide: AttachmentUploadOutboxService, useValue: { savePendingUpload: vi.fn().mockResolvedValue(undefined) } },
          { provide: AttachmentCleanupOutboxService, useValue: { enqueuePaths: vi.fn().mockResolvedValue([]), removePendingCleanups: vi.fn() } },
          { provide: DestroyRef, useValue: { onDestroy: vi.fn() } },
        ],
      });
      const uploadService = injector.get(AttachmentService);

      const attachment = await uploadService.uploadQueuedAttachment({
        attachment: {
          id: 'attachment-1',
          type: 'document',
          name: 'test.txt',
          url: 'nanoflow-local-attachment://attachment-1',
          createdAt: '2026-06-01T00:00:00.000Z',
        },
        blobKey: 'attachment-1',
        fileName: 'test.txt',
        mimeType: 'text/plain',
        projectId: 'proj1',
        taskId: 'task1',
        userId: 'user1',
        sourceUserId: 'user1',
      }, new Blob(['test'], { type: 'text/plain' }));

      expect(upload).toHaveBeenCalledWith(
        'user1/proj1/task1/attachment-1.txt',
        expect.any(File),
        expect.objectContaining({ upsert: false }),
      );
      expect(attachment.id).toBe('attachment-1');
      expect(attachment.url).toBe('https://example.test/signed/attachment-1');
      expect(attachment.createdAt).toBe('2026-06-01T00:00:00.000Z');
      expect(createSignedUrl).toHaveBeenCalledWith('user1/proj1/task1/attachment-1.txt', expect.any(Number));
      expect(remove).not.toHaveBeenCalled();
    });

    it.each<QueuedAttachmentUploadBarrier>([
      'scan',
      'upload',
      'signed-url',
      'thumbnail-url',
    ])('后台队列 lease 在 %s 阶段失效时不发布用户取消清理', async barrier => {
      const harness = createQueuedAttachmentUploadBarrierHarness(barrier);
      const controller = new AbortController();
      const processing = harness.service.uploadQueuedAttachment(
        harness.payload,
        new Blob(['image'], { type: 'image/png' }),
        {
          signal: controller.signal,
          isCurrent: () => !controller.signal.aborted,
        },
      );
      await vi.waitFor(() => expect(harness.reachedBarrier).toHaveBeenCalledWith(barrier));
      controller.abort();
      harness.releaseBarrier();
      await expect(processing).rejects.toMatchObject({ name: 'AbortError' });
      expect(harness.remove).not.toHaveBeenCalled();
    });
  });

  describe('storage cleanup outbox', () => {
    async function createStorageCleanupService(options: {
      removeResult?: { data: unknown; error: { message?: string } | null };
      removeRejects?: Error;
    } = {}): Promise<{
      cleanupService: AttachmentService;
      enqueuePaths: ReturnType<typeof vi.fn>;
      removePendingCleanups: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
      events: string[];
    }> {
      const { FileTypeValidatorService } = await import('./file-type-validator.service');
      const { VirusScanService } = await import('./virus-scan.service');
      const events: string[] = [];
      const enqueuePaths = vi.fn(async (paths: string[], options: { ownerUserId: string }) => {
        events.push('enqueue');
        return paths.map((path, index) => ({
          ownerUserId: options.ownerUserId,
          path,
          operationId: `cleanup-operation-${index + 1}`,
        }));
      });
      const removePendingCleanups = vi.fn(async () => {
        events.push('remove-pending');
      });
      const remove = options.removeRejects
        ? vi.fn(async () => {
          events.push('remote-remove');
          throw options.removeRejects;
        })
        : vi.fn(async () => {
          events.push('remote-remove');
          return options.removeResult ?? { data: [], error: null };
        });
      const storage = { from: vi.fn(() => ({ remove })) };
      const client = vi.fn(() => ({ storage }));
      const injector = Injector.create({
        providers: [
          { provide: AttachmentService, useClass: AttachmentService },
          { provide: SupabaseClientService, useValue: { isConfigured: true, client } },
          { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
          { provide: FileTypeValidatorService, useValue: { validateFile: vi.fn().mockResolvedValue({ valid: true }) } },
          { provide: VirusScanService, useValue: mockVirusScan },
          { provide: ActionQueueService, useValue: { enqueueDurably: vi.fn().mockResolvedValue('queued') } },
          { provide: AttachmentUploadOutboxService, useValue: { savePendingUpload: vi.fn().mockResolvedValue(undefined) } },
          {
            provide: AttachmentCleanupOutboxService,
            useValue: { enqueuePaths, removePendingCleanups },
          },
          { provide: DestroyRef, useValue: { onDestroy: vi.fn() } },
        ],
      });

      return {
        cleanupService: injector.get(AttachmentService),
        enqueuePaths,
        removePendingCleanups,
        remove,
        events,
      };
    }

    it('deleteFile 先持久化 cleanup outbox，远端删除成功后才清除待处理记录', async () => {
      const { cleanupService, enqueuePaths, removePendingCleanups, remove, events } =
        await createStorageCleanupService();

      const result = await cleanupService.deleteFile(
        'user1',
        'proj1',
        'task1',
        'attachment-1',
        'txt',
      );

      expect(result).toEqual({ success: true });
      expect(events).toEqual(['enqueue', 'remote-remove', 'remove-pending']);
      expect(enqueuePaths).toHaveBeenCalledWith(
        ['user1/proj1/task1/attachment-1.txt'],
        { ownerUserId: 'user1' },
      );
      expect(remove).toHaveBeenCalledWith(['user1/proj1/task1/attachment-1.txt']);
      expect(removePendingCleanups).toHaveBeenCalledWith([{
        ownerUserId: 'user1',
        path: 'user1/proj1/task1/attachment-1.txt',
        operationId: 'cleanup-operation-1',
      }]);
    });

    it('deleteFiles 远端删除失败时保留 cleanup outbox 待恢复，不清除本地记录', async () => {
      const { cleanupService, enqueuePaths, removePendingCleanups, remove, events } =
        await createStorageCleanupService({
          removeResult: { data: null, error: { message: 'storage timeout' } },
        });

      const result = await cleanupService.deleteFiles('user1', [
        'user1/proj1/task1/attachment-a.png',
        'user1/proj1/task1/attachment-b.png',
      ]);

      expect(result).toEqual({
        success: false,
        deletedCount: 0,
        errors: ['批次 1: storage timeout'],
      });
      expect(events).toEqual(['enqueue', 'remote-remove']);
      expect(enqueuePaths).toHaveBeenCalledWith(
        [
          'user1/proj1/task1/attachment-a.png',
          'user1/proj1/task1/attachment-b.png',
        ],
        { ownerUserId: 'user1' },
      );
      expect(remove).toHaveBeenCalledWith([
        'user1/proj1/task1/attachment-a.png',
        'user1/proj1/task1/attachment-b.png',
      ]);
      expect(removePendingCleanups).not.toHaveBeenCalled();
    });
  });

  describe('downloadFile', () => {
    async function createDownloadService(options?: {
      scanResult?: { success: boolean; error?: string };
    }): Promise<{
      downloadService: AttachmentService;
      download: ReturnType<typeof vi.fn>;
    }> {
      const { FileTypeValidatorService } = await import('./file-type-validator.service');
      const { VirusScanService } = await import('./virus-scan.service');
      const download = vi.fn().mockResolvedValue({ data: new Blob(['safe']), error: null });
      const storage = { from: vi.fn(() => ({ download })) };
      const client = vi.fn(() => ({ storage }));
      mockVirusScan.checkBeforeDownload.mockResolvedValue(options?.scanResult ?? { success: true });

      const injector = Injector.create({
        providers: [
          { provide: AttachmentService, useClass: AttachmentService },
          { provide: SupabaseClientService, useValue: { isConfigured: true, client } },
          { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
          { provide: FileTypeValidatorService, useValue: { validateFile: vi.fn().mockResolvedValue({ valid: true }) } },
          { provide: VirusScanService, useValue: mockVirusScan },
          { provide: ActionQueueService, useValue: { enqueueDurably: vi.fn().mockResolvedValue('queued') } },
          { provide: AttachmentUploadOutboxService, useValue: { savePendingUpload: vi.fn().mockResolvedValue(undefined) } },
          { provide: AttachmentCleanupOutboxService, useValue: { enqueuePaths: vi.fn().mockResolvedValue([]), removePendingCleanups: vi.fn() } },
          { provide: DestroyRef, useValue: { onDestroy: vi.fn() } },
        ],
      });

      return {
        downloadService: injector.get(AttachmentService),
        download,
      };
    }

    it('下载存储文件前使用扫描 fileId 和 hash 做安全检查', async () => {
      const { downloadService, download } = await createDownloadService();
      const attachment: Attachment = {
        id: 'att-1',
        type: 'file',
        name: 'safe.pdf',
        url: 'https://example.com/safe.pdf',
        createdAt: new Date().toISOString(),
        scanMetadata: {
          fileId: 'scan-file-1',
          fileHash: 'hash-1',
          scanStatus: SCAN_STATUS.CLEAN,
        },
      };

      const result = await downloadService.downloadFile('user1', 'proj1', 'task1', attachment);

      expect(result).toBeInstanceOf(Blob);
      expect(mockVirusScan.checkBeforeDownload).toHaveBeenCalledWith('scan-file-1', 'hash-1');
      expect(download).toHaveBeenCalledTimes(1);
    });

    it('安全检查失败时拒绝下载且不读取 Storage', async () => {
      const { downloadService, download } = await createDownloadService({
        scanResult: { success: false, error: 'threat detected' },
      });
      const attachment: Attachment = {
        id: 'att-1',
        type: 'file',
        name: 'unsafe.pdf',
        url: 'https://example.com/unsafe.pdf',
        createdAt: new Date().toISOString(),
        scanMetadata: {
          fileId: 'scan-file-1',
          fileHash: 'hash-1',
          scanStatus: SCAN_STATUS.CLEAN,
        },
      };

      const result = await downloadService.downloadFile('user1', 'proj1', 'task1', attachment);

      expect(result).toBeNull();
      expect(download).not.toHaveBeenCalled();
    });

    it('允许通过本地安全 MIME 校验而 skipped 的图片下载且不查询服务端扫描状态', async () => {
      const { downloadService, download } = await createDownloadService();
      const attachment: Attachment = {
        id: 'att-safe-image',
        type: 'image',
        name: 'safe.png',
        url: 'https://example.com/safe.png',
        mimeType: 'image/png',
        createdAt: new Date().toISOString(),
        scanMetadata: {
          scanStatus: SCAN_STATUS.SKIPPED,
          lastScannedAt: '2026-06-06T00:00:00.000Z',
          scanHistory: [
            {
              scannedAt: '2026-06-06T00:00:00.000Z',
              status: SCAN_STATUS.SKIPPED,
              scanner: 'local',
            },
          ],
        },
      };

      const result = await downloadService.downloadFile('user1', 'proj1', 'task1', attachment);

      expect(result).toBeInstanceOf(Blob);
      expect(mockVirusScan.checkBeforeDownload).not.toHaveBeenCalled();
      expect(download).toHaveBeenCalledTimes(1);
    });
  });

  registerAttachmentServiceUrlRefreshRaceSpecs({
    service: () => service,
    destroy: () => destroyService(),
    loggerWarn: mockLoggerCategory.warn,
  });
});
