import { describe, expect, it } from 'vitest';

import {
  appendEmptyAttentionDraftRow,
  buildMobileAttachmentFileSelection,
  buildTextTaskEditorPlannerDraftState,
  buildVisibleAttentionDraftRows,
  countHiddenAttentionDraftRows,
  formatAttachmentFileSize,
  getAttachmentFileExtension,
  isEventInsideElement,
  isEventInsideTaskCard,
  normalizeTextTaskEditorCognitiveLoadSelection,
  removeAttentionDraftRowAt,
  resolveTextTaskEditorFieldElement,
  TEXT_TASK_EDITOR_MAX_ATTACHMENTS,
  TEXT_TASK_EDITOR_MAX_FILE_SIZE_BYTES,
  trimEmptyAttentionDraftRows,
  updateAttentionDraftRowText,
} from './text-task-editor.helpers';

describe('text-task-editor.helpers', () => {
  const rows = [
    { id: 'a', text: 'A', level: 'info' as const, done: false },
    { id: 'b', text: 'B', level: 'warning' as const, done: false },
    { id: 'c', text: 'C', level: 'blocker' as const, done: true },
    { id: 'd', text: 'D', level: 'info' as const, done: false },
  ];

  it('limits collapsed attention rows while preserving source indices', () => {
    expect(buildVisibleAttentionDraftRows(rows, false)).toEqual([
      { item: rows[0], index: 0 },
      { item: rows[1], index: 1 },
      { item: rows[2], index: 2 },
    ]);

    expect(buildVisibleAttentionDraftRows(rows, true)).toEqual([
      { item: rows[0], index: 0 },
      { item: rows[1], index: 1 },
      { item: rows[2], index: 2 },
      { item: rows[3], index: 3 },
    ]);
  });

  it('counts hidden attention rows only past the collapsed limit', () => {
    expect(countHiddenAttentionDraftRows(rows)).toBe(1);
    expect(countHiddenAttentionDraftRows(rows.slice(0, 2))).toBe(0);
  });

  it('builds planner draft strings from nullable task fields', () => {
    expect(buildTextTaskEditorPlannerDraftState({
      expected_minutes: 25,
      wait_minutes: null,
      cognitive_load: 'high',
    })).toEqual({
      expectedMinutes: '25',
      waitMinutes: '',
      cognitiveLoad: 'high',
    });

    expect(buildTextTaskEditorPlannerDraftState({
      expected_minutes: null,
      wait_minutes: 0,
      cognitive_load: null,
    })).toEqual({
      expectedMinutes: '',
      waitMinutes: '0',
      cognitiveLoad: '',
    });
  });

  it('normalizes cognitive load selection for local draft and persistence', () => {
    expect(normalizeTextTaskEditorCognitiveLoadSelection('high')).toEqual({
      draftValue: 'high',
      persistedValue: 'high',
    });
    expect(normalizeTextTaskEditorCognitiveLoadSelection('low')).toEqual({
      draftValue: 'low',
      persistedValue: 'low',
    });
    expect(normalizeTextTaskEditorCognitiveLoadSelection('')).toEqual({
      draftValue: '',
      persistedValue: null,
    });
  });

  it('updates sparse attention row text with default draft rows', () => {
    expect(updateAttentionDraftRowText([], 2, 'third')).toEqual([
      { text: '', level: 'info', done: false },
      { text: '', level: 'info', done: false },
      { text: 'third', level: 'info', done: false },
    ]);

    expect(updateAttentionDraftRowText(rows, 1, 'updated')[1]).toEqual({
      id: 'b',
      text: 'updated',
      level: 'warning',
      done: false,
    });
  });

  it('appends, removes, and trims attention draft rows without mutating the source', () => {
    const appended = appendEmptyAttentionDraftRow(rows);
    expect(appended).toHaveLength(5);
    expect(appended[4]).toEqual({ text: '', level: 'info', done: false });
    expect(rows).toHaveLength(4);

    expect(removeAttentionDraftRowAt(rows, 1)).toEqual([rows[0], rows[2], rows[3]]);
    expect(trimEmptyAttentionDraftRows([
      rows[0],
      { text: '   ', level: 'info', done: false },
      rows[1],
    ])).toEqual([rows[0], rows[1]]);
  });

  it('formats attachment display metadata like the component did inline', () => {
    expect(getAttachmentFileExtension('archive.tar.gz')).toBe('gz');
    expect(getAttachmentFileExtension('README')).toBe('READ');
    expect(getAttachmentFileExtension('presentation.longextension')).toBe('long');

    expect(formatAttachmentFileSize(undefined)).toBe('');
    expect(formatAttachmentFileSize(0)).toBe('');
    expect(formatAttachmentFileSize(512)).toBe('512B');
    expect(formatAttachmentFileSize(1536)).toBe('1.5KB');
    expect(formatAttachmentFileSize(2 * 1024 * 1024)).toBe('2.0MB');
  });

  it('plans mobile attachment uploads by remaining slots and file size', () => {
    const smallFile = { name: 'small.txt', size: 1024 } as File;
    const extraFile = { name: 'extra.txt', size: 2048 } as File;
    const oversizedFile = {
      name: 'large.mov',
      size: TEXT_TASK_EDITOR_MAX_FILE_SIZE_BYTES + 1,
    } as File;

    expect(buildMobileAttachmentFileSelection(
      [smallFile, extraFile] as unknown as FileList,
      TEXT_TASK_EDITOR_MAX_ATTACHMENTS - 1,
    )).toEqual({
      remainingSlots: 1,
      filesToUpload: [smallFile],
      oversizedFile: null,
    });

    expect(buildMobileAttachmentFileSelection(
      [smallFile, oversizedFile] as unknown as FileList,
      TEXT_TASK_EDITOR_MAX_ATTACHMENTS - 2,
    )).toEqual({
      remainingSlots: 2,
      filesToUpload: [smallFile, oversizedFile],
      oversizedFile,
    });

    expect(buildMobileAttachmentFileSelection(
      [smallFile] as unknown as FileList,
      TEXT_TASK_EDITOR_MAX_ATTACHMENTS,
    )).toEqual({
      remainingSlots: 0,
      filesToUpload: [],
      oversizedFile: null,
    });
  });

  it('detects clicks inside the editor from composedPath or target containment', () => {
    const host = document.createElement('section');
    const child = document.createElement('button');
    host.appendChild(child);

    expect(isEventInsideElement({ target: document.body, composedPath: () => [child, host] } as unknown as Event, host)).toBe(true);
    expect(isEventInsideElement({ target: child, composedPath: () => [] } as unknown as Event, host)).toBe(true);
    expect(isEventInsideElement({ target: document.body, composedPath: () => [] } as unknown as Event, host)).toBe(false);
  });

  it('detects clicks inside the current task card from composedPath or closest fallback', () => {
    const card = document.createElement('article');
    card.setAttribute('data-task-id', 'task-1');
    const child = document.createElement('button');
    card.appendChild(child);

    expect(isEventInsideTaskCard({ target: document.body, composedPath: () => [card] } as unknown as Event, 'task-1')).toBe(true);
    expect(isEventInsideTaskCard({ target: child, composedPath: () => [] } as unknown as Event, 'task-1')).toBe(true);
    expect(isEventInsideTaskCard({ target: child, composedPath: () => [] } as unknown as Event, 'task-2')).toBe(false);
  });

  it('resolves editor field elements from the component host', () => {
    const host = document.createElement('section');
    const titleInput = document.createElement('input');
    titleInput.setAttribute('data-testid', 'task-title-input');
    const contentEditor = document.createElement('textarea');
    contentEditor.setAttribute('data-testid', 'task-content-editor');
    host.append(titleInput, contentEditor);

    expect(resolveTextTaskEditorFieldElement(host, 'title')).toBe(titleInput);
    expect(resolveTextTaskEditorFieldElement(host, 'content')).toBe(contentEditor);
    expect(resolveTextTaskEditorFieldElement(null, 'title')).toBeNull();
  });
});
