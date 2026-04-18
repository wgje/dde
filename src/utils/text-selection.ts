function isTextInputElement(element: Element | null): element is HTMLInputElement | HTMLTextAreaElement {
  if (element instanceof HTMLTextAreaElement) {
    return true;
  }

  return element instanceof HTMLInputElement;
}

function hasInputSelection(element: Element | null): boolean {
  if (!isTextInputElement(element)) {
    return false;
  }

  try {
    const selectionStart = element.selectionStart ?? 0;
    const selectionEnd = element.selectionEnd ?? selectionStart;
    return selectionStart !== selectionEnd;
  } catch {
    return false;
  }
}

export function hasActiveTextSelection(
  selection: Selection | null = window.getSelection(),
  activeElement: Element | null = document.activeElement,
): boolean {
  if (hasInputSelection(activeElement)) {
    return true;
  }

  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return false;
  }

  return selection.toString().length > 0;
}

export function isInteractiveSelectionTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  return target.closest(
    'button, input:not([type="hidden"]), textarea, select, a, summary, [role="button"], [role="link"], [contenteditable="true"]'
  ) !== null;
}

export function clearActiveTextSelection(
  selection: Selection | null = window.getSelection(),
  activeElement: Element | null = document.activeElement,
): boolean {
  let cleared = false;

  if (isTextInputElement(activeElement) && hasInputSelection(activeElement)) {
    try {
      const caret = activeElement.selectionEnd ?? activeElement.selectionStart ?? 0;
      activeElement.setSelectionRange(caret, caret);
      cleared = true;
    } catch {
      // 某些 input 类型不支持显式选区控制，忽略即可。
    }
  }

  if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
    selection.removeAllRanges();
    cleared = true;
  }

  return cleared;
}