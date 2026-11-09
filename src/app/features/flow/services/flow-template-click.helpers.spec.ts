import { describe, expect, it } from 'vitest';
import {
  resolveNodeClickInputState,
  resolveNodeClickModifierState,
  shouldIgnoreNodeTemplateClick,
} from './flow-template-click.helpers';

describe('flow-template-click.helpers', () => {
  it('合并 GoJS 当前事件、lastInput 与 DOM 事件中的选择修饰键', () => {
    expect(resolveNodeClickModifierState({
      eventShift: false,
      eventControl: false,
      eventMeta: false,
      lastInputShift: true,
      lastInputControl: false,
      lastInputMeta: false,
      domShiftKey: false,
      domCtrlKey: false,
      domMetaKey: false,
    })).toBe(true);

    expect(resolveNodeClickModifierState({
      eventShift: false,
      eventControl: false,
      eventMeta: false,
      lastInputShift: false,
      lastInputControl: false,
      lastInputMeta: false,
      domShiftKey: false,
      domCtrlKey: true,
      domMetaKey: false,
    })).toBe(true);
  });

  it('没有任何修饰键时返回 false', () => {
    expect(resolveNodeClickModifierState({
      eventShift: false,
      eventControl: false,
      eventMeta: false,
      lastInputShift: false,
      lastInputControl: false,
      lastInputMeta: false,
      domShiftKey: false,
      domCtrlKey: false,
      domMetaKey: false,
    })).toBe(false);
  });

  it('解析节点点击输入状态时合并移动端、框选工具和修饰键', () => {
    expect(resolveNodeClickInputState({
      isMobileMode: true,
      event: {
        control: false,
        meta: false,
        shift: false,
        event: { ctrlKey: false, metaKey: true, shiftKey: false } as MouseEvent,
        diagram: {
          lastInput: { control: false, meta: false, shift: false },
          toolManager: { dragSelectingTool: { isEnabled: true } },
        },
      },
    })).toEqual({
      isMobileMode: true,
      isDragSelectEnabled: true,
      isSelectModifierPressed: true,
    });
  });

  it('拖拽、双击或已处理事件应忽略节点点击', () => {
    expect(shouldIgnoreNodeTemplateClick({
      handled: false,
      diagram: {
        lastInput: { clickCount: 1 },
        toolManager: { draggingTool: { isActive: true } },
      },
    })).toBe(true);

    expect(shouldIgnoreNodeTemplateClick({
      handled: false,
      diagram: {
        lastInput: { clickCount: 2 },
        toolManager: { draggingTool: { isActive: false } },
      },
    })).toBe(true);

    expect(shouldIgnoreNodeTemplateClick({
      handled: true,
      diagram: {
        lastInput: { clickCount: 1 },
        toolManager: { draggingTool: { isActive: false } },
      },
    })).toBe(true);
  });

  it('普通单击未被处理时不忽略节点点击', () => {
    expect(shouldIgnoreNodeTemplateClick({
      handled: false,
      diagram: {
        lastInput: { clickCount: 1 },
        toolManager: { draggingTool: { isActive: false } },
      },
    })).toBe(false);
  });
});
