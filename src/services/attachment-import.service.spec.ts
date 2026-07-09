/**
 * AttachmentImportService 单元测试
 * 
 * 测试模式：Injector 隔离模式（无 effect() 依赖）
 * 
 * 覆盖场景：
 * - 配额检查
 * - 批量导入
 * - 并发控制
 * - 错误处理
 * - 取消操作
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { 
  AttachmentImportService, 
  AttachmentImportItem,
  ATTACHMENT_IMPORT_CONFIG 
} from './attachment-import.service';
import { AttachmentService } from './attachment.service';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { SupabaseClientService } from './supabase-client.service';
import { TaskOperationAdapterService } from './task-operation-adapter.service';
import { parseZipEntries, type ParseZipEntriesOptions } from './attachment-import-zip.helpers';

describe('AttachmentImportService', () => {
  let service: AttachmentImportService;
  let mockAttachmentService: {
    uploadFile: ReturnType<typeof vi.fn>;
  };
  let mockAuthService: {
    currentUserId: ReturnType<typeof vi.fn>;
  };
  let mockToastService: {
    error: ReturnType<typeof vi.fn>;
    warning: ReturnType<typeof vi.fn>;
  };
  let mockSupabaseClientService: {
    isConfigured: boolean;
    client: ReturnType<typeof vi.fn>;
  };
  let mockTaskOpsAdapter: {
    addTaskAttachment: ReturnType<typeof vi.fn>;
    addTaskAttachmentToProject: ReturnType<typeof vi.fn>;
  };
  
  const mockLogger = {
    category: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
  
  beforeEach(() => {
    vi.clearAllMocks();
    
    mockAttachmentService = {
      uploadFile: vi.fn().mockResolvedValue({
        success: true,
        attachment: {
          id: 'att-1',
          name: 'test.png',
          type: 'image',
          url: 'https://example.com/test.png',
          mimeType: 'image/png',
          size: 1024,
          createdAt: new Date().toISOString(),
        },
      }),
    };
    
    mockAuthService = {
      currentUserId: vi.fn().mockReturnValue('user-1'),
    };
    
    mockToastService = {
      error: vi.fn(),
      warning: vi.fn(),
    };

    mockSupabaseClientService = {
      isConfigured: false,
      client: vi.fn(),
    };

    mockTaskOpsAdapter = {
      addTaskAttachment: vi.fn(),
      addTaskAttachmentToProject: vi.fn(() => true),
    };
    
    const injector = Injector.create({
      providers: [
        { provide: AttachmentService, useValue: mockAttachmentService },
        { provide: AuthService, useValue: mockAuthService },
        { provide: ToastService, useValue: mockToastService },
        { provide: LoggerService, useValue: mockLogger },
        { provide: SupabaseClientService, useValue: mockSupabaseClientService },
        { provide: TaskOperationAdapterService, useValue: mockTaskOpsAdapter },
      ],
    });
    
    service = runInInjectionContext(injector, () => new AttachmentImportService());
  });
  
  afterEach(() => {
    service.resetProgress();
  });
  
  describe('importAttachments', () => {
    it('未登录时应返回失败', async () => {
      mockAuthService.currentUserId.mockReturnValue(null);
      
      const result = await service.importAttachments('project-1', []);
      
      expect(result.success).toBe(false);
      expect(result.errors[0].error).toContain('未登录');
    });
    
    it('空列表应返回成功', async () => {
      const result = await service.importAttachments('project-1', []);
      
      expect(result.success).toBe(true);
      expect(result.imported).toBe(0);
    });
    
    it('无有效数据的项应被跳过', async () => {
      const items: AttachmentImportItem[] = [
        {
          taskId: 'task-1',
          metadata: { id: 'att-1', name: 'test.png', size: 1024, mimeType: 'image/png' },
          // 没有 data
        },
      ];
      
      const result = await service.importAttachments('project-1', items);
      
      expect(result.success).toBe(true);
      expect(result.skipped).toBe(1);
      expect(result.imported).toBe(0);
    });
    
    it('有效项应该被上传', async () => {
      const items: AttachmentImportItem[] = [
        {
          taskId: 'task-1',
          metadata: { id: 'att-1', name: 'test.png', size: 1024, mimeType: 'image/png' },
          data: new Blob(['test data'], { type: 'image/png' }),
        },
      ];
      
      const result = await service.importAttachments('project-1', items);
      
      expect(result.success).toBe(true);
      expect(result.imported).toBe(1);
      expect(mockAttachmentService.uploadFile).toHaveBeenCalledWith(
        'user-1',
        'project-1',
        'task-1',
        expect.any(File)
      );
      expect(mockTaskOpsAdapter.addTaskAttachmentToProject).toHaveBeenCalledWith(
        'project-1',
        'task-1',
        expect.objectContaining({ id: 'att-1' })
      );
    });

    it('条目带有项目 ID 时应上传到该项目而不是导入入口项目', async () => {
      const items: AttachmentImportItem[] = [
        {
          projectId: 'project-a',
          taskId: 'task-a',
          metadata: { id: 'att-a', name: 'a.txt', size: 4, mimeType: 'text/plain' },
          data: new Blob(['demo'], { type: 'text/plain' }),
        },
        {
          projectId: 'project-b',
          taskId: 'task-b',
          metadata: { id: 'att-b', name: 'b.txt', size: 4, mimeType: 'text/plain' },
          data: new Blob(['demo'], { type: 'text/plain' }),
        },
      ];

      const result = await service.importAttachments('fallback-project', items);

      expect(result.success).toBe(true);
      expect(mockAttachmentService.uploadFile).toHaveBeenCalledTimes(2);
      const uploadTargets = mockAttachmentService.uploadFile.mock.calls.map(([, projectId, taskId]) => ({
        projectId,
        taskId,
      }));
      expect(uploadTargets).toEqual(expect.arrayContaining([
        { projectId: 'project-a', taskId: 'task-a' },
        { projectId: 'project-b', taskId: 'task-b' },
      ]));
      expect(uploadTargets).not.toContainEqual({ projectId: 'fallback-project', taskId: 'task-a' });
      expect(uploadTargets).not.toContainEqual({ projectId: 'fallback-project', taskId: 'task-b' });
      expect(mockTaskOpsAdapter.addTaskAttachmentToProject).toHaveBeenCalledWith(
        'project-a',
        'task-a',
        expect.objectContaining({ name: 'a.txt' }),
      );
      expect(mockTaskOpsAdapter.addTaskAttachmentToProject).toHaveBeenCalledWith(
        'project-b',
        'task-b',
        expect.objectContaining({ name: 'b.txt' }),
      );
    });

    it('应保留上传生成的附件 ID，确保后续刷新/下载路径一致', async () => {
      mockAttachmentService.uploadFile.mockResolvedValue({
        success: true,
        attachment: {
          id: 'generated-upload-id',
          name: 'restored.txt',
          type: 'file',
          url: 'https://example.com/restored.txt',
          mimeType: 'text/plain',
          size: 4,
          createdAt: '2026-06-01T00:00:00.000Z',
        },
      });
      const items: AttachmentImportItem[] = [
        {
          projectId: 'project-1',
          taskId: 'task-1',
          metadata: { id: 'original-att-id', name: 'restored.txt', size: 4, mimeType: 'text/plain' },
          data: new Blob(['demo'], { type: 'text/plain' }),
        },
      ];

      const result = await service.importAttachments('project-1', items);

      expect(result.success).toBe(true);
      expect(mockTaskOpsAdapter.addTaskAttachmentToProject).toHaveBeenCalledWith(
        'project-1',
        'task-1',
        expect.objectContaining({
          id: 'generated-upload-id',
          url: 'https://example.com/restored.txt',
        }),
      );
    });

    it('目标任务不存在时应标记导入失败，而不是把上传成功计为成功', async () => {
      mockTaskOpsAdapter.addTaskAttachmentToProject.mockReturnValue(false);
      const items: AttachmentImportItem[] = [
        {
          projectId: 'project-1',
          taskId: 'missing-task',
          metadata: { id: 'att-1', name: 'missing.txt', size: 4, mimeType: 'text/plain' },
          data: new Blob(['demo'], { type: 'text/plain' }),
        },
      ];

      const result = await service.importAttachments('project-1', items);

      expect(result.success).toBe(false);
      expect(result.failed).toBe(1);
      expect(result.imported).toBe(0);
      expect(result.errors[0]).toEqual(expect.objectContaining({
        taskId: 'missing-task',
        error: expect.stringContaining('目标任务不存在'),
      }));
    });

    it('异步附件写入持久化失败时应标记导入失败', async () => {
      mockTaskOpsAdapter.addTaskAttachmentToProject.mockResolvedValue(false);
      const items: AttachmentImportItem[] = [
        {
          projectId: 'project-1',
          taskId: 'task-1',
          metadata: { id: 'att-1', name: 'durable-fail.txt', size: 4, mimeType: 'text/plain' },
          data: new Blob(['demo'], { type: 'text/plain' }),
        },
      ];

      const result = await service.importAttachments('project-1', items);

      expect(result.success).toBe(false);
      expect(result.failed).toBe(1);
      expect(result.imported).toBe(0);
      expect(result.errors[0]).toEqual(expect.objectContaining({
        taskId: 'task-1',
        error: expect.stringContaining('目标任务不存在'),
      }));
    });
    
    it('上传失败应记录错误', async () => {
      mockAttachmentService.uploadFile.mockResolvedValue({
        success: false,
        error: '上传失败',
      });
      
      const items: AttachmentImportItem[] = [
        {
          taskId: 'task-1',
          metadata: { id: 'att-1', name: 'test.png', size: 1024, mimeType: 'image/png' },
          data: new Blob(['test data'], { type: 'image/png' }),
        },
      ];
      
      const result = await service.importAttachments('project-1', items);
      
      expect(result.success).toBe(false);
      expect(result.failed).toBe(1);
      expect(result.errors[0].error).toBe('上传失败');
    });
    
    it('多个项应该分批处理', async () => {
      const items: AttachmentImportItem[] = Array.from({ length: 15 }, (_, i) => ({
        taskId: `task-${i}`,
        metadata: { id: `att-${i}`, name: `test-${i}.png`, size: 1024, mimeType: 'image/png' },
        data: new Blob(['test data'], { type: 'image/png' }),
      }));
      
      const result = await service.importAttachments('project-1', items);
      
      expect(result.success).toBe(true);
      expect(result.imported).toBe(15);
      expect(mockAttachmentService.uploadFile).toHaveBeenCalledTimes(15);
    });
  });
  
  describe('checkQuota', () => {
    it('小文件应该通过配额检查', async () => {
      const result = await service.checkQuota(1024);
      
      expect(result.hasQuota).toBe(true);
    });
    
    it('超大文件应该失败', async () => {
      // 请求 200MB（超过 100MB 默认限制）
      const result = await service.checkQuota(200 * 1024 * 1024);
      
      expect(result.hasQuota).toBe(false);
      expect(result.message).toContain('存储空间不足');
    });
  });

  describe('extractAttachmentsFromZip', () => {
    it('应从 manifest + ZIP 中提取附件数据', async () => {
      const manifest = {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        totalAttachments: 1,
        totalSize: 4,
        successCount: 1,
        failedCount: 0,
        skippedCount: 0,
        attachments: [
          {
            id: 'att-1',
            taskIds: ['task-1'],
            projectIds: ['project-1'],
            name: 'a.txt',
            mimeType: 'text/plain',
            size: 4,
            bundlePath: 'attachments/att-1.txt',
            downloadStatus: 'success',
          }
        ]
      };

      const zipData = createStoredZip([
        { path: 'manifest.json', text: JSON.stringify(manifest) },
        { path: 'attachments/att-1.txt', text: 'demo' },
      ]);

      const items = await service.extractAttachmentsFromZip(zipData, new Map());
      expect(items).toHaveLength(1);
      expect(items[0]?.projectId).toBe('project-1');
      expect(items[0]?.taskId).toBe('task-1');
      expect(items[0]?.metadata.name).toBe('a.txt');
      const content = await items[0]!.data!.text();
      expect(content).toBe('demo');
    });

    it('应按 manifest 中 taskIds 与 projectIds 的位置保留跨项目引用', async () => {
      const manifest = {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        totalAttachments: 1,
        totalSize: 4,
        successCount: 1,
        failedCount: 0,
        skippedCount: 0,
        attachments: [
          {
            id: 'att-shared',
            taskIds: ['task-a', 'task-b'],
            projectIds: ['project-a', 'project-b'],
            name: 'shared.txt',
            mimeType: 'text/plain',
            size: 4,
            bundlePath: 'attachments/att-shared.txt',
            downloadStatus: 'success',
          }
        ]
      };

      const zipData = createStoredZip([
        { path: 'manifest.json', text: JSON.stringify(manifest) },
        { path: 'attachments/att-shared.txt', text: 'demo' },
      ]);

      const items = await service.extractAttachmentsFromZip(zipData, new Map());

      expect(items).toHaveLength(2);
      expect(items.map(({ projectId, taskId }) => ({ projectId, taskId }))).toEqual([
        { projectId: 'project-a', taskId: 'task-a' },
        { projectId: 'project-b', taskId: 'task-b' },
      ]);
    });

    it('无 manifest 时应回退 taskAttachmentMap 路径匹配', async () => {
      const zipData = createStoredZip([
        { path: 'attachments/task-1/att-1.txt', text: 'fallback' },
      ]);
      const taskMap = new Map([
        ['task-1', [{ id: 'att-1', name: 'att-1.txt', size: 8, mimeType: 'text/plain' }]]
      ]);

      const items = await service.extractAttachmentsFromZip(zipData, taskMap);
      expect(items).toHaveLength(1);
      expect(items[0]?.taskId).toBe('task-1');
      expect(items[0]?.zipPath).toBe('attachments/task-1/att-1.txt');
    });

    it('应拒绝声明解压尺寸超过限制的 ZIP 条目', async () => {
      const manifest = {
        attachments: [
          {
            id: 'att-oversize',
            taskIds: ['task-1'],
            projectIds: ['project-1'],
            name: 'oversize.txt',
            mimeType: 'text/plain',
            size: ATTACHMENT_IMPORT_CONFIG.MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES + 1,
            bundlePath: 'attachments/att-oversize.txt',
            downloadStatus: 'success',
          }
        ]
      };
      const zipData = createStoredZip([
        { path: 'manifest.json', text: JSON.stringify(manifest) },
        {
          path: 'attachments/att-oversize.txt',
          text: 'x',
          declaredSize: ATTACHMENT_IMPORT_CONFIG.MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES + 1,
        },
      ]);

      await expect(service.extractAttachmentsFromZip(zipData, new Map()))
        .rejects.toThrow('ZIP 条目解压后大小超过限制');
    });

    it('应拒绝实际解压总大小超过限制的 ZIP，即使中心目录低报尺寸', async () => {
      const zipData = createStoredZip(
        Array.from({ length: 11 }, (_, index) => ({
          path: `attachments/att-${index}.txt`,
          text: 'x',
          declaredSize: 1,
        })),
      );
      const readZipEntryData = vi.fn().mockResolvedValue({
        data: { byteLength: ATTACHMENT_IMPORT_CONFIG.MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES } as Uint8Array,
        uncompressedSize: 1,
        compressionMethod: 0,
      });
      const options: ParseZipEntriesOptions = {
        limits: createZipLimits(),
        logger: mockLogger.category(),
        readZipEntryData,
      };

      await expect(parseZipEntries(zipData, options))
        .rejects.toThrow('ZIP 解压后总大小超过限制');
    });

    it('manifest 引用不安全 ZIP 路径时不应导入附件', async () => {
      const manifest = {
        attachments: [
          {
            id: 'att-escape',
            taskIds: ['task-1'],
            projectIds: ['project-1'],
            name: 'escape.txt',
            mimeType: 'text/plain',
            size: 4,
            bundlePath: '../escape.txt',
            downloadStatus: 'success',
          }
        ]
      };
      const zipData = createStoredZip([
        { path: 'manifest.json', text: JSON.stringify(manifest) },
        { path: '../escape.txt', text: 'demo' },
      ]);

      const items = await service.extractAttachmentsFromZip(zipData, new Map());

      expect(items).toHaveLength(0);
    });
  });
  
  describe('cancelImport', () => {
    it('取消应该中止正在进行的导入', async () => {
      vi.useFakeTimers();
      try {
        const items: AttachmentImportItem[] = Array.from({ length: 50 }, (_, i) => ({
          taskId: `task-${i}`,
          metadata: { id: `att-${i}`, name: `test-${i}.png`, size: 1024, mimeType: 'image/png' },
          data: new Blob(['test data'], { type: 'image/png' }),
        }));
        
        // 延迟上传以便有时间取消
        mockAttachmentService.uploadFile.mockImplementation(() => 
          new Promise(resolve => setTimeout(() => resolve({
            success: true,
            attachment: { id: 'att', name: 'test.png', type: 'image', url: '', mimeType: '', size: 0, createdAt: '' },
          }), 50))
        );
        
        // 开始导入
        const importPromise = service.importAttachments('project-1', items);
        
        // 快进一点时间然后取消
        await vi.advanceTimersByTimeAsync(100);
        service.cancelImport();
        
        // 完成所有剩余定时器
        await vi.runAllTimersAsync();
        const result = await importPromise;
        
        // 应该有一些项被处理，但不是全部
        expect(result.imported).toBeLessThan(50);
      } finally {
        vi.useRealTimers();
      }
    });
  });
  
  describe('progress', () => {
    it('初始状态应为 idle', () => {
      expect(service.progress().stage).toBe('idle');
      expect(service.progress().percentage).toBe(0);
    });
    
    it('导入过程中应更新进度', async () => {
      const items: AttachmentImportItem[] = [
        {
          taskId: 'task-1',
          metadata: { id: 'att-1', name: 'test.png', size: 1024, mimeType: 'image/png' },
          data: new Blob(['test data'], { type: 'image/png' }),
        },
      ];
      
      await service.importAttachments('project-1', items);
      
      // 完成后应该是 completed
      expect(service.progress().stage).toBe('completed');
      expect(service.progress().percentage).toBe(100);
    });
    
    it('resetProgress 应重置状态', async () => {
      const items: AttachmentImportItem[] = [
        {
          taskId: 'task-1',
          metadata: { id: 'att-1', name: 'test.png', size: 1024, mimeType: 'image/png' },
          data: new Blob(['test data'], { type: 'image/png' }),
        },
      ];
      
      await service.importAttachments('project-1', items);
      expect(service.progress().stage).toBe('completed');
      
      service.resetProgress();
      
      expect(service.progress().stage).toBe('idle');
      expect(service.progress().percentage).toBe(0);
    });
  });
});

function createZipLimits() {
  return {
    maxEntries: ATTACHMENT_IMPORT_CONFIG.MAX_ZIP_ENTRIES,
    maxEntryUncompressedBytes: ATTACHMENT_IMPORT_CONFIG.MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES,
    maxTotalUncompressedBytes: ATTACHMENT_IMPORT_CONFIG.MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES,
  };
}

function createStoredZip(files: Array<{ path: string; text: string; declaredSize?: number }>): ArrayBuffer {
  const encoder = new TextEncoder();
  const fileRecords: Array<{
    nameBytes: Uint8Array;
    dataBytes: Uint8Array;
    localHeader: Uint8Array;
    centralHeader: Uint8Array;
  }> = [];

  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.path);
    const dataBytes = encoder.encode(file.text);
    const declaredSize = file.declaredSize ?? dataBytes.length;
    const crc = crc32(dataBytes);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, dataBytes.length, true);
    lv.setUint32(22, declaredSize, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, dataBytes.length, true);
    cv.setUint32(24, declaredSize, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);

    localParts.push(localHeader, dataBytes);
    centralParts.push(centralHeader);
    fileRecords.push({ nameBytes, dataBytes, localHeader, centralHeader });
    offset += localHeader.length + dataBytes.length;
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const part of centralParts) {
    centralSize += part.length;
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, fileRecords.length, true);
  ev.setUint16(10, fileRecords.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);
  ev.setUint16(20, 0, true);

  const totalLength =
    localParts.reduce((sum, part) => sum + part.length, 0) +
    centralSize +
    eocd.length;

  const output = new Uint8Array(totalLength);
  let cursor = 0;

  for (const part of localParts) {
    output.set(part, cursor);
    cursor += part.length;
  }
  for (const part of centralParts) {
    output.set(part, cursor);
    cursor += part.length;
  }
  output.set(eocd, cursor);

  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
