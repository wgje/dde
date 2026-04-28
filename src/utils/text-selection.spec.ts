import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearActiveTextSelection,
  hasActiveTextSelection,
  isInteractiveSelectionTarget,
} from './text-selection';

describe('text-selection — hasActiveTextSelection', () => {
  let input: HTMLInputElement;
  let textarea: HTMLTextAreaElement;

  beforeEach(() => {
    input = document.createElement('input');
    input.type = 'text';
    input.value = 'hello world';
    document.body.appendChild(input);

    textarea = document.createElement('textarea');
    textarea.value = 'some text';
    document.body.appendChild(textarea);
  });

  afterEach(() => {
    input.remove();
    textarea.remove();
    window.getSelection()?.removeAllRanges();
  });

  it('input 中有选区返回 true', () => {
    input.focus();
    input.setSelectionRange(0, 5);
    expect(hasActiveTextSelection(null, input)).toBe(true);
  });

  it('input 无选区返回 false（当页面无文本选区时）', () => {
    input.focus();
    input.setSelectionRange(3, 3); // caret only
    expect(hasActiveTextSelection(null, input)).toBe(false);
  });

  it('textarea 中有选区返回 true', () => {
    textarea.focus();
    textarea.setSelectionRange(0, 4);
    expect(hasActiveTextSelection(null, textarea)).toBe(true);
  });

  it('selection=null 且无输入元素选区 → false', () => {
    expect(hasActiveTextSelection(null, document.body)).toBe(false);
  });

  it('selection 为 collapsed → false', () => {
    const fakeSelection = {
      rangeCount: 1,
      isCollapsed: true,
      toString: () => '',
    } as unknown as Selection;
    expect(hasActiveTextSelection(fakeSelection, document.body)).toBe(false);
  });

  it('selection 非 collapsed 且有文本 → true', () => {
    const fakeSelection = {
      rangeCount: 1,
      isCollapsed: false,
      toString: () => 'selected',
    } as unknown as Selection;
    expect(hasActiveTextSelection(fakeSelection, document.body)).toBe(true);
  });

  it('selection.rangeCount 为 0 → false', () => {
    const fakeSelection = {
      rangeCount: 0,
      isCollapsed: true,
      toString: () => '',
    } as unknown as Selection;
    expect(hasActiveTextSelection(fakeSelection, document.body)).toBe(false);
  });
});

describe('text-selection — isInteractiveSelectionTarget', () => {
  it('对 button 返回 true', () => {
    const btn = document.createElement('button');
    expect(isInteractiveSelectionTarget(btn)).toBe(true);
  });

  it('对嵌套在 button 中的子元素返回 true（closest 匹配）', () => {
    const btn = document.createElement('button');
    const span = document.createElement('span');
    btn.appendChild(span);
    expect(isInteractiveSelectionTarget(span)).toBe(true);
  });

  it('对 input[type=text] 返回 true', () => {
    const input = document.createElement('input');
    input.type = 'text';
    expect(isInteractiveSelectionTarget(input)).toBe(true);
  });

  it('对 input[type=hidden] 返回 false', () => {
    const input = document.createElement('input');
    input.type = 'hidden';
    expect(isInteractiveSelectionTarget(input)).toBe(false);
  });

  it('对 a 标签返回 true', () => {
    const a = document.createElement('a');
    expect(isInteractiveSelectionTarget(a)).toBe(true);
  });

  it('对 [contenteditable="true"] 返回 true', () => {
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    expect(isInteractiveSelectionTarget(div)).toBe(true);
  });

  it('对 [role="button"] 返回 true', () => {
    const div = document.createElement('div');
    div.setAttribute('role', 'button');
    expect(isInteractiveSelectionTarget(div)).toBe(true);
  });

  it('对普通 div 返回 false', () => {
    const div = document.createElement('div');
    expect(isInteractiveSelectionTarget(div)).toBe(false);
  });

  it('对 null 返回 false', () => {
    expect(isInteractiveSelectionTarget(null)).toBe(false);
  });

  it('对非 Element 目标返回 false', () => {
    expect(isInteractiveSelectionTarget({} as EventTarget)).toBe(false);
  });
});

describe('text-selection — clearActiveTextSelection', () => {
  let input: HTMLInputElement;

  beforeEach(() => {
    input = document.createElement('input');
    input.type = 'text';
    input.value = 'abcdef';
    document.body.appendChild(input);
  });

  afterEach(() => {
    input.remove();
    window.getSelection()?.removeAllRanges();
  });

  it('input 中有选区时清除并返回 true', () => {
    input.focus();
    input.setSelectionRange(1, 4);
    const cleared = clearActiveTextSelection(null, input);
    expect(cleared).toBe(true);
    expect(input.selectionStart).toBe(input.selectionEnd);
  });

  it('input 无选区 & selection 为空 → 返回 false', () => {
    input.focus();
    input.setSelectionRange(2, 2);
    const cleared = clearActiveTextSelection(null, input);
    expect(cleared).toBe(false);
  });

  it('存在非 collapsed 的 window selection 时清除并返回 true', () => {
    const removeAllRanges = (): void => {
      /* mock */
    };
    const fakeSelection = {
      rangeCount: 1,
      isCollapsed: false,
      removeAllRanges,
    } as unknown as Selection;
    const spy = { called: false };
    fakeSelection.removeAllRanges = () => {
      spy.called = true;
    };
    const cleared = clearActiveTextSelection(fakeSelection, document.body);
    expect(cleared).toBe(true);
    expect(spy.called).toBe(true);
  });

  it('selection 处于 collapsed 状态时不尝试清除', () => {
    let removed = false;
    const fakeSelection = {
      rangeCount: 1,
      isCollapsed: true,
      removeAllRanges: () => {
        removed = true;
      },
    } as unknown as Selection;
    const cleared = clearActiveTextSelection(fakeSelection, document.body);
    expect(cleared).toBe(false);
    expect(removed).toBe(false);
  });
});
