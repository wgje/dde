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
} as TouchEvent);

const createTouchEndEvent = (clientX: number, clientY: number): TouchEvent => ({
  type: 'touchend',
  touches: [] as unknown as TouchList,
  changedTouches: [createTouchPoint(clientX, clientY)] as unknown as TouchList,
  cancelable: true,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
} as TouchEvent);

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
describe('MobileTodoDrawerComponent', () => {
  let component: MobileTodoDrawerComponent;

  beforeEach(() => {
    vi.useFakeTimers();

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
          useFactory: () => new NgZone({ enableLongStackTrace: false }),
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

    component = runInInjectionContext(injector, () => new MobileTodoDrawerComponent());
  });

  afterEach(() => {
    component?.ngOnDestroy();
    vi.useRealTimers();
  });

  it('document 级 touchend 兜底应在抽屉内 touchend 丢失时仍触发切页', async () => {
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
