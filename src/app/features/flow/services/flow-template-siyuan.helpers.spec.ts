import { describe, expect, it } from 'vitest';
import { getSiyuanBadgeLabel } from './flow-template-siyuan.helpers';

describe('flow-template-siyuan.helpers', () => {
  it('没有有效正序号时返回空标签', () => {
    expect(getSiyuanBadgeLabel(undefined)).toBe('');
    expect(getSiyuanBadgeLabel(0)).toBe('');
    expect(getSiyuanBadgeLabel(-1)).toBe('');
    expect(getSiyuanBadgeLabel(Number.NaN)).toBe('');
  });

  it('正序号转为文本标签', () => {
    expect(getSiyuanBadgeLabel(1)).toBe('1');
    expect(getSiyuanBadgeLabel(12)).toBe('12');
  });
});
