import {
  ConnectionEditorData,
  ConnectionEditorMode,
  PanelPosition,
} from '../../../../models/flow-view-state';
import { UI_CONFIG } from '../../../../config';

export type ExistingConnectionEditorAction =
  | { kind: 'none' }
  | { kind: 'preserve-edit' }
  | { kind: 'promote-mobile-preview'; data: ConnectionEditorData }
  | {
      kind: 'sync';
      data: ConnectionEditorData;
      contentChanged: boolean;
      modeChanged: boolean;
    };

interface ExistingConnectionEditorInput {
  currentEditor: ConnectionEditorData;
  title: string;
  description: string;
  requestedMode: ConnectionEditorMode;
  editorMode: ConnectionEditorMode;
  isMobile: boolean;
}

interface NewConnectionEditorDataInput {
  sourceId: string;
  targetId: string;
  title: string;
  description: string;
  isCrossTree: boolean;
  mode: ConnectionEditorMode;
  position: PanelPosition;
}

export function isSameConnectionEditor(
  currentEditor: ConnectionEditorData | null,
  sourceId: string,
  targetId: string,
  isCrossTree: boolean
): currentEditor is ConnectionEditorData {
  return !!currentEditor &&
    currentEditor.sourceId === sourceId &&
    currentEditor.targetId === targetId &&
    currentEditor.isCrossTree === isCrossTree;
}

export function resolveExistingConnectionEditorAction(
  input: ExistingConnectionEditorInput
): ExistingConnectionEditorAction {
  const syncedPreviewData = syncPreviewEditorContent(
    input.currentEditor,
    input.title,
    input.description
  );

  if (shouldPromoteMobilePreviewEditor(input)) {
    return {
      kind: 'promote-mobile-preview',
      data: {
        ...syncedPreviewData,
        mode: 'edit',
      },
    };
  }

  if (input.currentEditor.mode === 'edit' && input.requestedMode === 'preview') {
    return { kind: 'preserve-edit' };
  }

  const contentChanged =
    input.currentEditor.mode !== 'edit' &&
    (input.currentEditor.title !== input.title ||
      input.currentEditor.description !== input.description);
  const modeChanged = input.currentEditor.mode !== input.editorMode;

  if (!modeChanged && !contentChanged) {
    return { kind: 'none' };
  }

  return {
    kind: 'sync',
    data: {
      ...syncedPreviewData,
      mode: input.editorMode,
    },
    contentChanged,
    modeChanged,
  };
}

export function createConnectionEditorData(
  input: NewConnectionEditorDataInput
): ConnectionEditorData {
  return {
    sourceId: input.sourceId,
    targetId: input.targetId,
    title: input.title,
    description: input.description,
    isCrossTree: input.isCrossTree,
    mode: input.mode,
    x: input.position.x,
    y: input.position.y,
  };
}

export function scheduleConnectionEditorTextareaResize(
  isDestroyed: () => boolean
): void {
  setTimeout(() => {
    if (isDestroyed()) return;
    if (typeof document === 'undefined') return;
    const textarea = document.querySelector<HTMLTextAreaElement>('#connectionDescTextarea');
    if (!textarea) {
      return;
    }

    textarea.style.height = 'auto';
    textarea.style.height = Math.min(120, Math.max(28, textarea.scrollHeight)) + 'px';
  }, UI_CONFIG.SHORT_DELAY);
}

function syncPreviewEditorContent(
  currentEditor: ConnectionEditorData,
  title: string,
  description: string
): ConnectionEditorData {
  return currentEditor.mode === 'edit'
    ? currentEditor
    : {
        ...currentEditor,
        title,
        description,
      };
}

function shouldPromoteMobilePreviewEditor(
  input: ExistingConnectionEditorInput
): boolean {
  return input.isMobile &&
    input.currentEditor.isCrossTree &&
    input.currentEditor.mode === 'preview' &&
    input.requestedMode === 'preview';
}
