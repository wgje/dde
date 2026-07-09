import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ConnectionEditorData,
  ConnectionEditorMode,
} from '../../../../models/flow-view-state';
import { UI_CONFIG } from '../../../../config';
import {
  createConnectionEditorData,
  isSameConnectionEditor,
  resolveExistingConnectionEditorAction,
  scheduleConnectionEditorTextareaResize,
} from './flow-link-editor-state.helpers';

function editor(overrides: Partial<ConnectionEditorData> = {}): ConnectionEditorData {
  return {
    sourceId: 'source-task',
    targetId: 'target-task',
    title: 'Old title',
    description: 'Old description',
    isCrossTree: true,
    mode: 'preview',
    x: 120,
    y: 220,
    ...overrides,
  };
}

function resolveAction(overrides: Partial<{
  currentEditor: ConnectionEditorData;
  title: string;
  description: string;
  requestedMode: ConnectionEditorMode;
  editorMode: ConnectionEditorMode;
  isMobile: boolean;
}> = {}) {
  return resolveExistingConnectionEditorAction({
    currentEditor: editor(),
    title: 'New title',
    description: 'New description',
    requestedMode: 'preview',
    editorMode: 'preview',
    isMobile: false,
    ...overrides,
  });
}

describe('flow-link-editor-state.helpers', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.querySelector('#connectionDescTextarea')?.remove();
  });

  it('detects whether an open editor already represents the same connection', () => {
    expect(isSameConnectionEditor(editor(), 'source-task', 'target-task', true)).toBe(true);
    expect(isSameConnectionEditor(editor(), 'source-task', 'other-task', true)).toBe(false);
    expect(isSameConnectionEditor(editor(), 'source-task', 'target-task', false)).toBe(false);
    expect(isSameConnectionEditor(null, 'source-task', 'target-task', true)).toBe(false);
  });

  it('promotes mobile cross-tree preview reopen to edit mode', () => {
    expect(resolveAction({ isMobile: true })).toEqual({
      kind: 'promote-mobile-preview',
      data: {
        ...editor(),
        title: 'New title',
        description: 'New description',
        mode: 'edit',
      },
    });
  });

  it('preserves an existing edit session when a preview open arrives', () => {
    expect(resolveAction({
      currentEditor: editor({ mode: 'edit' }),
      requestedMode: 'preview',
      editorMode: 'preview',
    })).toEqual({ kind: 'preserve-edit' });
  });

  it('syncs preview content and mode when they change', () => {
    expect(resolveAction({
      requestedMode: 'edit',
      editorMode: 'edit',
    })).toEqual({
      kind: 'sync',
      data: {
        ...editor(),
        title: 'New title',
        description: 'New description',
        mode: 'edit',
      },
      contentChanged: true,
      modeChanged: true,
    });

    expect(resolveAction({
      title: 'Old title',
      description: 'Old description',
    })).toEqual({ kind: 'none' });
  });

  it('creates new connection editor data from normalized inputs', () => {
    expect(createConnectionEditorData({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: 'Title',
      description: 'Description',
      isCrossTree: false,
      mode: 'preview',
      position: { x: 12, y: 34 },
    })).toEqual({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: 'Title',
      description: 'Description',
      isCrossTree: false,
      mode: 'preview',
      x: 12,
      y: 34,
    });
  });

  it('resizes the connection textarea after the configured delay', () => {
    vi.useFakeTimers();
    const textarea = document.createElement('textarea');
    textarea.id = 'connectionDescTextarea';
    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 88 });
    document.body.appendChild(textarea);

    scheduleConnectionEditorTextareaResize(() => false);
    vi.advanceTimersByTime(UI_CONFIG.SHORT_DELAY);

    expect(textarea.style.height).toBe('88px');
  });

  it('skips textarea resize when the owner has been destroyed', () => {
    vi.useFakeTimers();
    const textarea = document.createElement('textarea');
    textarea.id = 'connectionDescTextarea';
    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 88 });
    document.body.appendChild(textarea);

    scheduleConnectionEditorTextareaResize(() => true);
    vi.advanceTimersByTime(UI_CONFIG.SHORT_DELAY);

    expect(textarea.style.height).toBe('');
  });
});
