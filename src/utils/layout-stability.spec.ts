import { describe, expect, it } from 'vitest';
import { shouldAutoCloseSidebarOnViewportChange } from './layout-stability';

describe('shouldAutoCloseSidebarOnViewportChange', () => {
  it('桌面切到移动端时应自动收起侧边栏', () => {
    expect(shouldAutoCloseSidebarOnViewportChange(false, true)).toBe(true);
  });

  it('移动端内部 resize 不应自动收起侧边栏', () => {
    expect(shouldAutoCloseSidebarOnViewportChange(true, true)).toBe(false);
  });

  it('移动端切回桌面端不应自动收起侧边栏', () => {
    expect(shouldAutoCloseSidebarOnViewportChange(true, false)).toBe(false);
  });

  it('桌面端内部 resize 不应自动收起侧边栏', () => {
    expect(shouldAutoCloseSidebarOnViewportChange(false, false)).toBe(false);
  });
});
