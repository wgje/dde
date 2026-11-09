import type { ComponentFixture } from '@angular/core/testing';
import { expect, it, vi } from 'vitest';

import type { Task } from '../../../../models';
import { TextTaskEditorComponent } from './text-task-editor.component';

export interface TextTaskEditorMarkdownLinkSpecContext {
  getFixture(): ComponentFixture<TextTaskEditorComponent>;
  render(taskOverrides?: Partial<Task>): void;
}

export function registerTextTaskEditorMarkdownLinkSpecs(context: TextTaskEditorMarkdownLinkSpecContext): void {
  it('should keep preview mode when clicking an external markdown link', () => {
    context.render({ content: '[官网](https://example.com)' });
    const fixture = context.getFixture();

    const component = fixture.componentInstance as unknown as {
      onPreviewClick: (event: MouseEvent) => void;
      isPreview: () => boolean;
    };
    const link = fixture.nativeElement.querySelector('[data-testid="task-content"] a[data-link-kind="external"]') as HTMLAnchorElement | null;
    const stopPropagation = vi.fn();
    const preventDefault = vi.fn();

    component.onPreviewClick({ target: link, stopPropagation, preventDefault } as unknown as MouseEvent);
    fixture.detectChanges();

    expect(component.isPreview()).toBe(true);
    expect(stopPropagation).toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('[data-testid="task-title-input"]')).toBeNull();
  });

  it('should emit openLinkedTask when clicking a task markdown link', () => {
    context.render({ content: '[跳转](task:linked-task)' });
    const fixture = context.getFixture();

    const component = fixture.componentInstance as unknown as {
      onPreviewClick: (event: MouseEvent) => void;
      isPreview: () => boolean;
      openLinkedTask: { emit: ReturnType<typeof vi.fn> };
    };
    const emitSpy = vi.spyOn(component.openLinkedTask, 'emit');
    const link = fixture.nativeElement.querySelector('[data-testid="task-content"] a[data-link-kind="task"]') as HTMLAnchorElement | null;
    const stopPropagation = vi.fn();
    const preventDefault = vi.fn();
    const event = { target: link, stopPropagation, preventDefault } as unknown as MouseEvent;

    component.onPreviewClick(event);

    expect(preventDefault).toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledWith({ taskId: 'linked-task', event });
    expect(component.isPreview()).toBe(true);
  });

  it('should block unsafe markdown links without entering edit mode', () => {
    context.render({ content: '[危险](javascript:alert(1))' });
    const fixture = context.getFixture();

    const component = fixture.componentInstance as unknown as {
      onPreviewClick: (event: MouseEvent) => void;
      isPreview: () => boolean;
    };
    const link = fixture.nativeElement.querySelector('[data-testid="task-content"] a[data-link-kind="blocked"]') as HTMLAnchorElement | null;
    const stopPropagation = vi.fn();
    const preventDefault = vi.fn();

    component.onPreviewClick({ target: link, stopPropagation, preventDefault } as unknown as MouseEvent);

    expect(stopPropagation).toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalled();
    expect(component.isPreview()).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="task-title-input"]')).toBeNull();
  });

  it('should keep preview mode when clicking a local markdown link', async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    try {
      context.render({ content: '本地路径' });
      const fixture = context.getFixture();

      const component = fixture.componentInstance as unknown as {
        onPreviewClick: (event: MouseEvent) => void;
        isPreview: () => boolean;
      };
      const link = document.createElement('a');
      link.setAttribute('href', '#local-path');
      link.setAttribute('data-link-kind', 'local');
      link.setAttribute('data-local-link-path', 'C:\\Docs\\Plan.md');
      const stopPropagation = vi.fn();
      const preventDefault = vi.fn();

      component.onPreviewClick({ target: link, stopPropagation, preventDefault } as unknown as MouseEvent);
      await Promise.resolve();

      expect(stopPropagation).toHaveBeenCalled();
      expect(preventDefault).toHaveBeenCalled();
      expect(component.isPreview()).toBe(true);
      expect(writeText).toHaveBeenCalledWith('C:\\Docs\\Plan.md');
      expect(clickSpy).toHaveBeenCalled();
    } finally {
      clickSpy.mockRestore();
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', originalClipboard);
      } else {
        Reflect.deleteProperty(navigator as object, 'clipboard');
      }
    }
  });
}
