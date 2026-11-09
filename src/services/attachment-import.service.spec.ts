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
import { AttachmentImportResumeService } from './attachment-import-resume.service';
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
    enqueueDurablyForOwner: ReturnType<typeof vi.fn>;
    dequeue: ReturnType<typeof vi.fn>;
    storage: { persistExactQueueMutationForOwner: ReturnType<typeof vi.fn> };
  };
  let mockUploadOutbox: {
    removePendingUpload: ReturnType<typeof vi.fn>;
    readPendingUploadStrictly: ReturnType<typeof vi.fn>;
    matchesPendingUploadForReplay: ReturnType<typeof vi.fn>;
  };
  let resumeService: AttachmentImportResumeService;
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
      enqueueDurablyForOwner: vi.fn().mockResolvedValue('replayed-action'),
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
    mockUploadOutbox = {
      removePendingUpload: vi.fn().mockResolvedValue(undefined),
      readPendingUploadStrictly: vi.fn().mockResolvedValue({ status: 'missing' }),
      matchesPendingUploadForReplay: vi.fn().mockReturnValue(true),
    };
    resumeService = new AttachmentImportResumeService();
    
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
        { provide: AttachmentImportResumeService, useValue: resumeService },
        { provide: ProjectStateService, useValue: { projects: vi.fn(() => targetProjects) } },
      ],
    });
    
    service = runInInjectionContext(injector, () => new AttachmentImportService());
  });
  
  afterEach(async () => {
    vi.useRealTimers();
    await resumeService.clearCheckpointsForTests();
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
        expect.any(File),
        expect.objectContaining({ operationId: expect.any(String) }),
      );
      expect(mockTaskOpsAdapter.addTaskAttachmentToProject).toHaveBeenCalledWith(
        'project-1',
        'task-1',
        expect.objectContaining({ id: 'att-1' }),
        expect.objectContaining({ operationId: expect.any(String) }),
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
        expect.objectContaining({ operationId: expect.any(String) }),
      );
      expect(mockTaskOpsAdapter.addTaskAttachmentToProject).toHaveBeenCalledWith(
        'project-b',
        'task-b',
        expect.objectContaining({ name: 'b.txt' }),
        expect.objectContaining({ operationId: expect.any(String) }),
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
        expect.objectContaining({ operationId: expect.any(String) }),
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

    it('应持久化部分批次并在同一 owner 重开后跳过已完成项', async () => {
      const items: AttachmentImportItem[] = [
        {
          projectId: 'project-1',
          taskId: 'task-0',
          metadata: { id: 'att-0', name: 'zero.txt', size: 4, mimeType: 'text/plain' },
          data: new Blob(['zero'], { type: 'text/plain' }),
        },
        {
          projectId: 'project-1',
          taskId: 'task-1',
          metadata: { id: 'att-1', name: 'one.txt', size: 3, mimeType: 'text/plain' },
          data: new Blob(['one'], { type: 'text/plain' }),
        },
      ];
      let failOnce = true;
      mockAttachmentService.uploadFile.mockImplementation(async (
        _userId: string,
        _projectId: string,
        taskId: string,
      ) => taskId === 'task-1' && failOnce
        ? { success: false, error: '暂时失败' }
        : {
          success: true,
          attachment: {
            id: `uploaded-${taskId}`,
            name: `${taskId}.txt`,
            type: 'document',
            url: `pending://${taskId}`,
            mimeType: 'text/plain',
            size: 4,
            createdAt: new Date().toISOString(),
          },
          queuedUpload: {
            actionId: `action-${taskId}`,
            ownerUserId: 'user-1',
            blobKey: `uploaded-${taskId}`,
            operationId: `operation-${taskId}`,
          },
        });

      const first = await service.importAttachments('project-1', items);
      expect(first.success).toBe(false);
      expect(first.imported).toBe(1);
      expect(first.failed).toBe(1);

      const identity = await resumeService.buildPackageIdentity('project-1', items);
      const checkpoint = await resumeService.readCheckpoint('user-1', 'project-1', identity.packageDigest);
      expect(checkpoint?.items.map(item => item.status)).toEqual(['completed', 'failed']);
      expect(checkpoint?.items[0]?.operationId).toContain('attachment-import:');

      failOnce = false;
      const callsBeforeResume = mockAttachmentService.uploadFile.mock.calls.length;
      const resumed = await service.importAttachments('project-1', items);

      expect(resumed.success).toBe(true);
      expect(resumed.imported).toBe(2);
      expect(mockAttachmentService.uploadFile.mock.calls.length - callsBeforeResume).toBe(1);
      expect(await resumeService.readCheckpoint('user-1', 'project-1', identity.packageDigest)).toBeNull();
    });

    it('owner 变化时应拒绝续传且不产生新 owner 写入', async () => {
      const items: AttachmentImportItem[] = [{
        projectId: 'project-1',
        taskId: 'task-0',
        metadata: { id: 'att-owner', name: 'owner.txt', size: 5, mimeType: 'text/plain' },
        data: new Blob(['owner'], { type: 'text/plain' }),
      }];
      mockAttachmentService.uploadFile.mockResolvedValue({ success: false, error: '网络中断' });

      await service.importAttachments('project-1', items);
      const identity = await resumeService.buildPackageIdentity('project-1', items);
      expect(await resumeService.readCheckpoint('user-1', 'project-1', identity.packageDigest)).not.toBeNull();

      const uploadCallsBeforeOwnerSwitch = mockAttachmentService.uploadFile.mock.calls.length;
      const writesBeforeOwnerSwitch = mockTaskOpsAdapter.addTaskAttachmentToProject.mock.calls.length;
      mockAuthService.currentUserId.mockReturnValue('user-2');

      const result = await service.importAttachments('project-1', items);

      expect(result.success).toBe(false);
      expect(result.errors[0]?.error).toContain('其他用户');
      expect(mockAttachmentService.uploadFile.mock.calls.length).toBe(uploadCallsBeforeOwnerSwitch);
      expect(mockTaskOpsAdapter.addTaskAttachmentToProject.mock.calls.length).toBe(writesBeforeOwnerSwitch);
      expect(await resumeService.readCheckpoint('user-1', 'project-1', identity.packageDigest)).not.toBeNull();
      mockAuthService.currentUserId.mockReturnValue('user-1');
    });

    it('包内容改变或格式损坏时应 fail closed', async () => {
      const original: AttachmentImportItem[] = [{
        projectId: 'project-1',
        taskId: 'task-0',
        metadata: { id: 'att-digest', name: 'digest.txt', size: 4, mimeType: 'text/plain' },
        data: new Blob(['same'], { type: 'text/plain' }),
      }];
      mockAttachmentService.uploadFile.mockResolvedValue({ success: false, error: '中断' });
      await service.importAttachments('project-1', original);
      const uploadCallsBeforeChange = mockAttachmentService.uploadFile.mock.calls.length;

      const changed = [{
        ...original[0],
        data: new Blob(['changed'], { type: 'text/plain' }),
      }];
      const changedResult = await service.importAttachments('project-1', changed);
      expect(changedResult.success).toBe(false);
      expect(changedResult.errors[0]?.error).toContain('已改变');
      expect(mockAttachmentService.uploadFile.mock.calls.length).toBe(uploadCallsBeforeChange);

      const malformed = [{
        ...original[0],
        metadata: { ...original[0].metadata, id: '' },
      }] as AttachmentImportItem[];
      const malformedResult = await service.importAttachments('project-1', malformed);
      expect(malformedResult.success).toBe(false);
      expect(malformedResult.errors[0]?.error).toContain('格式无效');
      expect(mockAttachmentService.uploadFile.mock.calls.length).toBe(uploadCallsBeforeChange);
    });

    it('补偿失败时应保留 checkpoint 中的 receipt 和附件诊断', async () => {
      const receipt = {
        actionId: 'action-diagnostic',
        ownerUserId: 'user-1',
        blobKey: 'att-diagnostic',
        operationId: 'operation-diagnostic',
      };
      queuedActions = [createQueuedUploadAction(receipt.actionId, receipt.operationId, receipt.ownerUserId)];
      mockActionQueue.storage.persistExactQueueMutationForOwner.mockResolvedValue({ status: 'REJECTED_NO_COMMIT' });
      mockAttachmentService.uploadFile.mockResolvedValue({
        success: true,
        attachment: {
          id: 'att-diagnostic',
          name: 'diagnostic.txt',
          type: 'document',
          url: 'nanoflow-local-attachment://att-diagnostic',
          mimeType: 'text/plain',
          size: 4,
          createdAt: new Date().toISOString(),
        },
        queuedUpload: receipt,
      });
      mockTaskOpsAdapter.addTaskAttachmentToProject.mockResolvedValue(false);

      const items: AttachmentImportItem[] = [{
        projectId: 'project-1',
        taskId: 'task-0',
        metadata: { id: 'att-diagnostic', name: 'diagnostic.txt', size: 4, mimeType: 'text/plain' },
        data: new Blob(['demo'], { type: 'text/plain' }),
      }];
      await service.importAttachments('project-1', items);

      const identity = await resumeService.buildPackageIdentity('project-1', items);
      const checkpoint = await resumeService.readCheckpoint('user-1', 'project-1', identity.packageDigest);
      expect(checkpoint?.items[0]?.status).toBe('failed');
      expect(checkpoint?.items[0]?.queuedUpload).toEqual(receipt);
      expect(checkpoint?.items[0]?.attachment?.id).toBe('att-diagnostic');
      expect(mockUploadOutbox.removePendingUpload).not.toHaveBeenCalled();
    });

    it('resume 会先重放 retained receipt，避免第二次 upload 或 action', async () => {
      const receipt = {
        actionId: 'action-retained',
        ownerUserId: 'user-1',
        blobKey: 'att-retained',
        operationId: 'operation-retained',
      };
      const attachment = {
        id: 'att-retained',
        name: 'retained.txt',
        type: 'document' as const,
        url: 'nanoflow-local-attachment://att-retained',
        mimeType: 'text/plain',
        size: 4,
        createdAt: new Date().toISOString(),
      };
      const payload = {
        attachment,
        blobKey: 'att-retained',
        fileName: 'retained.txt',
        mimeType: 'text/plain',
        projectId: 'project-1',
        taskId: 'task-0',
        userId: 'user-1',
        sourceUserId: 'user-1',
      } as AttachmentUploadPayload;
      const item: AttachmentImportItem = {
        projectId: 'project-1',
        taskId: 'task-0',
        metadata: { id: 'att-retained', name: 'retained.txt', size: 4, mimeType: 'text/plain' },
        data: new Blob(['demo'], { type: 'text/plain' }),
      };
      mockAttachmentService.uploadFile.mockResolvedValue({ success: true, attachment, queuedUpload: receipt });
      mockTaskOpsAdapter.addTaskAttachmentToProject.mockResolvedValue(false);
      mockActionQueue.storage.persistExactQueueMutationForOwner.mockResolvedValue({ status: 'REJECTED_NO_COMMIT' });

      await service.importAttachments('project-1', [item]);
      const identity = await resumeService.buildPackageIdentity('project-1', [item]);
      mockUploadOutbox.readPendingUploadStrictly.mockResolvedValue({
        status: 'found',
        record: {
          ...receipt,
          attachmentId: 'att-retained',
          fileName: 'retained.txt',
          mimeType: 'text/plain',
          size: 4,
          blob: new Blob(['demo'], { type: 'text/plain' }),
          createdAt: new Date().toISOString(),
          recovery: { operationId: receipt.operationId, payload },
        },
      });
      mockUploadOutbox.matchesPendingUploadForReplay.mockReturnValue(true);
      mockTaskOpsAdapter.addTaskAttachmentToProject.mockResolvedValue(true);
      const uploadCallsBeforeResume = mockAttachmentService.uploadFile.mock.calls.length;
      const actionCallsBeforeResume = mockActionQueue.enqueueDurablyForOwner.mock.calls.length;

      const resumed = await service.importAttachments('project-1', [item]);

      expect(resumed.success).toBe(true);
      expect(mockAttachmentService.uploadFile.mock.calls.length).toBe(uploadCallsBeforeResume);
      expect(mockActionQueue.enqueueDurablyForOwner.mock.calls.length).toBe(actionCallsBeforeResume + 1);
      expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenLastCalledWith(
        'user-1',
        expect.objectContaining({ operationId: receipt.operationId }),
      );
      expect(await resumeService.readCheckpoint('user-1', 'project-1', identity.packageDigest)).toBeNull();
    });

    it('owner 在 upload await 期间切换时不进入 task metadata，checkpoint 保留', async () => {
      const item: AttachmentImportItem = {
        projectId: 'project-1',
        taskId: 'task-0',
        metadata: { id: 'att-owner-await', name: 'owner-await.txt', size: 4, mimeType: 'text/plain' },
        data: new Blob(['demo'], { type: 'text/plain' }),
      };
      let releaseUpload!: (value: unknown) => void;
      mockAttachmentService.uploadFile.mockReturnValueOnce(new Promise(resolve => { releaseUpload = resolve; }));
      const importPromise = service.importAttachments('project-1', [item]);
      await vi.waitFor(() => expect(mockAttachmentService.uploadFile).toHaveBeenCalledOnce());
      mockAuthService.currentUserId.mockReturnValue('user-2');
      releaseUpload({
        success: true,
        attachment: { id: 'att-owner-await', name: 'owner-await.txt', type: 'document', url: 'pending', mimeType: 'text/plain', size: 4, createdAt: new Date().toISOString() },
        queuedUpload: { actionId: 'action-owner-await', ownerUserId: 'user-1', blobKey: 'att-owner-await', operationId: 'operation-owner-await' },
      });

      const result = await importPromise;
      expect(result.success).toBe(false);
      expect(mockTaskOpsAdapter.addTaskAttachmentToProject).not.toHaveBeenCalled();
      mockAuthService.currentUserId.mockReturnValue('user-1');
    });

    it('localStorage 与 IndexedDB checkpoint 不一致时 fail closed 并保留诊断', async () => {
      const item: AttachmentImportItem = {
        projectId: 'project-1',
        taskId: 'task-0',
        metadata: { id: 'att-mirror', name: 'mirror.txt', size: 4, mimeType: 'text/plain' },
        data: new Blob(['demo'], { type: 'text/plain' }),
      };
      mockAttachmentService.uploadFile.mockResolvedValue({ success: false, error: '中断' });
      await service.importAttachments('project-1', [item]);
      const identity = await resumeService.buildPackageIdentity('project-1', [item]);
      const key = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
        .find(candidate => candidate?.startsWith('nanoflow.attachment-import-resume.v1:'));
      expect(key).toBeTruthy();
      if (!key) return;
      const parsed = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
      localStorage.setItem(key, JSON.stringify({ ...parsed, updatedAt: 'mismatched' }));

      const lookup = await resumeService.inspect('user-1', 'project-1', identity.packageDigest);
      expect(lookup.status).toBe('storage-failed');
      expect(localStorage.getItem(key)).toContain('mismatched');
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
      const items: AttachmentImportItem[] = Array.from({ length: 50 }, (_, i) => ({
          taskId: `task-${i}`,
          metadata: { id: `att-${i}`, name: `test-${i}.png`, size: 1024, mimeType: 'image/png' },
          data: new Blob(['test data'], { type: 'image/png' }),
      }));
        
      mockAttachmentService.uploadFile.mockImplementation(() =>
        new Promise(resolve => setTimeout(() => resolve({
          success: true,
          attachment: { id: 'att', name: 'test.png', type: 'image', url: '', mimeType: '', size: 0, createdAt: '' },
        }), 25))
      );
        
      const importPromise = service.importAttachments('project-1', items);
      await new Promise(resolve => setTimeout(resolve, 60));
      service.cancelImport();
      const result = await importPromise;
      expect(result.imported).toBeLessThan(50);
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
