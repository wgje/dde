import {
  Injector,
  NgZone,
  runInInjectionContext,
  signal,
  ɵChangeDetectionScheduler as ChangeDetectionScheduler,
  ɵEffectScheduler as EffectScheduler,
} from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../../models';
import { ProjectStateService } from '../../../../services/project-state.service';
import { SyncCoordinatorService } from '../../../../services/sync-coordinator.service';
import { MobileTodoDrawerComponent } from './mobile-todo-drawer.component';

const createTask = (id: string): Task => ({
  id,
  title: `Task ${id}`,
  content: '',
  stage: null,
  parentId: null,
  order: 0,
  rank: 0,
  status: 'active',
  x: 0,
  y: 0,
  createdDate: '2026-04-21',
  updatedAt: '2026-04-21T00:00:00.000Z',
  displayId: id,
  deletedAt: null,
});

const createTouchPoint = (clientX: number, clientY: number): Touch => ({
  clientX,
  clientY,
} as Touch);

const createTouchStartEvent = (clientX: number, clientY: number): TouchEvent => ({
  type: 'touchstart',
  touches: [createTouchPoint(clientX, clientY)] as unknown as TouchList,
  changedTouches: [createTouchPoint(clientX, clientY)] as unknown as TouchList,
  cancelable: true,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
} as unknown as TouchEvent);

const createTouchEndEvent = (clientX: number, clientY: number): TouchEvent => ({
  type: 'touchend',
  touches: [] as unknown as TouchList,
  changedTouches: [createTouchPoint(clientX, clientY)] as unknown as TouchList,
  cancelable: true,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
} as unknown as TouchEvent);

const mockChangeDetectionScheduler: ChangeDetectionScheduler = {
  notify: vi.fn(),
  runningTick: false,
};

const mockEffectScheduler: EffectScheduler = {
  schedule: (effect: { run: () => void }) => {
    queueMicrotask(() => effect.run());
  },
  flush: vi.fn(),
  remove: vi.fn(),
};

const mockNgZone: Pick<NgZone, 'run' | 'runOutsideAngular'> = {
  run: <T>(fn: (...args: unknown[]) => T) => fn(),
  runOutsideAngular: <T>(fn: (...args: unknown[]) => T) => fn(),
};

describe('MobileTodoDrawerComponent', () => {
  let component: MobileTodoDrawerComponent | null = null;

  function createComponent(): MobileTodoDrawerComponent {
    const injector = Injector.create({
      providers: [
        {
          provide: ProjectStateService,
          useValue: {
            unfinishedItems: signal([]),
            unassignedTasks: signal([]),
            activeProjectId: vi.fn(() => 'project-1'),
          },
        },
        {
          provide: SyncCoordinatorService,
          useValue: {
            isLoadingRemote: signal(false),
          },
        },
        {
          provide: NgZone,
          useValue: mockNgZone,
        },
        {
          provide: ChangeDetectionScheduler,
          useValue: mockChangeDetectionScheduler,
        },
        {
          provide: EffectScheduler,
          useValue: mockEffectScheduler,
        },
      ],
    });

    return runInInjectionContext(injector, () => new MobileTodoDrawerComponent());
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    component?.ngOnDestroy();
    vi.useRealTimers();
  });

  it('global listener 注册中途失败时不应让构造失败并应回滚已注册 listener', () => {
    const addError = new Error('touchcancel listener failed');
    const originalAddEventListener = document.addEventListener.bind(document);
    const originalRemoveEventListener = document.removeEventListener.bind(document);
    const registeredTouchEndListeners: EventListener[] = [];
    const addListener = vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
      if (type === 'touchend') {
        registeredTouchEndListeners.push(listener as EventListener);
        originalAddEventListener(type, listener, options);
        return;
      }

      if (type === 'touchcancel') {
        throw addError;
      }

      originalAddEventListener(type, listener, options);
    });
    const removeListener = vi.spyOn(document, 'removeEventListener');

    try {
      expect(() => {
        component = createComponent();
      }).not.toThrow();
      expect(removeListener).toHaveBeenCalledWith(
        'touchend',
        expect.any(Function),
        { capture: true } as EventListenerOptions,
      );
    } finally {
      addListener.mockRestore();
      removeListener.mockRestore();
      for (const listener of registeredTouchEndListeners) {
        originalRemoveEventListener('touchend', listener, { capture: true } as EventListenerOptions);
      }
    }
  });

  it('ngOnDestroy 清理全局 listener 失败时不应中断后续清理', () => {
    component = createComponent();
    const currentComponent = component;
    const globalApi = currentComponent as unknown as {
      boundGlobalTouchFinish: EventListener;
      boundGlobalPointerFinish: EventListener;
    };
    const removeListener = vi
      .spyOn(document, 'removeEventListener')
      .mockImplementationOnce(() => {
        throw new Error('touchend cleanup failed');
      });

    try {
      expect(() => currentComponent.ngOnDestroy()).not.toThrow();
      expect(removeListener).toHaveBeenCalledWith(
        'touchcancel',
        expect.any(Function),
        { capture: true } as EventListenerOptions,
      );
      expect(removeListener).toHaveBeenCalledWith(
        'pointerup',
        expect.any(Function),
        { capture: true } as EventListenerOptions,
      );
      expect(removeListener).toHaveBeenCalledWith(
        'pointercancel',
        expect.any(Function),
        { capture: true } as EventListenerOptions,
      );
      component = null;
    } finally {
      removeListener.mockRestore();
      document.removeEventListener('touchend', globalApi.boundGlobalTouchFinish, { capture: true } as EventListenerOptions);
      document.removeEventListener('touchcancel', globalApi.boundGlobalTouchFinish, { capture: true } as EventListenerOptions);
      document.removeEventListener('pointerup', globalApi.boundGlobalPointerFinish, { capture: true } as EventListenerOptions);
      document.removeEventListener('pointercancel', globalApi.boundGlobalPointerFinish, { capture: true } as EventListenerOptions);
    }
  });

  it('document 级 touchend 兜底应在抽屉内 touchend 丢失时仍触发切页', async () => {
    component = createComponent();
    const emitSpy = vi.spyOn(component.swipeToSwitch, 'emit');
    const globalApi = component as unknown as {
      handleGlobalTouchFinish: (event: TouchEvent) => void;
    };

    component.onSwipeTouchStart(createTouchStartEvent(24, 20));
    globalApi.handleGlobalTouchFinish(createTouchEndEvent(104, 24));

    await Promise.resolve();
    vi.runAllTimers();

    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith('right');
  });

  it('本地 touchend 已消费切页时，document 兜底不应重复触发', async () => {
    component = createComponent();
    const emitSpy = vi.spyOn(component.swipeToSwitch, 'emit');
    const globalApi = component as unknown as {
      handleGlobalTouchFinish: (event: TouchEvent) => void;
    };
    const task = createTask('task-1');
    const startEvent = createTouchStartEvent(24, 20);
    const endEvent = createTouchEndEvent(104, 24);

    component.onTouchStart(startEvent, task);
    component.onSwipeTouchStart(startEvent);
    globalApi.handleGlobalTouchFinish(endEvent);
    component.onTouchEnd(endEvent, task);

    await Promise.resolve();
    vi.runAllTimers();

    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith('right');
  });

  it('chip touchend 与容器 swipe touchend 共享同一手势时不应重复触发切页', async () => {
    component = createComponent();
    const emitSpy = vi.spyOn(component.swipeToSwitch, 'emit');
    const task = createTask('task-1');
    const startEvent = createTouchStartEvent(24, 20);
    const endEvent = createTouchEndEvent(104, 24);

    component.onTouchStart(startEvent, task);
    component.onSwipeTouchStart(startEvent);
    component.onTouchEnd(endEvent, task);
    component.onSwipeTouchEnd(endEvent);

    await Promise.resolve();
    vi.runAllTimers();

    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith('right');
  });
});
