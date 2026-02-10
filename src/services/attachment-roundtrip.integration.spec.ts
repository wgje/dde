import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { AttachmentExportService } from './attachment-export.service';
import { AttachmentImportService } from './attachment-import.service';
import { AttachmentService } from './attachment.service';
import { AuthService } from './auth.service';
import { SupabaseClientService } from './supabase-client.service';
import { TaskOperationAdapterService } from './task-operation-adapter.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import type { Project } from '../models';

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
          attachments: [
            {
              id: 'att-1',
              type: 'document',
              name: 'note.txt',
              url: 'https://example.com/note.txt',
              mimeType: 'text/plain',
              size: 4,
              createdAt: new Date().toISOString(),
            },
          ],
        },
      ],
      connections: [],
    };

    const exportResult = await exportService.exportAttachments([project]);
    expect(exportResult.success).toBe(true);
    expect(exportResult.blob).toBeDefined();

    const zipData = await exportResult.blob!.arrayBuffer();
    const taskMap = new Map([
      ['task-1', [{ id: 'att-1', name: 'note.txt', size: 4, mimeType: 'text/plain' }]],
    ]);

    const extractedItems = await importService.extractAttachmentsFromZip(zipData, taskMap);
    expect(extractedItems).toHaveLength(1);
    expect(extractedItems[0]?.taskId).toBe('task-1');

    const importResult = await importService.importAttachments('project-1', extractedItems);
    expect(importResult.success).toBe(true);
    expect(importResult.imported).toBe(1);
    expect(mockAttachmentService.uploadFile).toHaveBeenCalledTimes(1);
    expect(mockTaskOpsAdapter.addTaskAttachment).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ id: 'att-1' })
    );
  });
});
