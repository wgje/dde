import { describe, expect, it, vi } from 'vitest';

import { TextTaskEditorPreviewController } from './text-task-editor-preview.controller';

describe('TextTaskEditorPreviewController', () => {
  it('keeps local content unchanged when a preview todo toggle fails to persist', async () => {
    const setLocalContent = vi.fn();
    const enterEditMode = vi.fn();
    const markForCheck = vi.fn();
    const submitTaskContent = vi.fn().mockResolvedValue(false);
    const controller = new TextTaskEditorPreviewController({
      getLocalContent: () => '- [ ] 本地优先',
      getTask: () => ({ id: 'task-1', content: '- [ ] 本地优先' }),
      submitTaskContent,
      setLocalContent,
      enterEditMode,
      emitOpenLinkedTask: vi.fn(),
      markForCheck,
      toast: { info: vi.fn(), warning: vi.fn() },
    });
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute('data-todo-index', '0');
    const stopPropagation = vi.fn();

    await controller.onPreviewClick({
      target: checkbox,
      stopPropagation,
    } as unknown as MouseEvent);

    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(submitTaskContent).toHaveBeenCalledWith('task-1', '- [x] 本地优先');
    expect(setLocalContent).not.toHaveBeenCalled();
    expect(markForCheck).toHaveBeenCalledTimes(1);
    expect(enterEditMode).not.toHaveBeenCalled();
  });
});
