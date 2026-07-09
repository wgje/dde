import { describe, expect, it } from 'vitest';
import {
  buildAttachmentStoragePath,
  isValidAttachmentPathSegment,
  sanitizeAttachmentPathSegment,
} from './attachment-storage-path.helpers';

describe('attachment-storage-path.helpers', () => {
  it('清理文件扩展名中的路径遍历和不安全字符', () => {
    expect(sanitizeAttachmentPathSegment('../evil/.p<d>f')).toBe('evil.pdf');
    expect(sanitizeAttachmentPathSegment(' image/png ')).toBe('imagepng');
    expect(sanitizeAttachmentPathSegment("bad\x00name")).toBe('badname');
  });

  it('只允许安全路径段', () => {
    expect(isValidAttachmentPathSegment('user_123-abc')).toBe(true);
    expect(isValidAttachmentPathSegment('')).toBe(false);
    expect(isValidAttachmentPathSegment('../user')).toBe(false);
    expect(isValidAttachmentPathSegment('user/name')).toBe(false);
    expect(isValidAttachmentPathSegment('x'.repeat(256))).toBe(false);
  });

  it('构建统一附件存储路径并清洗扩展名', () => {
    expect(buildAttachmentStoragePath({
      userId: 'user-1',
      projectId: 'project-1',
      taskId: 'task-1',
      attachmentId: 'attachment-1',
      fileName: 'report..final.p<d>f',
    })).toBe('user-1/project-1/task-1/attachment-1.pdf');
  });
});
