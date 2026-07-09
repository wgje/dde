import { describe, expect, it } from 'vitest';

import { resolveMarkdownLinkTarget, toLocalPathFileUrl } from './markdown-links';

describe('markdown link helpers', () => {
  it('resolves task, local, internal, and blocked targets', () => {
    expect(resolveMarkdownLinkTarget('task:task-123')).toEqual({
      kind: 'task',
      taskId: 'task-123',
      href: '#task:task-123',
    });
    expect(resolveMarkdownLinkTarget('C:\\Docs\\Plan.md')).toEqual({
      kind: 'local',
      localPath: 'C:\\Docs\\Plan.md',
      href: '#local-path',
    });
    expect(resolveMarkdownLinkTarget('./docs/guide')).toEqual({
      kind: 'internal',
      href: './docs/guide',
    });
    expect(resolveMarkdownLinkTarget('javascript:alert(1)')).toEqual({
      kind: 'blocked',
      href: '#__nf_blocked__',
    });
  });

  it('converts Windows and UNC paths to file URLs', () => {
    expect(toLocalPathFileUrl('C:\\Docs\\Plan.md')).toBe('file:///C:/Docs/Plan.md');
    expect(toLocalPathFileUrl('\\\\server\\share\\Plan.md')).toBe('file://server/share/Plan.md');
  });
});
