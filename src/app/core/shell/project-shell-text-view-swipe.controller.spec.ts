import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectShellTextViewSwipeController } from './project-shell-text-view-swipe.controller';

type TestTouchPoint = {
  clientX: number;
  clientY: number;
};

type TestTouchEvent = TouchEvent & {
  preventDefault: ReturnType<typeof vi.fn>;
  stopPropagation: ReturnType<typeof vi.fn>;
};

function touchEvent({
  touches = [],
  changedTouches = touches,
  cancelable = true,
}: {
  touches?: TestTouchPoint[];
  changedTouches?: TestTouchPoint[];
  cancelable?: boolean;
}): TestTouchEvent {
  return {
    touches,
    changedTouches,
    cancelable,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as TestTouchEvent;
}

describe('ProjectShellTextViewSwipeController', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('switches to Flow asynchronously after a recognized mobile left swipe', () => {
    vi.useFakeTimers();
    const switchToFlow = vi.fn();
    const controller = new ProjectShellTextViewSwipeController({
      isMobile: () => true,
      switchToFlow,
    });

    controller.onTouchStart(touchEvent({
      touches: [{ clientX: 120, clientY: 10 }],
    }));
    const moveEvent = touchEvent({
      touches: [{ clientX: 70, clientY: 15 }],
    });
    controller.onTouchMove(moveEvent);
    const endEvent = touchEvent({
      changedTouches: [{ clientX: 40, clientY: 15 }],
    });
    controller.onTouchEnd(endEvent);

    expect(moveEvent.preventDefault).toHaveBeenCalledOnce();
    expect(moveEvent.stopPropagation).toHaveBeenCalledOnce();
    expect(endEvent.preventDefault).toHaveBeenCalledOnce();
    expect(endEvent.stopPropagation).toHaveBeenCalledOnce();
    expect(switchToFlow).not.toHaveBeenCalled();

    vi.advanceTimersByTime(0);

    expect(switchToFlow).toHaveBeenCalledOnce();
  });

  it('ignores the delayed Flow switch after destroy', () => {
    vi.useFakeTimers();
    const switchToFlow = vi.fn();
    const controller = new ProjectShellTextViewSwipeController({
      isMobile: () => true,
      switchToFlow,
    });

    controller.onTouchStart(touchEvent({
      touches: [{ clientX: 100, clientY: 0 }],
    }));
    controller.onTouchMove(touchEvent({
      touches: [{ clientX: 40, clientY: 2 }],
    }));
    controller.onTouchEnd(touchEvent({
      changedTouches: [{ clientX: 20, clientY: 2 }],
    }));
    controller.destroy();
    vi.advanceTimersByTime(0);

    expect(switchToFlow).not.toHaveBeenCalled();
  });

  it('ignores non-mobile or multitouch gestures', () => {
    const switchToFlow = vi.fn();
    const controller = new ProjectShellTextViewSwipeController({
      isMobile: () => false,
      switchToFlow,
    });
    const moveEvent = touchEvent({
      touches: [{ clientX: 10, clientY: 0 }],
    });

    controller.onTouchStart(touchEvent({
      touches: [{ clientX: 100, clientY: 0 }],
    }));
    controller.onTouchMove(moveEvent);
    controller.onTouchEnd(touchEvent({
      changedTouches: [{ clientX: 0, clientY: 0 }],
    }));

    expect(moveEvent.preventDefault).not.toHaveBeenCalled();
    expect(moveEvent.stopPropagation).not.toHaveBeenCalled();
    expect(switchToFlow).not.toHaveBeenCalled();

    const mobileController = new ProjectShellTextViewSwipeController({
      isMobile: () => true,
      switchToFlow,
    });
    const multitouchMoveEvent = touchEvent({
      touches: [
        { clientX: 100, clientY: 0 },
        { clientX: 30, clientY: 0 },
      ],
    });

    mobileController.onTouchStart(multitouchMoveEvent);
    mobileController.onTouchMove(multitouchMoveEvent);
    mobileController.onTouchEnd(touchEvent({
      changedTouches: [{ clientX: 0, clientY: 0 }],
    }));

    expect(multitouchMoveEvent.preventDefault).not.toHaveBeenCalled();
    expect(multitouchMoveEvent.stopPropagation).not.toHaveBeenCalled();
    expect(switchToFlow).not.toHaveBeenCalled();
  });
});
