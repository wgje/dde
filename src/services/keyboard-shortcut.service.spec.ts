import { vi, describe, it, expect } from 'vitest';
import { KeyboardShortcutService } from './keyboard-shortcut.service';
import { showBlackBoxPanel } from '../state/focus-stores';

type KeyboardShortcutPrivate = {
  shouldIgnore: (event: KeyboardEvent) => boolean;
  handleUndoRedo: (event: KeyboardEvent, key: string) => boolean;
  handleSearch: (event: KeyboardEvent, key: string) => boolean;
  handleBlackBox: (event: KeyboardEvent, key: string) => boolean;
  runUndoRedoCommand: (command: () => Promise<unknown>) => void;
  focusGlobalSearchInput: () => void;
  initialize: () => void;
  teardown: () => void;
  injector: { get: ReturnType<typeof vi.fn> };
  taskOpsAdapter: { performUndo: ReturnType<typeof vi.fn>; performRedo: ReturnType<typeof vi.fn> };
  uiState: { sidebarOpen: { set: ReturnType<typeof vi.fn> } };
  dynamicModal: { hasOpenModal: () => boolean };
  modal: { hasOpenModal: () => boolean };
  started: boolean;
  searchFocusTimer: ReturnType<typeof setTimeout> | null;
};

function createContext(): KeyboardShortcutPrivate {
  const context = Object.create(KeyboardShortcutService.prototype) as KeyboardShortcutPrivate;
  const taskOpsAdapter = { performUndo: vi.fn(), performRedo: vi.fn() };
  context.injector = { get: vi.fn(() => taskOpsAdapter) };
  context.uiState = { sidebarOpen: { set: vi.fn() } };
  context.dynamicModal = { hasOpenModal: vi.fn(() => false) };
  context.modal = { hasOpenModal: vi.fn(() => false) };
  context.started = false;
  context.searchFocusTimer = null;
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
    target: null,
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

  it('输入控件内的全局快捷键应忽略，避免覆盖原生编辑行为', () => {
    const context = createContext();

    expect(context.shouldIgnore(makeEvent({
      key: 'z',
      ctrlKey: true,
      target: document.createElement('input'),
    }))).toBe(true);

    expect(context.shouldIgnore(makeEvent({
      key: 'b',
      ctrlKey: true,
      target: document.createElement('textarea'),
    }))).toBe(true);
  });

  it('contenteditable 内的全局快捷键应忽略', () => {
    const context = createContext();
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');

    expect(context.shouldIgnore(makeEvent({
      key: 'z',
      ctrlKey: true,
      target: editor,
    }))).toBe(true);
  });

  it('contenteditable 空属性和子节点内的全局快捷键应忽略', () => {
    const context = createContext();
    const editor = document.createElement('div');
    const nestedText = document.createElement('span');
    editor.setAttribute('contenteditable', '');
    editor.append(nestedText);

    expect(context.shouldIgnore(makeEvent({
      key: 'z',
      metaKey: true,
      target: nestedText,
    }))).toBe(true);
  });

  it('动态模态框打开时应忽略全局快捷键，避免后台状态被误改', () => {
    const context = createContext();
    context.dynamicModal.hasOpenModal = vi.fn(() => true);

    expect(context.shouldIgnore(makeEvent({ key: 'z', ctrlKey: true }))).toBe(true);
    expect(context.shouldIgnore(makeEvent({ key: 'f', metaKey: true }))).toBe(true);
    expect(context.shouldIgnore(makeEvent({ key: 'b', ctrlKey: true }))).toBe(true);
  });

  it('传统模态框打开时应忽略全局快捷键，避免后台状态被误改', () => {
    const context = createContext();
    context.dynamicModal.hasOpenModal = vi.fn(() => false);
    context.modal.hasOpenModal = vi.fn(() => true);

    expect(context.shouldIgnore(makeEvent({ key: 'z', ctrlKey: true }))).toBe(true);
    expect(context.shouldIgnore(makeEvent({ key: 'f', metaKey: true }))).toBe(true);
    expect(context.shouldIgnore(makeEvent({ key: 'b', ctrlKey: true }))).toBe(true);
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

  it('隔离撤销/重做异步失败，避免未处理拒绝', async () => {
    const context = createContext();
    const error = new Error('undo failed');
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      context.taskOpsAdapter.performUndo.mockRejectedValue(error);

      expect(context.handleUndoRedo(makeEvent({ key: 'z', ctrlKey: true }), 'z')).toBe(true);
      await Promise.resolve();

      expect(consoleWarn).toHaveBeenCalledWith(
        'Keyboard shortcut undo/redo failed',
        error,
      );
    } finally {
      consoleWarn.mockRestore();
    }
  });
});

describe('KeyboardShortcutService 搜索与黑盒', () => {
  it('无 document 环境时初始化和销毁不应抛错', () => {
    const context = createContext();
    const originalDocument = globalThis.document;

    try {
      Reflect.deleteProperty(globalThis, 'document');

      expect(() => context.initialize()).not.toThrow();
      expect(() => context.teardown()).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        writable: true,
        value: originalDocument,
      });
    }
  });

  it('注册全局监听失败后应回滚启动状态并允许后续重试', () => {
    const context = createContext();
    const registerError = new Error('listener unavailable');
    const addListenerSpy = vi.spyOn(document, 'addEventListener')
      .mockImplementationOnce(() => {
        throw registerError;
      })
      .mockImplementation(() => undefined);
    vi.spyOn(document, 'removeEventListener').mockImplementation(() => undefined);

    try {
      expect(() => context.initialize()).toThrow(registerError);
      expect(context.started).toBe(false);

      expect(() => context.initialize()).not.toThrow();

      expect(addListenerSpy).toHaveBeenCalledTimes(2);
      expect(context.started).toBe(true);
    } finally {
      context.teardown();
    }
  });

  it('Ctrl+F 展开侧栏以聚焦搜索', () => {
    const context = createContext();
    const event = makeEvent({ key: 'f', ctrlKey: true });
    expect(context.handleSearch(event, 'f')).toBe(true);
    expect(context.uiState.sidebarOpen.set).toHaveBeenCalledWith(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('销毁时应取消待执行的搜索聚焦 timer', () => {
    vi.useFakeTimers();
    const context = createContext();
    const querySelector = vi.spyOn(document, 'querySelector');

    try {
      context.focusGlobalSearchInput();
      context.teardown();
      vi.runAllTimers();

      expect(querySelector).not.toHaveBeenCalled();
    } finally {
      querySelector.mockRestore();
      vi.useRealTimers();
    }
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
