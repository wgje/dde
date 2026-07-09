import type { Attachment, Task } from '../../../../models';
import {
  buildMobileAttachmentFileSelection,
  TEXT_TASK_EDITOR_MAX_ATTACHMENTS,
} from './text-task-editor.helpers';

export interface TextTaskEditorUploadSuccess {
  success: true;
  attachment: Attachment;
}

export interface TextTaskEditorUploadFailure {
  success: false;
  error: string;
}

export type TextTaskEditorUploadResult =
  | TextTaskEditorUploadSuccess
  | TextTaskEditorUploadFailure;

export interface TextTaskEditorAttachmentControllerOptions {
  task: () => Task;
  userId: () => string | null;
  projectId: () => string | null;
  setUploading: (uploading: boolean) => void;
  uploadFile: (
    userId: string,
    projectId: string,
    taskId: string,
    file: File,
  ) => Promise<TextTaskEditorUploadResult>;
  markAsDeleted: (attachment: Attachment) => Attachment;
  updateTaskAttachments: (taskId: string, attachments: Attachment[]) => Promise<boolean>;
  emitAttachmentError: (message: string) => void;
  toast: {
    warning(title: string, message: string): void;
    success(title: string, message: string): void;
    error(title: string, message: string): void;
  };
  openUrl: (url: string, target: string) => void;
}

interface PreparedMobileAttachmentUpload {
  currentTask: Task;
  filesToUpload: File[];
  projectId: string;
  userId: string;
}

export class TextTaskEditorAttachmentController {
  constructor(private readonly options: TextTaskEditorAttachmentControllerOptions) {}

  async onMobileFileSelect(input: HTMLInputElement): Promise<boolean> {
    const prepared = this.prepareMobileAttachmentUpload(input);
    if (!prepared) return false;

    this.options.setUploading(true);
    let shouldClearInput = false;
    try {
      const uploaded = await this.uploadSelectedFiles(prepared);
      shouldClearInput = uploaded;
      return uploaded;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '上传失败';
      this.options.emitAttachmentError(errorMessage);
      this.options.toast.error('上传失败', errorMessage);
      return false;
    } finally {
      this.options.setUploading(false);
      if (shouldClearInput) {
        input.value = '';
      }
    }
  }

  private prepareMobileAttachmentUpload(input: HTMLInputElement): PreparedMobileAttachmentUpload | null {
    const files = input.files;
    const userId = this.options.userId();
    const projectId = this.options.projectId();
    if (!files || files.length === 0 || !userId || !projectId) return null;

    const currentTask = this.options.task();
    const {
      remainingSlots,
      filesToUpload,
      oversizedFile,
    } = buildMobileAttachmentFileSelection(files, currentTask.attachments?.length || 0);

    if (remainingSlots <= 0) {
      this.options.toast.warning(
        '附件数量已达上限',
        `每个任务最多 ${TEXT_TASK_EDITOR_MAX_ATTACHMENTS} 个附件`,
      );
      input.value = '';
      return null;
    }

    if (oversizedFile) {
      this.options.toast.warning('文件过大', `${oversizedFile.name} 超过 10MB 限制`);
      input.value = '';
      return null;
    }

    return {
      currentTask,
      filesToUpload,
      projectId,
      userId,
    };
  }

  private async uploadSelectedFiles(input: PreparedMobileAttachmentUpload): Promise<boolean> {
    const newAttachments: Attachment[] = [];

    for (const file of input.filesToUpload) {
      const result = await this.options.uploadFile(
        input.userId,
        input.projectId,
        input.currentTask.id,
        file,
      );
      if (result.success) {
        newAttachments.push(result.attachment);
      } else {
        this.options.emitAttachmentError(result.error);
      }
    }

    if (newAttachments.length > 0) {
      const persisted = await this.options.updateTaskAttachments(input.currentTask.id, [
        ...(input.currentTask.attachments || []),
        ...newAttachments,
      ]);
      if (!persisted) {
        this.options.emitAttachmentError('附件本地保存失败，请释放浏览器存储空间后重试');
        return false;
      }
      this.options.toast.success('上传成功', `${newAttachments.length} 个文件已上传`);
      return true;
    }

    return false;
  }

  async deleteAttachment(attachment: Attachment, event: Event): Promise<void> {
    event.stopPropagation();

    if (!this.options.userId() || !this.options.projectId()) return;

    try {
      const deletedAttachment = this.options.markAsDeleted(attachment);
      const currentTask = this.options.task();
      const updatedAttachments = (currentTask.attachments || []).map(item =>
        item.id === attachment.id ? deletedAttachment : item,
      );
      const persisted = await this.options.updateTaskAttachments(currentTask.id, updatedAttachments);
      if (!persisted) {
        this.options.emitAttachmentError('附件删除本地保存失败，请释放浏览器存储空间后重试');
        return;
      }
      this.options.toast.success('删除成功', `${attachment.name} 已删除`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '删除失败';
      this.options.emitAttachmentError(errorMessage);
      this.options.toast.error('删除失败', errorMessage);
    }
  }

  previewImage(attachment: Attachment): void {
    if (attachment.url) {
      this.options.openUrl(attachment.url, '_blank');
    }
  }
}
