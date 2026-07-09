import type { Task } from '../../../../models';
import { getTodoIndexFromClick, handleMarkdownLinkAction, toggleMarkdownTodo } from '../../../../utils/markdown';
import type { ToastService } from '../../../../services/toast.service';

export interface TextTaskEditorPreviewControllerOptions {
  getLocalContent: () => string;
  getTask: () => Pick<Task, 'id' | 'content'>;
  submitTaskContent: (taskId: string, value: string) => Promise<boolean>;
  setLocalContent: (value: string) => void;
  enterEditMode: (field: 'content', event: MouseEvent) => void;
  emitOpenLinkedTask: (taskId: string, event: Event) => void;
  markForCheck: () => void;
  toast: Pick<ToastService, 'info' | 'warning'>;
}

export class TextTaskEditorPreviewController {
  constructor(private readonly options: TextTaskEditorPreviewControllerOptions) {}

  async onPreviewClick(event: MouseEvent): Promise<void> {
    if (this.handlePreviewLinkClick(event)) {
      return;
    }

    event.stopPropagation();
    const todoIndex = getTodoIndexFromClick(event);
    if (todoIndex === null) {
      this.options.enterEditMode('content', event);
      return;
    }

    const task = this.options.getTask();
    const currentContent = this.options.getLocalContent() || task.content || '';
    const newContent = toggleMarkdownTodo(currentContent, todoIndex);
    const saved = await this.options.submitTaskContent(task.id, newContent);
    if (!saved) {
      this.options.markForCheck();
      return;
    }

    this.options.setLocalContent(newContent);
    this.options.markForCheck();
  }

  private handlePreviewLinkClick(event: MouseEvent): boolean {
    const linkTarget = handleMarkdownLinkAction(event, this.options.toast);
    if (!linkTarget) {
      return linkTarget === false;
    }

    if (linkTarget.kind === 'task' && linkTarget.taskId) {
      this.options.emitOpenLinkedTask(linkTarget.taskId, event);
    }
    return true;
  }
}
