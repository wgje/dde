import type { ElementRef } from '@angular/core';

import {
  isEventInsideElement,
  isEventInsideTaskCard,
  resolveTextTaskEditorFieldElement,
} from './text-task-editor.helpers';

export interface TextTaskEditorFocusControllerOptions {
  elementRef: ElementRef<HTMLElement>;
  taskId: () => string;
}

export class TextTaskEditorFocusController {
  private focusRequestTimer: ReturnType<typeof setTimeout> | null = null;
  private suppressNextDocumentClick = false;
  private clearDocumentClickGuardTimer: ReturnType<typeof setTimeout> | null = null;
  private skipNextEditorAutoSelect = false;

  constructor(private readonly options: TextTaskEditorFocusControllerOptions) {}

  consumeSuppressedDocumentClick(): boolean {
    if (!this.suppressNextDocumentClick) {
      return false;
    }

    this.skipNextEditorAutoSelect = true;
    setTimeout(() => {
      this.skipNextEditorAutoSelect = false;
    }, 0);
    this.clearDocumentClickGuard();
    return true;
  }

  focusEditorField(field: 'title' | 'content'): void {
    this.clearFocusRequestTimer();
    this.focusRequestTimer = setTimeout(() => {
      const input = this.resolveEditorFieldElement(field);

      input?.focus();
      if (this.skipNextEditorAutoSelect) {
        this.skipNextEditorAutoSelect = false;
      } else {
        input?.select?.();
      }
      this.focusRequestTimer = null;
    }, 0);
  }

  armOutsideClickGuard(triggerEvent?: Event): void {
    if (!triggerEvent) {
      return;
    }

    this.suppressNextDocumentClick = true;
    if (this.clearDocumentClickGuardTimer) {
      clearTimeout(this.clearDocumentClickGuardTimer);
    }

    this.clearDocumentClickGuardTimer = setTimeout(() => {
      this.clearDocumentClickGuard();
    }, 0);
  }

  isEventInsideEditor(event: Event): boolean {
    return isEventInsideElement(event, this.options.elementRef.nativeElement);
  }

  isEventInsideCurrentTaskCard(event: Event): boolean {
    return isEventInsideTaskCard(event, this.options.taskId());
  }

  clearDocumentClickGuard(): void {
    this.suppressNextDocumentClick = false;
    if (!this.clearDocumentClickGuardTimer) {
      return;
    }

    clearTimeout(this.clearDocumentClickGuardTimer);
    this.clearDocumentClickGuardTimer = null;
  }

  clearFocusRequestTimer(): void {
    if (!this.focusRequestTimer) {
      return;
    }

    clearTimeout(this.focusRequestTimer);
    this.focusRequestTimer = null;
  }

  private resolveEditorFieldElement(field: 'title' | 'content'): HTMLInputElement | HTMLTextAreaElement | null {
    return resolveTextTaskEditorFieldElement(this.options.elementRef.nativeElement, field);
  }
}
