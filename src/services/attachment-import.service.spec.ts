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
} from './attachment-import.service';
import { AttachmentService } from './attachment.service';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { SupabaseClientService } from './supabase-client.service';
import { TaskOperationAdapterService } from './task-operation-adapter.service';
import { ActionQueueService } from './action-queue.service';
import type { AttachmentUploadPayload, QueuedAction } from './action-queue.types';
import { AttachmentUploadOutboxService, type PendingAttachmentUploadIdentity } from './attachment-upload-outbox.service';
import { ProjectStateService } from './project-state.service';
import { registerAttachmentImportZipIntegritySpecs } from './attachment-import-zip-integrity.spec-helpers';

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
  let mockActionQueue: {
    pendingActions: ReturnType<typeof vi.fn>;
    dequeue: ReturnType<typeof vi.fn>;
    storage: { persistExactQueueMutationForOwner: ReturnType<typeof vi.fn> };
  };
  let mockUploadOutbox: { removePendingUpload: ReturnType<typeof vi.fn> };
  let targetProjects: Array<{ id: string; tasks: Array<{ id: string }> }>;
  let queuedActions: QueuedAction[];
  let persistedQueue: QueuedAction[];
  
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
        queuedUpload: {
          actionId: 'action-1',
          ownerUserId: 'user-1',
          blobKey: 'att-1',
          operationId: 'attachment:create:att-1',
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
    targetProjects = [
      { id: 'project-1', tasks: Array.from({ length: 15 }, (_, index) => ({ id: `task-${index}` })) },
      { id: 'project-a', tasks: [{ id: 'task-a' }] },
      { id: 'project-b', tasks: [{ id: 'task-b' }] },
    ];
    queuedActions = [];
    persistedQueue = [];
    mockActionQueue = {
      pendingActions: vi.fn(() => queuedActions),
      dequeue: vi.fn(),
      storage: {
        persistExactQueueMutationForOwner: vi.fn(async (
          _ownerUserId: string,
          updater: (queue: QueuedAction[]) => QueuedAction[],
        ) => {
          persistedQueue = updater(queuedActions);
          return { status: 'COMMITTED_PUBLISHED', queue: persistedQueue };
        }),
      },
    };
    mockUploadOutbox = { removePendingUpload: vi.fn().mockResolvedValue(undefined) };
    
    const injector = Injector.create({
      providers: [
        { provide: AttachmentService, useValue: mockAttachmentService },
        { provide: AuthService, useValue: mockAuthService },
        { provide: ToastService, useValue: mockToastService },
        { provide: LoggerService, useValue: mockLogger },
        { provide: SupabaseClientService, useValue: mockSupabaseClientService },
        { provide: TaskOperationAdapterService, useValue: mockTaskOpsAdapter },
        { provide: ActionQueueService, useValue: mockActionQueue },
        { provide: AttachmentUploadOutboxService, useValue: mockUploadOutbox },
        { provide: ProjectStateService, useValue: { projects: vi.fn(() => targetProjects) } },
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
      expect(result.queued).toBe(1);
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
      expect(mockActionQueue.storage.persistExactQueueMutationForOwner).not.toHaveBeenCalled();
      expect(mockUploadOutbox.removePendingUpload).not.toHaveBeenCalled();
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

    it('目标项目或任务在上传前已不存在时不应创建 Blob 或 action', async () => {
      targetProjects = [{ id: 'project-1', tasks: [] }];
      const items: AttachmentImportItem[] = [
        {
          projectId: 'project-1',
          taskId: 'missing-task',
          metadata: { id: 'att-1', name: 'missing.txt', size: 4, mimeType: 'text/plain' },
          data: new Blob(['demo'], { type: 'text/plain' }),
        },
        {
          projectId: 'missing-project',
          taskId: 'task-1',
          metadata: { id: 'att-2', name: 'missing-project.txt', size: 4, mimeType: 'text/plain' },
          data: new Blob(['demo'], { type: 'text/plain' }),
        },
      ];

      const result = await service.importAttachments('project-1', items);

      expect(result.success).toBe(false);
      expect(result.failed).toBe(2);
      expect(result.imported).toBe(0);
      expect(mockAttachmentService.uploadFile).not.toHaveBeenCalled();
      expect(mockTaskOpsAdapter.addTaskAttachmentToProject).not.toHaveBeenCalled();
      expect(mockActionQueue.storage.persistExactQueueMutationForOwner).not.toHaveBeenCalled();
      expect(mockUploadOutbox.removePendingUpload).not.toHaveBeenCalled();
    });

    it('上传等待期间任务被删除时应精确补偿旧 operation 并保留新代次与其他 owner', async () => {
      const receipt = {
        actionId: 'action-old',
        ownerUserId: 'user-1',
        blobKey: 'att-1',
        operationId: 'operation-old',
      };
      queuedActions = [
        createQueuedUploadAction('action-old', 'operation-old', 'user-1'),
        createQueuedUploadAction('action-new', 'operation-new', 'user-1'),
        createQueuedUploadAction('action-foreign', 'operation-old', 'user-2'),
      ];
      mockAttachmentService.uploadFile.mockImplementation(async () => {
        targetProjects = [{ id: 'project-1', tasks: [] }];
        return {
          success: true,
          attachment: { id: 'att-1', name: 'late.txt', type: 'file', url: 'pending', createdAt: 'now' },
          queuedUpload: receipt,
        };
      });
      mockTaskOpsAdapter.addTaskAttachmentToProject.mockResolvedValue(false);
      const items: AttachmentImportItem[] = [
        {
          projectId: 'project-1',
          taskId: 'task-1',
          metadata: { id: 'att-1', name: 'late.txt', size: 4, mimeType: 'text/plain' },
          data: new Blob(['demo'], { type: 'text/plain' }),
        },
      ];

      const result = await service.importAttachments('project-1', items);

      expect(result.success).toBe(false);
      expect(result.failed).toBe(1);
      expect(result.imported).toBe(0);
      expect(persistedQueue.map(action => action.id)).toEqual(['action-new', 'action-foreign']);
      expect(mockActionQueue.dequeue).not.toHaveBeenCalled();
      expect(mockUploadOutbox.removePendingUpload).toHaveBeenCalledWith({
        ownerUserId: 'user-1',
        blobKey: 'att-1',
        operationId: 'operation-old',
      } satisfies PendingAttachmentUploadIdentity);
    });

    it('action 补偿已提交但 owner 代次变化时应继续精确删除 Blob 且不触碰当前队列', async () => {
      const receipt = { actionId: 'action-held', ownerUserId: 'user-1', blobKey: 'att-1', operationId: 'operation-held' };
      queuedActions = [createQueuedUploadAction('action-held', 'operation-held', 'user-1')];
      mockActionQueue.storage.persistExactQueueMutationForOwner.mockResolvedValue({
        status: 'COMMITTED_HELD', queue: [],
      });
      mockAttachmentService.uploadFile.mockImplementation(async () => {
        targetProjects = [{ id: 'project-1', tasks: [] }];
        return {
          success: true,
          attachment: { id: 'att-1', name: 'held.txt', type: 'file', url: 'pending', createdAt: 'now' },
          queuedUpload: receipt,
        };
      });
      mockTaskOpsAdapter.addTaskAttachmentToProject.mockResolvedValue(false);

      await service.importAttachments('project-1', [{
        projectId: 'project-1', taskId: 'task-1',
        metadata: { id: 'att-1', name: 'held.txt', size: 4, mimeType: 'text/plain' },
        data: new Blob(['demo'], { type: 'text/plain' }),
      }]);

      expect(mockUploadOutbox.removePendingUpload).toHaveBeenCalledWith({
        ownerUserId: 'user-1', blobKey: 'att-1', operationId: 'operation-held',
      });
      expect(mockActionQueue.dequeue).not.toHaveBeenCalled();
    });

    it('action 补偿未提交时应保留 Blob 且不触碰当前队列', async () => {
      const receipt = { actionId: 'action-rejected', ownerUserId: 'user-1', blobKey: 'att-1', operationId: 'operation-rejected' };
      mockActionQueue.storage.persistExactQueueMutationForOwner.mockResolvedValue({ status: 'REJECTED_NO_COMMIT' });
      mockAttachmentService.uploadFile.mockImplementation(async () => {
        targetProjects = [{ id: 'project-1', tasks: [] }];
        return {
          success: true,
          attachment: { id: 'att-1', name: 'rejected.txt', type: 'file', url: 'pending', createdAt: 'now' },
          queuedUpload: receipt,
        };
      });
      mockTaskOpsAdapter.addTaskAttachmentToProject.mockResolvedValue(false);

      await service.importAttachments('project-1', [{
        projectId: 'project-1', taskId: 'task-1',
        metadata: { id: 'att-1', name: 'rejected.txt', size: 4, mimeType: 'text/plain' },
        data: new Blob(['demo'], { type: 'text/plain' }),
      }]);

      expect(mockUploadOutbox.removePendingUpload).not.toHaveBeenCalled();
      expect(mockActionQueue.dequeue).not.toHaveBeenCalled();
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

  registerAttachmentImportZipIntegritySpecs({
    getService: () => service,
    getLogger: () => mockLogger.category(),
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

function createQueuedUploadAction(
  id: string,
  operationId: string,
  ownerUserId: string,
): QueuedAction<AttachmentUploadPayload> {
  return {
    id,
    operationId,
    type: 'create',
    entityType: 'attachment',
    entityId: 'att-1',
    payload: { blobKey: 'att-1', userId: ownerUserId, sourceUserId: ownerUserId } as AttachmentUploadPayload,
    timestamp: 0,
    retryCount: 0,
  };
}
