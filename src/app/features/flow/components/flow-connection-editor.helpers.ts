import type { ConnectionEditorData } from '../../../../models/flow-view-state';
import type { Task } from '../../../../models';
import {
  clearActiveTextSelection,
  hasActiveTextSelection,
  isInteractiveSelectionTarget,
} from '../../../../utils/text-selection';

export type ConnectionEditorSaveContext = Pick<ConnectionEditorData, 'sourceId' | 'targetId' | 'title' | 'description'>;

export interface ConnectionTasks {
  source: Task | null;
  target: Task | null;
}

export interface ConnectionEditorSavePayload {
  sourceId: string;
  targetId: string;
  title: string;
  description: string;
}

export interface ConnectionEditorSessionState {
  data: ConnectionEditorData;
  sessionKey: string;
  isNewSession: boolean;
  nextIsEditMode: boolean;
  currentIsEditMode: boolean;
  previousContext: ConnectionEditorSaveContext | null;
}

export interface BuildConnectionEditorSessionStateInput {
  data: ConnectionEditorData;
  readOnly: boolean;
  previousSessionKey: string | null;
  previousContext: ConnectionEditorSaveContext | null;
  currentIsEditMode: boolean;
}

export interface ShouldSkipConnectionEditorContentSyncInput {
  modeChanged: boolean;
  currentIsEditMode: boolean;
  nextIsEditMode: boolean;
  hasLastEmittedPayload: boolean;
}

export interface ConnectionEditorPosition {
  x: number;
  y: number;
}

export interface ConnectionEditorSize {
  width: number;
  height: number;
}

export interface ClampConnectionEditorPositionInput {
  position: ConnectionEditorPosition;
  viewport: ConnectionEditorSize;
  editor: ConnectionEditorSize;
  padding: number;
}

export interface ConnectionEditorDocumentInteractionContext {
  clickedInside: boolean;
  isInteractiveElement: boolean;
}

export interface ResolveConnectionEditorDocumentInteractionInput {
  target: EventTarget | null;
  editorElement: HTMLElement | null | undefined;
  closeRequested: boolean;
  ignoreOutsideUntil: number;
  isSelecting: boolean;
  now: number;
  hasSelection?: () => boolean;
  clearSelection?: () => void;
  isInteractiveTarget?: (target: HTMLElement) => boolean;
}

export interface ResolveConnectionEditorSaveContextInput {
  override?: ConnectionEditorSaveContext;
  activeSessionContext: ConnectionEditorSaveContext | null;
  data: ConnectionEditorData | null;
}

export interface ResolveConnectionEditorSavePayloadInput {
  context: ConnectionEditorSaveContext;
  draft: Pick<ConnectionEditorData, 'title' | 'description'>;
  lastEmittedPayloadKey: string | null;
}

export interface CanRunDelayedConnectionEditorActionInput {
  isDestroyed: boolean;
  closeRequested: boolean;
  sessionKey: string | null;
  lastSessionKey: string | null;
}

export interface ResolveConnectionEditorComposingClickActionInput {
  canRunDelayedAction: boolean;
  clickedInside: boolean;
  isEditMode: boolean;
}

export type ConnectionEditorComposingClickAction =
  | 'skip'
  | 'force-exit-edit'
  | 'save-and-close';

export interface ResolveConnectionEditorBlurActionInput {
  canRunDelayedAction: boolean;
  isEditMode: boolean;
  editorElement: HTMLElement | null | undefined;
  activeElement: Element | null;
  relatedTarget: EventTarget | null;
}

export type ConnectionEditorBlurAction = 'skip' | 'exit-edit';

export interface ResolvedConnectionEditorSavePayload extends ConnectionEditorSaveContext {
  payloadKey: string;
}

export function buildConnectionEditorSessionKey(data: ConnectionEditorData): string {
  return `${data.sourceId}->${data.targetId}@${data.x},${data.y}`;
}

export function buildConnectionEditorSessionState(
  input: BuildConnectionEditorSessionStateInput,
): ConnectionEditorSessionState {
  const sessionKey = buildConnectionEditorSessionKey(input.data);
  return {
    data: input.data,
    sessionKey,
    isNewSession: input.previousSessionKey !== sessionKey,
    nextIsEditMode: input.data.mode === 'edit' && !input.readOnly,
    currentIsEditMode: input.currentIsEditMode,
    previousContext: input.previousContext,
  };
}

export function shouldSkipConnectionEditorContentSync(
  input: ShouldSkipConnectionEditorContentSyncInput,
): boolean {
  return (input.modeChanged && input.currentIsEditMode && !input.nextIsEditMode)
    || input.hasLastEmittedPayload;
}

export function buildConnectionEditorPayloadKey(
  sourceId: string,
  targetId: string,
  title: string,
  description: string,
): string {
  return `${sourceId}->${targetId}|${title}|${description}`;
}

export function createConnectionEditorSaveContext(data: ConnectionEditorData): ConnectionEditorSaveContext {
  return {
    sourceId: data.sourceId,
    targetId: data.targetId,
    title: data.title || '',
    description: data.description || '',
  };
}

export function resolveConnectionEditorSavePayload(
  input: ResolveConnectionEditorSavePayloadInput,
): ResolvedConnectionEditorSavePayload | null {
  const { context, draft } = input;
  if (draft.title === context.title && draft.description === context.description) {
    return null;
  }

  const payloadKey = buildConnectionEditorPayloadKey(
    context.sourceId,
    context.targetId,
    draft.title,
    draft.description,
  );
  if (payloadKey === input.lastEmittedPayloadKey) {
    return null;
  }

  return {
    sourceId: context.sourceId,
    targetId: context.targetId,
    title: draft.title,
    description: draft.description,
    payloadKey,
  };
}

export function clampConnectionEditorPosition(
  input: ClampConnectionEditorPositionInput,
): ConnectionEditorPosition {
  return {
    x: Math.max(
      input.padding,
      Math.min(input.position.x, input.viewport.width - input.editor.width - input.padding),
    ),
    y: Math.max(
      input.padding,
      Math.min(input.position.y, input.viewport.height - input.editor.height - input.padding),
    ),
  };
}

export function resolveConnectionEditorDocumentInteraction(
  input: ResolveConnectionEditorDocumentInteractionInput,
): ConnectionEditorDocumentInteractionContext | null {
  if (
    input.closeRequested
    || !input.editorElement
    || input.now < input.ignoreOutsideUntil
    || input.isSelecting
  ) {
    return null;
  }

  const targetElement = input.target as HTMLElement | null;
  if (!targetElement) {
    return null;
  }

  const isInteractiveTarget = (
    input.isInteractiveTarget ?? isInteractiveSelectionTarget
  )(targetElement);
  const clickedInside = input.editorElement.contains(targetElement);
  const isInteractiveElement = clickedInside && isInteractiveTarget;

  if ((input.hasSelection ?? hasActiveTextSelection)()) {
    if (isInteractiveElement) {
      return null;
    }

    (input.clearSelection ?? clearActiveTextSelection)();
    if (!isInteractiveTarget) {
      return null;
    }
  }

  return { clickedInside, isInteractiveElement };
}

export function resolveConnectionEditorSaveContext(
  input: ResolveConnectionEditorSaveContextInput,
): ConnectionEditorSaveContext | null {
  if (input.override) {
    return input.override;
  }

  if (input.activeSessionContext) {
    return input.activeSessionContext;
  }

  if (!input.data) {
    return null;
  }

  return createConnectionEditorSaveContext(input.data);
}

export function canRunDelayedConnectionEditorAction(
  input: CanRunDelayedConnectionEditorActionInput,
): boolean {
  return !input.isDestroyed
    && !input.closeRequested
    && input.sessionKey !== null
    && input.sessionKey === input.lastSessionKey;
}

export function resolveConnectionEditorComposingClickAction(
  input: ResolveConnectionEditorComposingClickActionInput,
): ConnectionEditorComposingClickAction {
  if (!input.canRunDelayedAction) {
    return 'skip';
  }

  if (input.clickedInside && input.isEditMode) {
    return 'force-exit-edit';
  }

  return input.clickedInside ? 'skip' : 'save-and-close';
}

export function resolveConnectionEditorBlurAction(
  input: ResolveConnectionEditorBlurActionInput,
): ConnectionEditorBlurAction {
  if (!input.canRunDelayedAction || !input.isEditMode || !input.editorElement) {
    return 'skip';
  }

  if (
    input.editorElement.contains(input.activeElement)
    || input.editorElement.contains(input.relatedTarget as Node | null)
  ) {
    return 'skip';
  }

  return 'exit-edit';
}

export function resizeConnectionEditorTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(100, Math.max(48, textarea.scrollHeight)) + 'px';
}

export function compressConnectionDisplayId(displayId: string | undefined): string {
  if (!displayId) return '';
  if (displayId.length > 6) {
    return `${displayId.substring(0, 5)}..`;
  }
  return displayId;
}
