import { describe, expect, it } from 'vitest';
import type { TaskAttentionDraftItem } from '../../../../models';
import {
  appendEmptyAttentionDraftRow,
  buildAttentionDraftRowsFromMeta,
  buildAttentionDraftRowsFromText,
  buildVisibleAttentionDraftRows,
  countHiddenAttentionDraftRows,
  removeAttentionDraftRowAt,
  trimEmptyAttentionDraftRows,
  updateAttentionDraftRow,
} from './flow-task-detail-attention-draft.helpers';

describe('flow task detail attention draft helpers', () => {
  it('preserves existing attention item identity when text still matches', () => {
    const rows = buildAttentionDraftRowsFromText('Token refresh\n权限复核', {
      items: [
        {
          id: 'attention-1',
          text: 'Token refresh',
          level: 'warning',
          done: false,
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        },
      ],
      updatedAt: '2026-06-01T00:00:00.000Z',
    });

    expect(rows).toEqual([
      expect.objectContaining({ id: 'attention-1', text: 'Token refresh', level: 'warning' }),
      expect.objectContaining({ id: undefined, text: '权限复核', level: 'info' }),
    ]);
  });

  it('updates sparse row edits and appends empty rows without sharing mutable objects', () => {
    const rows = updateAttentionDraftRow([], 2, '上线前检查');
    const appended = appendEmptyAttentionDraftRow(rows);

    expect(rows.map(row => row.text)).toEqual(['', '', '上线前检查']);
    expect(appended).toHaveLength(4);
    expect(appended[3]).not.toBe(appended[1]);
  });

  it('calculates collapsed rows and trims empty rows', () => {
    const rows: TaskAttentionDraftItem[] = [
      { text: 'A', level: 'info', done: false },
      { text: 'B', level: 'info', done: false },
      { text: 'C', level: 'info', done: false },
      { text: 'D', level: 'info', done: false },
      { text: ' ', level: 'info', done: false },
    ];

    expect(buildVisibleAttentionDraftRows(rows, false).map(row => row.item.text)).toEqual(['A', 'B', 'C']);
    expect(countHiddenAttentionDraftRows(rows)).toBe(2);
    expect(removeAttentionDraftRowAt(rows, 1).map(row => row.text)).toEqual(['A', 'C', 'D', ' ']);
    expect(trimEmptyAttentionDraftRows(rows).map(row => row.text)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('drops done and blank persisted attention items when restoring metadata', () => {
    const rows = buildAttentionDraftRowsFromMeta({
      items: [
        { id: 'a', text: ' 保留 ', level: 'info', done: false, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' },
        { id: 'b', text: '完成项', level: 'info', done: true, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' },
        { id: 'c', text: ' ', level: 'info', done: false, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' },
      ],
      updatedAt: '2026-06-01T00:00:00.000Z',
    });

    expect(rows).toEqual([expect.objectContaining({ id: 'a', text: '保留' })]);
  });
});
