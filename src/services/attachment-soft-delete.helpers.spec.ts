import { describe, expect, it } from 'vitest';
import type { Attachment } from '../models';
import {
  filterActiveAttachments,
  isDeletedAttachment,
  markAttachmentAsDeleted,
  restoreDeletedAttachment,
} from './attachment-soft-delete.helpers';

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: overrides.id ?? 'attachment-1',
    type: overrides.type ?? 'file',
    name: overrides.name ?? 'file.txt',
    url: overrides.url ?? 'https://example.com/file.txt',
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    deletedAt: overrides.deletedAt,
  };
}

describe('attachment-soft-delete.helpers', () => {
  it('标记软删除时写入指定 deletedAt 时间', () => {
    expect(markAttachmentAsDeleted(
      attachment(),
      '2026-01-02T00:00:00.000Z',
    )).toEqual({
      ...attachment(),
      deletedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('恢复附件时移除 deletedAt', () => {
    const restored = restoreDeletedAttachment(attachment({
      deletedAt: '2026-01-02T00:00:00.000Z',
    }));

    expect(isDeletedAttachment(restored)).toBe(false);
    expect(restored.deletedAt).toBeUndefined();
  });

  it('只保留未软删除附件', () => {
    const active = attachment({ id: 'active' });
    const deleted = attachment({ id: 'deleted', deletedAt: '2026-01-02T00:00:00.000Z' });

    expect(filterActiveAttachments([active, deleted])).toEqual([active]);
  });
});
