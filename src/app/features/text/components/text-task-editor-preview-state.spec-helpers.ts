import type { ComponentFixture } from '@angular/core/testing';
import { expect, it, vi } from 'vitest';

import type { Task } from '../../../../models';
import type { UndoAppliedReplay } from '../../../../services/undo.service';
import { createPathClickEvent, createTask } from './text-task-editor.test-harness';
import { TextTaskEditorComponent } from './text-task-editor.component';

export interface TextTaskEditorPreviewStateSpecContext {
  getFixture(): ComponentFixture<TextTaskEditorComponent>;
  render(taskOverrides?: Partial<Task>): {
    setTask(nextTask: Task): void;
  };
  setUndoReplay(replay: UndoAppliedReplay | null): void;
}

export function registerTextTaskEditorPreviewStateSpecs(context: TextTaskEditorPreviewStateSpecContext): void {
  it('should suppress the same document click when entering content editing from the non-empty preview area', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-05T00:00:00.000Z'));
    try {
      context.render({ content: '联系供应商确认规格。' });
      const fixture = context.getFixture();

      const component = fixture.componentInstance as unknown as {
        onDocumentClick: (event: MouseEvent) => void;
        isPreview: () => boolean;
      };
      const contentPreview = fixture.nativeElement.querySelector('[data-testid="task-content"]') as HTMLElement | null;
      const editorRoot = fixture.nativeElement.querySelector('.animate-collapse-open') as HTMLElement | null;

      contentPreview?.click();
      fixture.detectChanges();

      component.onDocumentClick(createPathClickEvent(contentPreview!, [contentPreview!, editorRoot!, document.body, document, window]));
      fixture.detectChanges();

      expect(component.isPreview()).toBe(false);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it('should keep editing open when the original preview trigger node has been detached before document click runs', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-05T00:00:00.000Z'));
    try {
      context.render({ content: '联系供应商确认规格。' });
      const fixture = context.getFixture();

      const component = fixture.componentInstance as unknown as {
        onDocumentClick: (event: MouseEvent) => void;
        isPreview: () => boolean;
      };
      const titlePreview = fixture.nativeElement.querySelector('[data-testid="task-title-preview"]') as HTMLButtonElement | null;
      const editorRoot = fixture.nativeElement.querySelector('.animate-collapse-open') as HTMLElement | null;

      titlePreview?.click();
      fixture.detectChanges();

      component.onDocumentClick(createPathClickEvent(titlePreview!, [titlePreview!, editorRoot!, document.body, document, window]));
      fixture.detectChanges();

      expect(component.isPreview()).toBe(false);
      expect(fixture.nativeElement.querySelector('[data-testid="task-title-input"]')).not.toBeNull();
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it('should replay recovered content into the focused local editor after undo', () => {
    const task = createTask({ content: '旧内容' });
    const rendered = context.render({ content: '旧内容' });
    const fixture = context.getFixture();

    const component = fixture.componentInstance as unknown as {
      enterEditMode: (field: 'title' | 'content', event?: Event) => void;
      onInputFocus: (field: 'title' | 'content' | 'todo') => void;
      localContent: { (): string; set: (value: string) => void };
    };

    component.enterEditMode('content');
    fixture.detectChanges();
    component.onInputFocus('content');
    component.localContent.set('');

    rendered.setTask({ ...task, content: '恢复后的内容' });
    fixture.detectChanges();
    expect(component.localContent()).toBe('');

    context.setUndoReplay({
      sequence: 1,
      kind: 'undo',
      projectId: 'project-1',
      taskFieldChanges: { 'task-1': ['content'] },
    });
    fixture.detectChanges();

    expect(component.localContent()).toBe('恢复后的内容');

    component.localContent.set('继续编辑');
    rendered.setTask({ ...task, content: '回放后的远端更新' });
    fixture.detectChanges();

    expect(component.localContent()).toBe('继续编辑');
  });
}
