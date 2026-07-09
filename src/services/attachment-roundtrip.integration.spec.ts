import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { AttachmentExportService } from './attachment-export.service';
import { AttachmentImportService } from './attachment-import.service';
import { AttachmentService } from './attachment.service';
import { AuthService } from './auth.service';
import { SupabaseClientService } from './supabase-client.service';
import { TaskOperationAdapterService } from './task-operation-adapter.service';
import { VirusScanService } from './virus-scan.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import type { Project } from '../models';
import { SCAN_STATUS } from '../config/virus-scan.config';

describe('Attachment Export/Import Roundtrip', () => {
  let exportService: AttachmentExportService;
  let importService: AttachmentImportService;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const mockAttachmentService = {
    uploadFile: vi.fn().mockResolvedValue({
      success: true,
      attachment: {
        id: 'att-1',
        name: 'note.txt',
        type: 'document',
        url: 'https://example.com/uploaded-note.txt',
        mimeType: 'text/plain',
        size: 4,
        createdAt: new Date().toISOString(),
      },
    }),
  };

  const mockAuthService = {
    currentUserId: vi.fn(() => 'user-1'),
  };

  const mockSupabase = {
    isConfigured: false,
    client: vi.fn(),
  };

  const mockTaskOpsAdapter = {
    addTaskAttachment: vi.fn(),
    addTaskAttachmentToProject: vi.fn(() => true),
  };

  const mockVirusScan = {
    checkBeforeDownload: vi.fn(() => Promise.resolve({ success: true })),
  };

  const mockLogger = {
    category: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };

  const mockToast = {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    show: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    const injector = Injector.create({
      providers: [
        { provide: LoggerService, useValue: mockLogger },
        { provide: ToastService, useValue: mockToast },
        { provide: AttachmentService, useValue: mockAttachmentService },
        { provide: AuthService, useValue: mockAuthService },
        { provide: SupabaseClientService, useValue: mockSupabase },
        { provide: TaskOperationAdapterService, useValue: mockTaskOpsAdapter },
        { provide: VirusScanService, useValue: mockVirusScan },
      ],
    });

    exportService = runInInjectionContext(injector, () => new AttachmentExportService());
    importService = runInInjectionContext(injector, () => new AttachmentImportService());

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['demo'], { type: 'text/plain' })),
    } as Response);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('应支持 ZIP 导出后再导入并挂载到任务', async () => {
    const sharedAttachment = {
      id: 'att-1',
      type: 'document' as const,
      name: 'note.txt',
      url: 'https://example.com/note.txt',
      mimeType: 'text/plain',
      size: 4,
      createdAt: new Date().toISOString(),
      scanMetadata: {
        fileId: 'scan-file-1',
        fileHash: 'hash-1',
        scanStatus: SCAN_STATUS.CLEAN,
      },
    };
    const project: Project = {
      id: 'project-1',
      name: 'Project',
      description: '',
      createdDate: new Date().toISOString(),
      tasks: [
        {
          id: 'task-1',
          title: 'Task',
          content: '',
          stage: 1,
          parentId: null,
          order: 0,
          rank: 10000,
          status: 'active',
          x: 0,
          y: 0,
          displayId: '1',
          createdDate: new Date().toISOString(),
          attachments: [sharedAttachment],
        },
        {
          id: 'task-2',
          title: 'Task 2',
          content: '',
          stage: 1,
          parentId: null,
          order: 1,
          rank: 20000,
          status: 'active',
          x: 0,
          y: 0,
          displayId: '2',
          createdDate: new Date().toISOString(),
          attachments: [sharedAttachment],
        },
      ],
      connections: [],
    };
    const project2: Project = {
      ...project,
      id: 'project-2',
      tasks: [
        {
          id: 'task-3',
          title: 'Task 3',
          content: '',
          stage: 1,
          parentId: null,
          order: 0,
          rank: 10000,
          status: 'active',
          x: 0,
          y: 0,
          displayId: '1',
          createdDate: new Date().toISOString(),
          attachments: [sharedAttachment],
        },
      ],
    };

    const exportResult = await exportService.exportAttachments([project, project2]);
    expect(exportResult.success).toBe(true);
    expect(exportResult.blob).toBeDefined();
    expect(exportResult.manifest?.attachments[0]?.taskIds).toEqual(['task-1', 'task-2', 'task-3']);
    expect(exportResult.manifest?.attachments[0]?.projectIds).toEqual(['project-1', 'project-1', 'project-2']);

    const zipData = await exportResult.blob!.arrayBuffer();
    const taskMap = new Map([
      ['task-1', [{ id: 'att-1', name: 'note.txt', size: 4, mimeType: 'text/plain' }]],
      ['task-2', [{ id: 'att-1', name: 'note.txt', size: 4, mimeType: 'text/plain' }]],
      ['task-3', [{ id: 'att-1', name: 'note.txt', size: 4, mimeType: 'text/plain' }]],
    ]);

    const extractedItems = await importService.extractAttachmentsFromZip(zipData, taskMap);
    expect(extractedItems.map(({ projectId, taskId }) => ({ projectId, taskId }))).toEqual([
      { projectId: 'project-1', taskId: 'task-1' },
      { projectId: 'project-1', taskId: 'task-2' },
      { projectId: 'project-2', taskId: 'task-3' },
    ]);

    mockAttachmentService.uploadFile.mockResolvedValueOnce({
      success: true,
      attachment: {
        id: 'uploaded-task-1',
        name: 'note.txt',
        type: 'document',
        url: 'https://example.com/uploaded-task-1.txt',
        mimeType: 'text/plain',
        size: 4,
        createdAt: new Date().toISOString(),
      },
    }).mockResolvedValueOnce({
      success: true,
      attachment: {
        id: 'uploaded-task-2',
        name: 'note.txt',
        type: 'document',
        url: 'https://example.com/uploaded-task-2.txt',
        mimeType: 'text/plain',
        size: 4,
        createdAt: new Date().toISOString(),
      },
    }).mockResolvedValueOnce({
      success: true,
      attachment: {
        id: 'uploaded-task-3',
        name: 'note.txt',
        type: 'document',
        url: 'https://example.com/uploaded-task-3.txt',
        mimeType: 'text/plain',
        size: 4,
        createdAt: new Date().toISOString(),
      },
    });

    const importResult = await importService.importAttachments('project-1', extractedItems);
    expect(importResult.success).toBe(true);
    expect(importResult.imported).toBe(3);
    expect(mockAttachmentService.uploadFile).toHaveBeenCalledTimes(3);
    expect(mockAttachmentService.uploadFile.mock.calls.map(([, projectId, taskId]) => ({ projectId, taskId }))).toEqual([
      { projectId: 'project-1', taskId: 'task-1' },
      { projectId: 'project-1', taskId: 'task-2' },
      { projectId: 'project-2', taskId: 'task-3' },
    ]);
    expect(mockTaskOpsAdapter.addTaskAttachmentToProject).toHaveBeenCalledWith(
      'project-1',
      'task-1',
      expect.objectContaining({ id: 'uploaded-task-1' })
    );
    expect(mockTaskOpsAdapter.addTaskAttachmentToProject).toHaveBeenCalledWith(
      'project-1',
      'task-2',
      expect.objectContaining({ id: 'uploaded-task-2' })
    );
    expect(mockTaskOpsAdapter.addTaskAttachmentToProject).toHaveBeenCalledWith(
      'project-2',
      'task-3',
      expect.objectContaining({ id: 'uploaded-task-3' })
    );
  });
});
