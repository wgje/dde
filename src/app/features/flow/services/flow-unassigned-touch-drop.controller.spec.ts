import { describe, expect, it, vi } from 'vitest';
import { UI_CONFIG } from '../../../../config';
import { FlowUnassignedTouchDropController } from './flow-unassigned-touch-drop.controller';

function createController() {
  const dragDrop = {
    processDrop: vi.fn(),
    processDropFromInteraction: vi.fn(),
  };
  const touch = {
    hasActiveTouchSession: false,
    draggingId: vi.fn(() => null),
    isPointerSessionActive: false,
    isAwaitingPointerFallback: false,
    handleTouchMove: vi.fn(() => false),
    handlePointerMove: vi.fn(() => false),
    handlePointerFallbackMove: vi.fn(() => false),
    endTouchFromLastPosition: vi.fn(),
    endTouch: vi.fn(),
    endTouchAtPosition: vi.fn(),
    endPointer: vi.fn(),
    cancelTouch: vi.fn(),
    cancelPointer: vi.fn(),
    deferCancelForPointerFallback: vi.fn(() => false),
  };
  const controller = new FlowUnassignedTouchDropController({
    dragDrop: dragDrop as never,
    getDiagramElement: () => null,
    getDiagramInstance: () => null,
    touch: touch as never,
    zone: {
      run: (fn: () => void) => fn(),
      runOutsideAngular: (fn: () => void) => fn(),
    } as never,
  });

  return { controller, dragDrop, touch };
}

describe('FlowUnassignedTouchDropController', () => {
  it('installs global non-passive listeners only for an active drag session and removes them afterward', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { controller } = createController();

    try {
      expect(addSpy).not.toHaveBeenCalled();

      controller.installGlobalListeners();
      controller.installGlobalListeners();

      expect(addSpy.mock.calls.filter(call => call[0] === 'touchmove')).toHaveLength(1);
      expect(addSpy.mock.calls.filter(call => call[0] === 'pointermove')).toHaveLength(1);

      controller.finish(false, new TouchEvent('touchend'));

      expect(removeSpy.mock.calls.filter(call => call[0] === 'touchmove')).toHaveLength(1);
      expect(removeSpy.mock.calls.filter(call => call[0] === 'pointermove')).toHaveLength(1);
    } finally {
      controller.removeGlobalListeners();
      addSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });

  it('rolls back partially installed global listeners when listener registration fails', () => {
    const originalAddEventListener = document.addEventListener.bind(document);
    const addSpy = vi.spyOn(document, 'addEventListener')
      .mockImplementation((eventName, listener, options) => {
        if (eventName === 'pointermove') {
          throw new Error('pointer listener unavailable');
        }
        originalAddEventListener(eventName, listener, options);
      });
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { controller } = createController();

    try {
      expect(() => controller.installGlobalListeners()).toThrow('pointer listener unavailable');

      expect(removeSpy).toHaveBeenCalledWith('touchmove', expect.any(Function), { capture: true });
      expect(removeSpy).toHaveBeenCalledWith('touchend', expect.any(Function), { capture: true });
      expect(removeSpy).toHaveBeenCalledWith('touchcancel', expect.any(Function), { capture: true });

      addSpy.mockRestore();
      const retryAddSpy = vi.spyOn(document, 'addEventListener');
      controller.installGlobalListeners();

      expect(retryAddSpy).toHaveBeenCalledTimes(6);
      retryAddSpy.mockRestore();
    } finally {
      controller.removeGlobalListeners();
      addSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });

  it('cancels the pointer fallback session on pointercancel instead of submitting a drop', () => {
    const { controller, touch } = createController();
    touch.hasActiveTouchSession = true;
    touch.isAwaitingPointerFallback = true;

    try {
      controller.installGlobalListeners();

      document.dispatchEvent(createTouchPointerEvent('pointercancel', { clientX: 180, clientY: 220 }));

      expect(touch.endTouchFromLastPosition).not.toHaveBeenCalled();
      expect(touch.endTouchAtPosition).not.toHaveBeenCalled();
      expect(touch.cancelTouch).toHaveBeenCalledOnce();
    } finally {
      controller.removeGlobalListeners();
    }
  });

  it('still submits the deferred pointer fallback session on pointerup', () => {
    const { controller, touch } = createController();
    touch.hasActiveTouchSession = true;
    touch.isAwaitingPointerFallback = true;

    try {
      controller.installGlobalListeners();

      document.dispatchEvent(createTouchPointerEvent('pointerup', { clientX: 180, clientY: 220 }));

      expect(touch.endTouchAtPosition).toHaveBeenCalledWith(null, null, expect.any(Function), 180, 220);
      expect(touch.cancelTouch).not.toHaveBeenCalled();
    } finally {
      controller.removeGlobalListeners();
    }
  });

  it('defers touchcancel into pointer fallback and then separates pointercancel from pointerup semantics', () => {
    const first = createController();
    first.touch.hasActiveTouchSession = true;
    first.touch.deferCancelForPointerFallback.mockImplementation(() => {
      first.touch.isAwaitingPointerFallback = true;
      return true;
    });

    try {
      first.controller.installGlobalListeners();
      document.dispatchEvent(new TouchEvent('touchcancel', { bubbles: true, cancelable: true }));

      expect(first.touch.deferCancelForPointerFallback).toHaveBeenCalledOnce();

      document.dispatchEvent(createTouchPointerEvent('pointercancel', { clientX: 180, clientY: 220 }));

      expect(first.touch.cancelTouch).toHaveBeenCalledOnce();
      expect(first.touch.endTouchAtPosition).not.toHaveBeenCalled();
    } finally {
      first.controller.removeGlobalListeners();
    }

    const second = createController();
    second.touch.hasActiveTouchSession = true;
    second.touch.deferCancelForPointerFallback.mockImplementation(() => {
      second.touch.isAwaitingPointerFallback = true;
      return true;
    });

    try {
      second.controller.installGlobalListeners();
      document.dispatchEvent(new TouchEvent('touchcancel', { bubbles: true, cancelable: true }));

      expect(second.touch.deferCancelForPointerFallback).toHaveBeenCalledOnce();

      document.dispatchEvent(createTouchPointerEvent('pointerup', { clientX: 180, clientY: 220 }));

      expect(second.touch.endTouchAtPosition).toHaveBeenCalledWith(null, null, expect.any(Function), 180, 220);
      expect(second.touch.cancelTouch).not.toHaveBeenCalled();
    } finally {
      second.controller.removeGlobalListeners();
    }
  });

  it('removes global listeners when the deferred pointer fallback expires without a pointer event', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { controller, touch } = createController();
    let expireFallback: (() => void) | undefined;
    touch.hasActiveTouchSession = true;
    touch.deferCancelForPointerFallback.mockImplementation((onExpired?: () => void) => {
      touch.isAwaitingPointerFallback = true;
      expireFallback = onExpired;
      return true;
    });

    try {
      controller.installGlobalListeners();
      document.dispatchEvent(new TouchEvent('touchcancel', { bubbles: true, cancelable: true }));

      expect(touch.deferCancelForPointerFallback).toHaveBeenCalledOnce();
      expect(expireFallback).toEqual(expect.any(Function));

      expireFallback?.();

      expect(removeSpy.mock.calls.filter(call => call[0] === 'touchmove')).toHaveLength(1);
      expect(removeSpy.mock.calls.filter(call => call[0] === 'pointermove')).toHaveLength(1);
    } finally {
      controller.removeGlobalListeners();
      removeSpy.mockRestore();
    }
  });

  it('keeps global listeners when an unrelated touchend leaves the active touch session alive', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { controller, touch } = createController();
    touch.hasActiveTouchSession = true;
    touch.endTouch.mockImplementation(() => {
      touch.hasActiveTouchSession = true;
    });

    try {
      controller.installGlobalListeners();

      document.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true }));

      expect(touch.endTouch).toHaveBeenCalledOnce();
      expect(removeSpy.mock.calls.filter(call => call[0] === 'touchmove')).toHaveLength(0);
      expect(removeSpy.mock.calls.filter(call => call[0] === 'pointermove')).toHaveLength(0);
    } finally {
      controller.removeGlobalListeners();
      removeSpy.mockRestore();
    }
  });

  it('submits touch drops through the safe interaction drop wrapper', () => {
    const { controller, dragDrop, touch } = createController();
    const task = { id: 'task-1', title: 'Task' };
    const insertInfo = { parentId: 'parent-1' };
    const docPoint = { x: 120, y: 220 };
    touch.endTouch.mockImplementation((_event, _element, _diagram, onDrop) => {
      onDrop(task, insertInfo, docPoint);
    });

    controller.finish(false, new TouchEvent('touchend'));

    expect(dragDrop.processDropFromInteraction).toHaveBeenCalledWith(
      task,
      insertInfo,
      docPoint,
      UI_CONFIG.MEDIUM_DELAY,
    );
    expect(dragDrop.processDrop).not.toHaveBeenCalled();
  });
});

class TestPointerEvent extends MouseEvent {
  readonly pointerType: string;
  readonly isPrimary: boolean;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    this.pointerType = init.pointerType ?? 'touch';
    this.isPrimary = init.isPrimary ?? true;
  }
}

function createTouchPointerEvent(type: string, init: PointerEventInit = {}): PointerEvent {
  return new TestPointerEvent(type, init) as PointerEvent;
}
