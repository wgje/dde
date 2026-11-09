import { vi, describe, it, expect } from 'vitest';
import { SidebarResizeService } from './sidebar-resize.service';

type SidebarResizePrivate = {
  isResizingSidebar: boolean;
  isResizingContent: boolean;
  resizeRafId: number | null;
  isResizingAny: () => boolean;
  startSidebar: (e: MouseEvent) => void;
  startContent: (e: MouseEvent) => void;
  onMouseMove: (e: MouseEvent) => void;
  onMouseUp: () => void;
  teardown: () => void;
  uiState: {
    isResizing: { set: ReturnType<typeof vi.fn> };
    sidebarWidth: (() => number) & { set: ReturnType<typeof vi.fn> };
    textColumnRatio: (() => number) & { set: ReturnType<typeof vi.fn> };
  };
};

type SignalMock<T> = (() => T) & { set: ReturnType<typeof vi.fn> };

function createContext(): SidebarResizePrivate {
  const context = Object.create(SidebarResizeService.prototype) as SidebarResizePrivate;
  context.isResizingSidebar = false;
  context.isResizingContent = false;
  context.resizeRafId = null;
  const sidebarWidth = vi.fn(() => 300) as unknown as SignalMock<number>;
  sidebarWidth.set = vi.fn();
  const textColumnRatio = vi.fn(() => 50) as unknown as SignalMock<number>;
  textColumnRatio.set = vi.fn();
  context.uiState = {
    isResizing: { set: vi.fn() },
    sidebarWidth,
    textColumnRatio,
  };
  return context;
}

function makeMouseEvent(clientX: number): MouseEvent {
  return { clientX, preventDefault: vi.fn() } as unknown as MouseEvent;
}

describe('SidebarResizeService', () => {
  it('isResizingAny 反映拖拽状态', () => {
    const context = createContext();
    expect(context.isResizingAny()).toBe(false);
    context.isResizingSidebar = true;
    expect(context.isResizingAny()).toBe(true);
  });

  it('startSidebar 置位拖拽并通知 UiState', () => {
    const context = createContext();
    context.startSidebar(makeMouseEvent(120));
    expect(context.isResizingSidebar).toBe(true);
    expect(context.uiState.isResizing.set).toHaveBeenCalledWith(true);
  });

  it('startContent 置位拖拽并通知 UiState', () => {
    const context = createContext();
    context.startContent(makeMouseEvent(120));
    expect(context.isResizingContent).toBe(true);
    expect(context.uiState.isResizing.set).toHaveBeenCalledWith(true);
  });

  it('新的内容区拖拽应接管未结束的侧栏拖拽状态', () => {
    const context = createContext();
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

    try {
      Reflect.deleteProperty(globalThis, 'requestAnimationFrame');

      context.startSidebar(makeMouseEvent(100));
      context.startContent(makeMouseEvent(120));
      context.onMouseMove(makeMouseEvent(220));

      expect(context.isResizingSidebar).toBe(false);
      expect(context.isResizingContent).toBe(true);
      expect(context.uiState.sidebarWidth.set).not.toHaveBeenCalled();
      expect(context.uiState.textColumnRatio.set).toHaveBeenCalledWith(60);
    } finally {
      if (originalRequestAnimationFrame) {
        Object.defineProperty(globalThis, 'requestAnimationFrame', {
          configurable: true,
          writable: true,
          value: originalRequestAnimationFrame,
        });
      }
    }
  });

  it('新的拖拽启动应取消上一轮尚未执行的 resize frame', () => {
    const context = createContext();
    const requestAnimationFrame = vi.fn(() => 24);
    const cancelAnimationFrame = vi.fn();
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: requestAnimationFrame,
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      configurable: true,
      writable: true,
      value: cancelAnimationFrame,
    });

    try {
      context.startSidebar(makeMouseEvent(100));
      context.onMouseMove(makeMouseEvent(180));
      context.startContent(makeMouseEvent(120));

      expect(cancelAnimationFrame).toHaveBeenCalledWith(24);
      expect(context.resizeRafId).toBeNull();
      expect(context.isResizingSidebar).toBe(false);
      expect(context.isResizingContent).toBe(true);
    } finally {
      if (originalRequestAnimationFrame) {
        Object.defineProperty(globalThis, 'requestAnimationFrame', {
          configurable: true,
          writable: true,
          value: originalRequestAnimationFrame,
        });
      } else {
        Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
      }

      if (originalCancelAnimationFrame) {
        Object.defineProperty(globalThis, 'cancelAnimationFrame', {
          configurable: true,
          writable: true,
          value: originalCancelAnimationFrame,
        });
      } else {
        Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
      }
    }
  });

  it('onMouseUp 清除拖拽态并复位 UiState', () => {
    const context = createContext();
    context.isResizingSidebar = true;
    context.onMouseUp();
    expect(context.isResizingSidebar).toBe(false);
    expect(context.isResizingContent).toBe(false);
    expect(context.uiState.isResizing.set).toHaveBeenCalledWith(false);
  });

  it('teardown 应清除拖拽态、rAF 与全局 body 样式', () => {
    const context = createContext();
    const cancelAnimationFrame = vi.fn();
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      configurable: true,
      writable: true,
      value: cancelAnimationFrame,
    });

    try {
      context.isResizingSidebar = true;
      context.resizeRafId = 42;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      context.teardown();

      expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
      expect(context.resizeRafId).toBeNull();
      expect(context.isResizingSidebar).toBe(false);
      expect(context.isResizingContent).toBe(false);
      expect(context.uiState.isResizing.set).toHaveBeenCalledWith(false);
      expect(document.body.style.cursor).toBe('');
      expect(document.body.style.userSelect).toBe('');
    } finally {
      if (originalCancelAnimationFrame) {
        Object.defineProperty(globalThis, 'cancelAnimationFrame', {
          configurable: true,
          writable: true,
          value: originalCancelAnimationFrame,
        });
      } else {
        Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
      }
    }
  });

  it('无 document 环境时启动和结束拖拽不应抛错', () => {
    const context = createContext();
    const originalDocument = globalThis.document;

    try {
      Reflect.deleteProperty(globalThis, 'document');

      expect(() => context.startSidebar(makeMouseEvent(120))).not.toThrow();
      expect(() => context.startContent(makeMouseEvent(120))).not.toThrow();
      expect(() => context.onMouseUp()).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        writable: true,
        value: originalDocument,
      });
    }
  });

  it('requestAnimationFrame 不存在时应使用同步兜底计算', () => {
    const context = createContext();
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

    try {
      Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
      context.startSidebar(makeMouseEvent(100));
      context.onMouseMove(makeMouseEvent(180));

      expect(context.uiState.sidebarWidth.set).toHaveBeenCalledWith(380);
    } finally {
      if (originalRequestAnimationFrame) {
        Object.defineProperty(globalThis, 'requestAnimationFrame', {
          configurable: true,
          writable: true,
          value: originalRequestAnimationFrame,
        });
      }
    }
  });

  it('requestAnimationFrame 返回 0 时仍应节流并在结束拖拽时取消', () => {
    const context = createContext();
    const requestAnimationFrame = vi.fn(() => 0);
    const cancelAnimationFrame = vi.fn();
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: requestAnimationFrame,
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      configurable: true,
      writable: true,
      value: cancelAnimationFrame,
    });

    try {
      context.startSidebar(makeMouseEvent(100));
      context.onMouseMove(makeMouseEvent(180));
      context.onMouseMove(makeMouseEvent(220));
      context.onMouseUp();

      expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
      expect(cancelAnimationFrame).toHaveBeenCalledWith(0);
      expect(context.resizeRafId).toBeNull();
      expect(context.isResizingSidebar).toBe(false);
      expect(context.uiState.isResizing.set).toHaveBeenLastCalledWith(false);
    } finally {
      if (originalRequestAnimationFrame) {
        Object.defineProperty(globalThis, 'requestAnimationFrame', {
          configurable: true,
          writable: true,
          value: originalRequestAnimationFrame,
        });
      } else {
        Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
      }

      if (originalCancelAnimationFrame) {
        Object.defineProperty(globalThis, 'cancelAnimationFrame', {
          configurable: true,
          writable: true,
          value: originalCancelAnimationFrame,
        });
      } else {
        Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
      }
    }
  });
});
