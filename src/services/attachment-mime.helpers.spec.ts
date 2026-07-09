import { describe, expect, it } from 'vitest';
import {
  isAttachmentImageMimeType,
  resolveAttachmentType,
} from './attachment-mime.helpers';

describe('attachment-mime.helpers', () => {
  it('根据 MIME 类型分类附件', () => {
    expect(resolveAttachmentType('image/png')).toBe('image');
    expect(resolveAttachmentType('application/pdf')).toBe('document');
    expect(resolveAttachmentType('application/octet-stream')).toBe('file');
  });

  it('识别图片 MIME 类型', () => {
    expect(isAttachmentImageMimeType('image/jpeg')).toBe(true);
    expect(isAttachmentImageMimeType('application/pdf')).toBe(false);
  });
});
