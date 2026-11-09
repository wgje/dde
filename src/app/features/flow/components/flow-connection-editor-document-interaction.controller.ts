import {
  canRunDelayedConnectionEditorAction,
  type ConnectionEditorDocumentInteractionContext,
} from './flow-connection-editor.helpers';

interface FlowConnectionEditorDocumentInteractionControllerOptions {
  closeRequested: () => boolean;
  currentSessionKey: () => string | null;
  debug: (message: string) => void;
  exitEditMode: () => void;
  isComposing: () => boolean;
  isDestroyed: () => boolean;
  isEditMode: () => boolean;
  queueCompositionAction: (kind: 'exit-edit') => void;
  resolveInteraction: (target: EventTarget | null) => ConnectionEditorDocumentInteractionContext | null;
  saveAndClose: () => void;
}

export class FlowConnectionEditorDocumentInteractionController {
  constructor(
    private readonly options: FlowConnectionEditorDocumentInteractionControllerOptions,
  ) {}

  handleClick(target: EventTarget | null): void {
    const context = this.options.resolveInteraction(target);
    if (!context) {
      return;
    }

    if (!this.options.isEditMode()) {
      if (!context.clickedInside) {
        this.options.saveAndClose();
      }
      return;
    }

    if (context.isInteractiveElement) {
      this.options.debug('点击可交互元素，保持编辑模式');
      return;
    }
    if (this.options.isComposing()) {
      if (context.clickedInside) {
        this.options.queueCompositionAction('exit-edit');
      } else {
        this.options.saveAndClose();
      }
      return;
    }
    if (context.clickedInside) {
      this.options.debug('点击编辑器空白区域，退出编辑模式');
      this.options.exitEditMode();
      return;
    }

    this.options.debug('点击编辑器外部，保存并关闭');
    this.options.saveAndClose();
  }

  handleTouchStart(target: EventTarget | null): void {
    if (this.options.isDestroyed()) {
      return;
    }

    const context = this.options.resolveInteraction(target);
    if (!context) {
      return;
    }
    const wasEditMode = this.options.isEditMode();
    if (this.options.isComposing()) {
      this.options.debug('正在 IME 输入中，等待 compositionend 后处理触摸事件');
    }
    if (!wasEditMode) {
      if (!context.clickedInside) {
        this.options.saveAndClose();
      }
      return;
    }
    if (context.isInteractiveElement) {
      this.options.debug('触摸可交互元素，保持编辑模式');
      return;
    }

    this.options.debug(
      context.clickedInside
        ? '触摸编辑器空白区域，退出编辑模式'
        : '触摸编辑器外部，保存并切换到预览模式',
    );
    if (this.options.isComposing()) {
      this.options.queueCompositionAction('exit-edit');
      return;
    }

    const sessionKey = this.options.currentSessionKey();
    setTimeout(() => {
      if (!canRunDelayedConnectionEditorAction({
        isDestroyed: this.options.isDestroyed(),
        closeRequested: this.options.closeRequested(),
        sessionKey,
        lastSessionKey: this.options.currentSessionKey(),
      })) {
        return;
      }
      this.options.exitEditMode();
    }, 50);
  }
}
