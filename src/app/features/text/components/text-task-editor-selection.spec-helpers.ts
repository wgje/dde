import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../../models';
import { createClickEvent, createPathClickEvent } from './text-task-editor.test-harness';
import { TextTaskEditorComponent } from './text-task-editor.component';

export interface TextTaskEditorSelectionSpecContext {
  getFixture(): ComponentFixture<TextTaskEditorComponent>;
  render(taskOverrides?: Partial<Task>): void;
}

export function registerTextTaskEditorSelectionSpecs(
  context: TextTaskEditorSelectionSpecContext,
): void {
  describe('selection and editor interaction', () => {
    it('should clear selected editor text on the first outside click and collapse on the next click', () => {
      vi.useFakeTimers();
      try {
        context.render({ content: '联系供应商确认规格。' });
        const fixture = context.getFixture();

        const component = fixture.componentInstance as unknown as {
          onDocumentClick: (event: MouseEvent) => void;
          isPreview: () => boolean;
        };
        const titlePreview = fixture.nativeElement.querySelector('[data-testid="task-title-preview"]') as HTMLButtonElement | null;
        titlePreview?.click();
        fixture.detectChanges();
        vi.runAllTimers();
        fixture.detectChanges();

        const removeAllRanges = vi.fn();
        const getSelectionSpy = vi.spyOn(window, 'getSelection').mockReturnValue({
          toString: () => '零件',
          rangeCount: 1,
          isCollapsed: false,
          removeAllRanges,
        } as unknown as Selection);

        try {
          component.onDocumentClick(createClickEvent(Date.now(), document.body));
          fixture.detectChanges();

          expect(removeAllRanges).toHaveBeenCalledTimes(1);
          expect(component.isPreview()).toBe(false);
        } finally {
          getSelectionSpy.mockRestore();
        }

        component.onDocumentClick(createClickEvent(Date.now(), document.body));
        fixture.detectChanges();

        expect(component.isPreview()).toBe(true);
      } finally {
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
      }
    });

    it('should collapse native input selection before leaving edit mode on outside click', () => {
      vi.useFakeTimers();
      const activeElementDescriptor = Object.getOwnPropertyDescriptor(document, 'activeElement');

      try {
        context.render({ content: '联系供应商确认规格。' });
        const fixture = context.getFixture();

        const component = fixture.componentInstance as unknown as {
          onDocumentClick: (event: MouseEvent) => void;
          isPreview: () => boolean;
        };
        const titlePreview = fixture.nativeElement.querySelector('[data-testid="task-title-preview"]') as HTMLButtonElement | null;
        titlePreview?.click();
        fixture.detectChanges();
        vi.runAllTimers();
        fixture.detectChanges();

        const titleInput = fixture.nativeElement.querySelector('[data-testid="task-title-input"]') as HTMLInputElement | null;
        expect(titleInput).not.toBeNull();

        const setSelectionRangeSpy = vi.spyOn(titleInput!, 'setSelectionRange');
        Object.defineProperty(titleInput!, 'selectionStart', {
          configurable: true,
          get: () => 0,
        });
        Object.defineProperty(titleInput!, 'selectionEnd', {
          configurable: true,
          get: () => 2,
        });
        Object.defineProperty(document, 'activeElement', {
          configurable: true,
          get: () => titleInput,
        });

        const getSelectionSpy = vi.spyOn(window, 'getSelection').mockReturnValue(null);

        try {
          component.onDocumentClick(createClickEvent(Date.now(), document.body));
          fixture.detectChanges();

          expect(setSelectionRangeSpy).toHaveBeenCalledWith(2, 2);
          expect(component.isPreview()).toBe(false);
        } finally {
          getSelectionSpy.mockRestore();
          setSelectionRangeSpy.mockRestore();
        }
      } finally {
        if (activeElementDescriptor) {
          Object.defineProperty(document, 'activeElement', activeElementDescriptor);
        }
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
      }
    });

    it('should clear selection and collapse immediately when the outside target is a button', () => {
      vi.useFakeTimers();
      try {
        context.render({ content: '联系供应商确认规格。' });
        const fixture = context.getFixture();

        const component = fixture.componentInstance as unknown as {
          onDocumentClick: (event: MouseEvent) => void;
          isPreview: () => boolean;
        };
        const titlePreview = fixture.nativeElement.querySelector('[data-testid="task-title-preview"]') as HTMLButtonElement | null;
        titlePreview?.click();
        fixture.detectChanges();
        vi.runAllTimers();
        fixture.detectChanges();

        const removeAllRanges = vi.fn();
        const getSelectionSpy = vi.spyOn(window, 'getSelection').mockReturnValue({
          toString: () => '规格',
          rangeCount: 1,
          isCollapsed: false,
          removeAllRanges,
        } as unknown as Selection);

        try {
          const outsideButton = document.createElement('button');
          component.onDocumentClick(createClickEvent(Date.now(), outsideButton));
          fixture.detectChanges();

          expect(removeAllRanges).toHaveBeenCalledTimes(1);
          expect(component.isPreview()).toBe(true);
        } finally {
          getSelectionSpy.mockRestore();
        }
      } finally {
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
      }
    });

    it('should suppress the same document click when entering content editing from the empty preview button', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-05T00:00:00.000Z'));
      try {
        context.render({ content: '' });
        const fixture = context.getFixture();

        const component = fixture.componentInstance as unknown as {
          onDocumentClick: (event: MouseEvent) => void;
          isPreview: () => boolean;
        };
        const emptyPreview = fixture.nativeElement.querySelector('[data-testid="task-content-empty"]') as HTMLButtonElement | null;
        const editorRoot = fixture.nativeElement.querySelector('.animate-collapse-open') as HTMLElement | null;

        emptyPreview?.click();
        fixture.detectChanges();

        component.onDocumentClick(createPathClickEvent(emptyPreview!, [emptyPreview!, editorRoot!, document.body, document, window]));
        fixture.detectChanges();

        expect(component.isPreview()).toBe(false);
      } finally {
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
      }
    });
  });
}
