import { describe, expect, it, vi } from 'vitest';
import type { Attachment, Task } from '../../../../models';
import { TextTaskEditorAttachmentController } from './text-task-editor-attachment.controller';

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: overrides.id ?? 'attachment-1',
    type: overrides.type ?? 'file',
    name: overrides.name ?? 'file.txt',
    size: overrides.size ?? 1024,
    url: overrides.url ?? 'https://example.test/file.txt',
    createdAt: overrides.createdAt ?? '2026-06-01T00:00:00.000Z',
    deletedAt: overrides.deletedAt,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? 'task-1',
    title: overrides.title ?? 'Task',
    content: overrides.content ?? '',
    stage: overrides.stage ?? 1,
    parentId: overrides.parentId ?? null,
    order: overrides.order ?? 1,
    rank: overrides.rank ?? 1000,
    status: overrides.status ?? 'active',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    createdDate: overrides.createdDate ?? '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
    displayId: overrides.displayId ?? '?',
    attachments: overrides.attachments ?? [],
  };
}

function fileList(files: File[]): FileList {
  return files as unknown as FileList;
}

function createController(overrides: Partial<ConstructorParameters<typeof TextTaskEditorAttachmentController>[0]> = {}) {
  const options = {
    task: vi.fn(() => task()),
    userId: vi.fn(() => 'user-1'),
    projectId: vi.fn(() => 'project-1'),
    setUploading: vi.fn(),
    uploadFile: vi.fn(),
    markAsDeleted: vi.fn((item: Attachment) => ({ ...item, deletedAt: '2026-06-02T00:00:00.000Z' })),
    updateTaskAttachments: vi.fn(),
    emitAttachmentError: vi.fn(),
    toast: {
      warning: vi.fn(),
      success: vi.fn(),
      error: vi.fn(),
    },
    openUrl: vi.fn(),
    ...overrides,
  };

  return {
    controller: new TextTaskEditorAttachmentController(options),
    options,
  };
}

describe('TextTaskEditorAttachmentController', () => {
  it('uploads valid files and appends successful attachments', async () => {
    const existingAttachment = attachment({ id: 'existing' });
    const uploadedAttachment = attachment({ id: 'uploaded', name: 'new.txt' });
    const { controller, options } = createController({
      task: vi.fn(() => task({ attachments: [existingAttachment] })),
      uploadFile: vi.fn().mockResolvedValue({ success: true, attachment: uploadedAttachment }),
      updateTaskAttachments: vi.fn().mockResolvedValue(true),
    });
    const input = { files: fileList([new File(['ok'], 'new.txt')]), value: 'selected' } as HTMLInputElement;

    const uploaded = await controller.onMobileFileSelect(input);

    expect(uploaded).toBe(true);
    expect(options.setUploading).toHaveBeenNthCalledWith(1, true);
    expect(options.uploadFile).toHaveBeenCalledWith('user-1', 'project-1', 'task-1', expect.any(File));
    expect(options.updateTaskAttachments).toHaveBeenCalledWith('task-1', [existingAttachment, uploadedAttachment]);
    expect(options.toast.success).toHaveBeenCalledWith('上传成功', '1 个文件已上传');
    expect(options.setUploading).toHaveBeenLastCalledWith(false);
    expect(input.value).toBe('');
  });

  it('does not show upload success when attachment metadata fails local durable persistence', async () => {
    const uploadedAttachment = attachment({ id: 'uploaded', name: 'new.txt' });
    const { controller, options } = createController({
      uploadFile: vi.fn().mockResolvedValue({ success: true, attachment: uploadedAttachment }),
      updateTaskAttachments: vi.fn().mockResolvedValue(false),
    });
    const input = { files: fileList([new File(['ok'], 'new.txt')]), value: 'selected' } as HTMLInputElement;

    const uploaded = await controller.onMobileFileSelect(input);

    expect(uploaded).toBe(false);
    expect(options.updateTaskAttachments).toHaveBeenCalledWith('task-1', [uploadedAttachment]);
    expect(options.emitAttachmentError).toHaveBeenCalledWith('附件本地保存失败，请释放浏览器存储空间后重试');
    expect(options.toast.success).not.toHaveBeenCalled();
    expect(input.value).toBe('selected');
  });

  it('reports upload failures without discarding successful files', async () => {
    const uploadedAttachment = attachment({ id: 'uploaded' });
    const { controller, options } = createController({
      uploadFile: vi.fn()
        .mockResolvedValueOnce({ success: false, error: '扫描失败' })
        .mockResolvedValueOnce({ success: true, attachment: uploadedAttachment }),
      updateTaskAttachments: vi.fn().mockResolvedValue(true),
    });
    const input = {
      files: fileList([
        new File(['bad'], 'bad.txt'),
        new File(['ok'], 'ok.txt'),
      ]),
      value: 'selected',
    } as HTMLInputElement;

    const uploaded = await controller.onMobileFileSelect(input);

    expect(uploaded).toBe(true);
    expect(options.emitAttachmentError).toHaveBeenCalledWith('扫描失败');
    expect(options.updateTaskAttachments).toHaveBeenCalledWith('task-1', [uploadedAttachment]);
    expect(options.toast.success).toHaveBeenCalledWith('上传成功', '1 个文件已上传');
    expect(input.value).toBe('');
  });

  it('warns and clears input when no attachment slots remain', async () => {
    const { controller, options } = createController({
      task: vi.fn(() => task({
        attachments: Array.from({ length: 5 }, (_value, index) => attachment({ id: `a-${index}` })),
      })),
    });
    const input = { files: fileList([new File(['ok'], 'new.txt')]), value: 'selected' } as HTMLInputElement;

    const uploaded = await controller.onMobileFileSelect(input);

    expect(uploaded).toBe(false);
    expect(options.toast.warning).toHaveBeenCalledWith('附件数量已达上限', '每个任务最多 5 个附件');
    expect(options.uploadFile).not.toHaveBeenCalled();
    expect(input.value).toBe('');
  });

  it('marks an attachment as deleted and persists the updated list', async () => {
    const target = attachment({ id: 'target', name: 'target.pdf' });
    const other = attachment({ id: 'other' });
    const { controller, options } = createController({
      task: vi.fn(() => task({ attachments: [target, other] })),
      updateTaskAttachments: vi.fn().mockResolvedValue(true),
    });
    const event = { stopPropagation: vi.fn() } as unknown as Event;

    await controller.deleteAttachment(target, event);

    expect(event.stopPropagation).toHaveBeenCalled();
    expect(options.updateTaskAttachments).toHaveBeenCalledWith('task-1', [
      expect.objectContaining({ id: 'target', deletedAt: '2026-06-02T00:00:00.000Z' }),
      other,
    ]);
    expect(options.toast.success).toHaveBeenCalledWith('删除成功', 'target.pdf 已删除');
  });

  it('does not show delete success when attachment tombstone fails local durable persistence', async () => {
    const target = attachment({ id: 'target', name: 'target.pdf' });
    const { controller, options } = createController({
      task: vi.fn(() => task({ attachments: [target] })),
      updateTaskAttachments: vi.fn().mockResolvedValue(false),
    });
    const event = { stopPropagation: vi.fn() } as unknown as Event;

    await controller.deleteAttachment(target, event);

    expect(options.updateTaskAttachments).toHaveBeenCalledWith('task-1', [
      expect.objectContaining({ id: 'target', deletedAt: '2026-06-02T00:00:00.000Z' }),
    ]);
    expect(options.emitAttachmentError).toHaveBeenCalledWith('附件删除本地保存失败，请释放浏览器存储空间后重试');
    expect(options.toast.success).not.toHaveBeenCalled();
  });

  it('opens only attachments with preview URLs', () => {
    const { controller, options } = createController();

    controller.previewImage(attachment({ url: 'https://example.test/file.png' }));
    controller.previewImage(attachment({ url: '' }));

    expect(options.openUrl).toHaveBeenCalledTimes(1);
    expect(options.openUrl).toHaveBeenCalledWith('https://example.test/file.png', '_blank');
  });
});
