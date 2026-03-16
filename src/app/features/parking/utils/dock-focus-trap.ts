/**
 * 通用对话框焦点陷阱：在指定容器内循环 Tab 键焦点。
 * 从 ParkingDockComponent 提取为纯函数以减少组件行数。
 */
export function trapDialogFocus(event: KeyboardEvent, selector: string): void {
  if (typeof document === 'undefined') return;
  const container = document.querySelector<HTMLElement>(selector);
  if (!container) return;
  const focusables = Array.from(
    container.querySelectorAll<HTMLElement>(
      'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])',
    ),
  ).filter(node => !node.hasAttribute('disabled'));
  if (focusables.length === 0) {
    event.preventDefault();
    return;
  }

  const active = document.activeElement as HTMLElement | null;
  const currentIndex = focusables.findIndex(node => node === active);
  const backward = event.shiftKey;
  let nextIndex = 0;
  if (currentIndex < 0) {
    nextIndex = backward ? focusables.length - 1 : 0;
  } else if (backward) {
    nextIndex = currentIndex === 0 ? focusables.length - 1 : currentIndex - 1;
  } else {
    nextIndex = currentIndex === focusables.length - 1 ? 0 : currentIndex + 1;
  }
  event.preventDefault();
  focusables[nextIndex]?.focus();
}
