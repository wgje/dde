/**
 * 仅在断点从桌面切到移动端时自动收起侧边栏。
 * 避免移动端地址栏/键盘触发的 resize 造成非预期布局抖动。
 */
export function shouldAutoCloseSidebarOnViewportChange(
  previousIsMobile: boolean,
  nextIsMobile: boolean
): boolean {
  return !previousIsMobile && nextIsMobile;
}
