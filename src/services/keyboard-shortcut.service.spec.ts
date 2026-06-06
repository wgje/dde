import { vi, describe, it, expect } from 'vitest';
import { KeyboardShortcutService } from './keyboard-shortcut.service';
import { showBlackBoxPanel } from '../state/focus-stores';

type KeyboardShortcutPrivate = {
  shouldIgnore: (event: KeyboardEvent) => boolean;
  handleUndoRedo: (event: KeyboardEvent, key: string) => boolean;
  handleSearch: (event: KeyboardEvent, key: string) => boolean;
  handleBlackBox: (event: KeyboardEvent, key: string) => boolean;
  taskOpsAdapter: { performUndo: ReturnType<typeof vi.fn>; performRedo: ReturnType<typeof vi.fn> };
  uiState: { sidebarOpen: { set: ReturnType<typeof vi.fn> } };
};

function createContext(): KeyboardShortcutPrivate {
  const context = Object.create(KeyboardShortcutService.prototype) as KeyboardShortcutPrivate;
  context.taskOpsAdapter = { performUndo: vi.fn(), performRedo: vi.fn() };
  context.uiState = { sidebarOpen: { set: vi.fn() } };
  return context;
}

function makeEvent(partial: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    defaultPrevented: false,
    preventDefault: vi.fn(),
    ...partial,
  } as unknown as KeyboardEvent;
}

describe('KeyboardShortcutService shouldIgnore', () => {
  it('无 Ctrl/Meta 修饰键时应忽略', () => {
    const context = createContext();
    expect(context.shouldIgnore(makeEvent({ key: 'z' }))).toBe(true);
  });

  it('defaultPrevented 时应忽略', () => {
    const context = createContext();
    expect(context.shouldIgnore(makeEvent({ key: 'z', ctrlKey: true, defaultPrevented: true }))).toBe(true);
  });

  it('Ctrl+按键时不应忽略', () => {
    const context = createContext();
    expect(context.shouldIgnore(makeEvent({ key: 'z', ctrlKey: true }))).toBe(false);
  });
});

describe('KeyboardShortcutService 撤销/重做', () => {
  it('Ctrl+Z 触发撤销', () => {
    const context = createContext();
    const event = makeEvent({ key: 'z', ctrlKey: true });
    expect(context.handleUndoRedo(event, 'z')).toBe(true);
    expect(context.taskOpsAdapter.performUndo).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+Shift+Z 触发重做', () => {
    const context = createContext();
    expect(context.handleUndoRedo(makeEvent({ key: 'z', ctrlKey: true, shiftKey: true }), 'z')).toBe(true);
    expect(context.taskOpsAdapter.performRedo).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+Y 触发重做', () => {
    const context = createContext();
    expect(context.handleUndoRedo(makeEvent({ key: 'y', ctrlKey: true }), 'y')).toBe(true);
    expect(context.taskOpsAdapter.performRedo).toHaveBeenCalledTimes(1);
  });

  it('其它按键不处理撤销/重做', () => {
    const context = createContext();
    expect(context.handleUndoRedo(makeEvent({ key: 'a', ctrlKey: true }), 'a')).toBe(false);
    expect(context.taskOpsAdapter.performUndo).not.toHaveBeenCalled();
    expect(context.taskOpsAdapter.performRedo).not.toHaveBeenCalled();
  });
});

describe('KeyboardShortcutService 搜索与黑盒', () => {
  it('Ctrl+F 展开侧栏以聚焦搜索', () => {
    const context = createContext();
    const event = makeEvent({ key: 'f', ctrlKey: true });
    expect(context.handleSearch(event, 'f')).toBe(true);
    expect(context.uiState.sidebarOpen.set).toHaveBeenCalledWith(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+Shift+F 不触发搜索聚焦', () => {
    const context = createContext();
    expect(context.handleSearch(makeEvent({ key: 'f', ctrlKey: true, shiftKey: true }), 'f')).toBe(false);
    expect(context.uiState.sidebarOpen.set).not.toHaveBeenCalled();
  });

  it('Ctrl+B 切换黑盒面板', () => {
    const context = createContext();
    const before = showBlackBoxPanel();
    expect(context.handleBlackBox(makeEvent({ key: 'b', ctrlKey: true }), 'b')).toBe(true);
    expect(showBlackBoxPanel()).toBe(!before);
    showBlackBoxPanel.set(before);
  });
});
