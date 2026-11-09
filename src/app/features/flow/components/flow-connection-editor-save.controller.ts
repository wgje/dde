import type { ConnectionEditorSaveContext } from './flow-connection-editor.helpers';

interface FlowConnectionEditorSaveControllerOptions {
  close: () => void;
  debug: (message: string) => void;
  getActiveSessionContext: () => ConnectionEditorSaveContext | null;
  getNow: () => number;
  getSaveTimer: () => ReturnType<typeof setTimeout> | null;
  isComposing: () => boolean;
  isDestroyed: () => boolean;
  isEditMode: () => boolean;
  queueCompositionAction: (kind: 'save-and-close') => void;
  refocusInput: () => void;
  saveContent: (contextOverride?: ConnectionEditorSaveContext) => void;
  setSaveTimer: (timer: ReturnType<typeof setTimeout> | null) => void;
  setIgnoreOutsideUntil: (timestamp: number) => void;
  syncEditorStateFromDom: () => void;
}

export class FlowConnectionEditorSaveController {
  private closeRequested = false;
  private hasPendingSave = false;

  constructor(
    private readonly options: FlowConnectionEditorSaveControllerOptions,
  ) {}

  isCloseRequested(): boolean {
    return this.closeRequested;
  }

  resetCloseRequested(): void {
    this.closeRequested = false;
  }

  saveAndClose(): void {
    if (this.options.isDestroyed() || this.closeRequested) {
      return;
    }

    this.closeRequested = true;
    this.options.setIgnoreOutsideUntil(this.options.getNow() + 250);
    this.options.syncEditorStateFromDom();

    if (this.options.isComposing()) {
      this.options.debug('IME 输入中，等待 compositionend 后保存并关闭');
      this.options.queueCompositionAction('save-and-close');
      return;
    }

    this.completeSaveAndClose(this.options.getActiveSessionContext());
  }

  completeSaveAndClose(context: ConnectionEditorSaveContext | null): void {
    if (this.options.isDestroyed()) {
      return;
    }

    this.options.syncEditorStateFromDom();
    this.persistCurrentEdits(context ?? undefined);
    this.options.close();
  }

  persistCurrentEdits(context?: ConnectionEditorSaveContext): void {
    this.clearPendingSave();
    this.options.syncEditorStateFromDom();
    this.options.saveContent(context);
  }

  scheduleDebouncedSave(): void {
    if (this.options.isDestroyed()) {
      return;
    }

    this.clearPendingSave();
    this.hasPendingSave = true;
    this.options.setSaveTimer(setTimeout(() => {
      if (this.options.isDestroyed()) {
        return;
      }

      this.options.setSaveTimer(null);
      if (this.options.isComposing()) {
        return;
      }

      this.hasPendingSave = false;
      this.options.saveContent();
    }, 500));
  }

  flushPendingSaveOnDestroy(context: ConnectionEditorSaveContext | null): void {
    if (!this.hasPendingSave && this.options.getSaveTimer() === null) {
      return;
    }

    this.clearPendingSave();
    if (!context) {
      return;
    }

    try {
      this.options.saveContent(context);
    } catch {
      // Ignore save failures during destroy so teardown can complete.
    }
  }

  resumeAfterSaveFailure(): void {
    if (this.options.isDestroyed()) {
      return;
    }

    this.closeRequested = false;
    this.options.setIgnoreOutsideUntil(0);
    if (this.options.isEditMode()) {
      this.options.refocusInput();
    }
  }

  private clearPendingSave(): void {
    this.hasPendingSave = false;
    const saveTimer = this.options.getSaveTimer();
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      this.options.setSaveTimer(null);
    }
  }
}
