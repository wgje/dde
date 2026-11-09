import { ElementRef, NgZone, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../../models';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { LoggerService } from '../../../../services/logger.service';
import { ParkingService } from '../../../../services/parking.service';
import {
  ProjectStateService,
  type ActiveProjectOwner,
  type BeforeActiveProjectChangeListener,
} from '../../../../services/project-state.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { ToastService } from '../../../../services/toast.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { UserSessionService } from '../../../../services/user-session.service';
import { createTask, type StageFixture } from './text-view-task-ops.test-helpers';
import { TextViewDragDropService } from './text-view-drag-drop.service';
import { TextViewTaskOpsService } from './text-view-task-ops.service';

type AddTaskResult = Awaited<ReturnType<TaskOperationAdapterService['addTask']>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function createProjectOwnerFixture() {
  let activeProjectId: string | null = 'project-a';
  let generation = 0;
  let stages: StageFixture[] = [];
  const tasksByProject = new Map<string, Task[]>([['project-a', []], ['project-b', []]]);
  const listeners = new Set<BeforeActiveProjectChangeListener>();
  const api = {
    getTask: vi.fn((taskId: string) =>
      (activeProjectId ? tasksByProject.get(activeProjectId) : [])?.find(task => task.id === taskId)),
    stages: vi.fn(() => stages),
    tasks: vi.fn(() => activeProjectId ? tasksByProject.get(activeProjectId) ?? [] : []),
    unassignedTasks: vi.fn(() => []),
    captureActiveProjectOwner: vi.fn((): ActiveProjectOwner => ({ projectId: activeProjectId, generation })),
    isActiveProjectOwnerCurrent: vi.fn((owner: ActiveProjectOwner) =>
      owner.projectId === activeProjectId && owner.generation === generation),
    registerBeforeActiveProjectChange: vi.fn((listener: BeforeActiveProjectChangeListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  return {
    api,
    listenerCount: () => listeners.size,
    setStages: (next: StageFixture[]) => { stages = next; },
    setTasks: (projectId: string, tasks: Task[]) => { tasksByProject.set(projectId, tasks); },
    switchProject(nextProjectId: string) {
      if (activeProjectId === nextProjectId) return;
      const previousProjectId = activeProjectId;
      generation += 1;
      [...listeners].forEach(listener => listener(previousProjectId, nextProjectId));
      activeProjectId = nextProjectId;
    },
  };
}

describe('TextViewTaskOpsService project-owned creation', () => {
  let service: TextViewTaskOpsService;
  let hostElement: HTMLElement;
  let ownerFixture: ReturnType<typeof createProjectOwnerFixture>;
  let setEditingTask: ReturnType<typeof vi.fn>;
  let mockTaskOpsAdapter: {
    addTask: ReturnType<typeof vi.fn>;
    addTaskForUiOwner: ReturnType<typeof vi.fn>;
    repairMissingStageOne: ReturnType<typeof vi.fn>;
    repairMissingStageOneForUiOwner: ReturnType<typeof vi.fn>;
  };
  let mockToast: { info: ReturnType<typeof vi.fn>; warning: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let setStageFilter: ReturnType<typeof vi.fn>;
  let dragDropService: { requestSourceStageCollapse: ReturnType<typeof vi.fn>; consumeAutoCollapsedSourceStage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    hostElement = document.createElement('div');
    ownerFixture = createProjectOwnerFixture();
    setEditingTask = vi.fn().mockResolvedValue(undefined);
    const addTask = vi.fn();
    const repairMissingStageOne = vi.fn().mockResolvedValue(true);
    mockTaskOpsAdapter = {
      addTask,
      addTaskForUiOwner: vi.fn((...args: Parameters<TaskOperationAdapterService['addTaskForUiOwner']>) =>
        addTask(...args.slice(0, 5))),
      repairMissingStageOne,
      repairMissingStageOneForUiOwner: vi.fn(() => repairMissingStageOne()),
    };
    mockToast = { info: vi.fn(), warning: vi.fn(), error: vi.fn() };
    const stageFilter = signal<number | 'all'>('all');
    setStageFilter = vi.fn((value: number | 'all') => stageFilter.set(value));
    dragDropService = {
      requestSourceStageCollapse: vi.fn(() => null),
      consumeAutoCollapsedSourceStage: vi.fn(() => null),
    };
    TestBed.configureTestingModule({
      providers: [
        TextViewTaskOpsService,
        { provide: ElementRef, useValue: new ElementRef(hostElement) },
        { provide: NgZone, useValue: new NgZone({ enableLongStackTrace: false }) },
        { provide: TaskOperationAdapterService, useValue: mockTaskOpsAdapter },
        { provide: ProjectStateService, useValue: ownerFixture.api },
        {
          provide: UiStateService,
          useValue: {
            stageFilter,
            stageViewRootFilter: signal<'all' | string>('all'),
            setStageFilter,
            isTextUnassignedOpen: signal(false),
          },
        },
        { provide: ToastService, useValue: mockToast },
        { provide: LoggerService, useValue: { category: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) } },
        { provide: ParkingService, useValue: { parkTask: vi.fn() } },
        { provide: DockEngineService, useValue: { dockTask: vi.fn() } },
        { provide: UserSessionService, useValue: { isHintOnlyStartupPlaceholderVisible: () => false } },
        { provide: TextViewDragDropService, useValue: dragDropService },
      ],
    });
    service = TestBed.inject(TextViewTaskOpsService);
    service.init({
      selectedTaskId: signal<string | null>(null),
      deleteConfirmTask: signal<Task | null>(null),
      deleteKeepChildren: signal(false),
      focusFlowNode: { emit: vi.fn() } as never,
      isMobile: signal(false),
      getStagesRef: () => undefined,
      getUnassignedRef: () => ({ setEditingTask } as never),
    });
  });

  afterEach(() => {
    service.destroy();
    vi.useRealTimers();
  });

  it('preserves same-project duplicate suppression', async () => {
    const created = deferred<AddTaskResult>();
    mockTaskOpsAdapter.addTask.mockReturnValueOnce(created.promise);

    const first = service.onCreateUnassigned();
    ownerFixture.switchProject('project-a');
    const duplicate = service.onCreateUnassigned();

    expect(mockTaskOpsAdapter.addTask).toHaveBeenCalledTimes(1);
    created.resolve({ ok: true, value: 'task-a' });
    await Promise.all([first, duplicate]);
  });

  it('retires A synchronously so B can create while durable A continues', async () => {
    const createdA = deferred<AddTaskResult>();
    const createdB = deferred<AddTaskResult>();
    mockTaskOpsAdapter.addTask
      .mockReturnValueOnce(createdA.promise)
      .mockReturnValueOnce(createdB.promise);

    const completionA = service.onCreateUnassigned();
    ownerFixture.switchProject('project-b');
    const completionB = service.onCreateUnassigned();

    expect(mockTaskOpsAdapter.addTask).toHaveBeenCalledTimes(2);
    createdA.resolve({ ok: true, value: 'task-a' });
    await completionA;
    expect(setEditingTask).not.toHaveBeenCalledWith('task-a', true);
    createdB.resolve({ ok: true, value: 'task-b' });
    await completionB;
    expect(setEditingTask).toHaveBeenCalledTimes(1);
    expect(setEditingTask).toHaveBeenCalledWith('task-b', true);
  });

  it('keeps B locked when stale A finally settles', async () => {
    const createdA = deferred<AddTaskResult>();
    const createdB = deferred<AddTaskResult>();
    mockTaskOpsAdapter.addTask
      .mockReturnValueOnce(createdA.promise)
      .mockReturnValueOnce(createdB.promise);

    const completionA = service.onCreateUnassigned();
    ownerFixture.switchProject('project-b');
    const completionB = service.onCreateUnassigned();
    expect(mockTaskOpsAdapter.addTask).toHaveBeenCalledTimes(2);
    createdA.resolve({ ok: true, value: 'task-a' });
    await completionA;
    const duplicateB = service.onCreateUnassigned();

    expect(mockTaskOpsAdapter.addTask).toHaveBeenCalledTimes(2);
    createdB.resolve({ ok: true, value: 'task-b' });
    await Promise.all([completionB, duplicateB]);
  });

  it('rejects an A completion after A to B to A generation changes', async () => {
    const oldA = deferred<AddTaskResult>();
    const newA = deferred<AddTaskResult>();
    mockTaskOpsAdapter.addTask.mockReturnValueOnce(oldA.promise).mockReturnValueOnce(newA.promise);

    const oldCompletion = service.onCreateUnassigned();
    ownerFixture.switchProject('project-b');
    ownerFixture.switchProject('project-a');
    const newCompletion = service.onCreateUnassigned();
    oldA.resolve({ ok: true, value: 'old-task-a' });
    await oldCompletion;
    const duplicateNewA = service.onCreateUnassigned();

    expect(mockTaskOpsAdapter.addTask).toHaveBeenCalledTimes(2);
    expect(setEditingTask).not.toHaveBeenCalledWith('old-task-a', true);
    newA.resolve({ ok: true, value: 'new-task-a' });
    await Promise.all([newCompletion, duplicateNewA]);
    expect(setEditingTask).toHaveBeenCalledWith('new-task-a', true);
  });

  it('suppresses stale create errors and missing-stage repair UI', async () => {
    const createdA = deferred<AddTaskResult>();
    const repairA = deferred<boolean>();
    mockTaskOpsAdapter.addTask.mockReturnValueOnce(createdA.promise);
    mockTaskOpsAdapter.repairMissingStageOne.mockReturnValueOnce(repairA.promise);
    ownerFixture.setStages([{ stageNumber: 2, tasks: [createTask({ id: 'stage-a', stage: 2 })] }]);

    const createCompletion = service.onCreateUnassigned();
    const repairCompletion = service.onAddNewStage();
    ownerFixture.switchProject('project-b');
    createdA.resolve({ ok: false, error: { code: 'OPERATION_FAILED', message: 'failed' } });
    repairA.resolve(true);
    await Promise.all([createCompletion, repairCompletion]);

    expect(mockToast.error).not.toHaveBeenCalled();
    expect(setStageFilter).not.toHaveBeenCalled();
  });

  it('rejects task-relative creates when the source task is not in the current project', async () => {
    const taskA = createTask({ id: 'task-a', stage: 2 });
    ownerFixture.setTasks('project-a', [taskA]);
    ownerFixture.setTasks('project-b', [createTask({ id: 'task-b', stage: 2 })]);
    ownerFixture.switchProject('project-b');
    mockTaskOpsAdapter.addTask.mockResolvedValue({ ok: true, value: 'new-task' });

    await service.onAddSibling(taskA);
    await service.onAddChild(taskA);

    expect(mockTaskOpsAdapter.addTask).not.toHaveBeenCalled();
  });

  it('unregisters project retirement on destroy', () => {
    expect(ownerFixture.listenerCount()).toBe(1);
    service.destroy();
    expect(ownerFixture.listenerCount()).toBe(0);
  });

  it('fences delayed scroll and focus publication by the captured owner', async () => {
    vi.useFakeTimers();
    const animationFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const taskCard = document.createElement('div');
    taskCard.setAttribute('data-task-id', 'task-a');
    const scrollIntoView = vi.fn();
    Object.defineProperty(taskCard, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    const input = document.createElement('input');
    input.setAttribute('data-title-input', '');
    const focus = vi.fn();
    Object.defineProperty(input, 'focus', { configurable: true, value: focus });
    taskCard.appendChild(input);
    hostElement.appendChild(taskCard);
    mockTaskOpsAdapter.addTask.mockResolvedValue({ ok: true, value: 'task-a' });
    await service.onCreateUnassigned();
    ownerFixture.switchProject('project-b');
    while (animationFrames.length > 0) animationFrames.shift()!(0);
    vi.runAllTimers();

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it('cancels scheduled animation work and prevents post-destroy side effects', () => {
    vi.useFakeTimers();
    let nextAnimationFrameId = 1;
    const animationFrames = new Map<number, FrameRequestCallback>();
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      const animationFrameId = nextAnimationFrameId++;
      animationFrames.set(animationFrameId, callback);
      return animationFrameId;
    });
    const cancelRafSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(animationFrameId => {
      animationFrames.delete(animationFrameId);
    });
    const flushAnimationFrames = () => {
      while (animationFrames.size > 0) {
        const scheduledFrames = Array.from(animationFrames.entries());
        animationFrames.clear();
        scheduledFrames.forEach(([animationFrameId, callback]) => callback(animationFrameId));
      }
    };

    try {
      const collapseStage = vi.fn();
      const expandStage = vi.fn();
      const scrollIntoView = vi.fn();
      const inputFocus = vi.fn();
      const previewClick = vi.fn();
      dragDropService.consumeAutoCollapsedSourceStage.mockReturnValueOnce(2);
      const scrollTarget = document.createElement('div');
      scrollTarget.id = 'late-scroll-target';
      Object.defineProperty(scrollTarget, 'scrollIntoView', { configurable: true, value: scrollIntoView });
      const focusTask = document.createElement('div');
      focusTask.setAttribute('data-task-id', 'focus-task');
      Object.defineProperty(focusTask, 'scrollIntoView', { configurable: true, value: scrollIntoView });
      const titleInput = document.createElement('input');
      titleInput.setAttribute('data-title-input', '');
      Object.defineProperty(titleInput, 'focus', { configurable: true, value: inputFocus });
      focusTask.appendChild(titleInput);
      const previewTask = document.createElement('div');
      previewTask.setAttribute('data-task-id', 'preview-task');
      Object.defineProperty(previewTask, 'scrollIntoView', { configurable: true, value: scrollIntoView });
      const previewTrigger = document.createElement('button');
      previewTrigger.setAttribute('data-title-preview-trigger', '');
      Object.defineProperty(previewTrigger, 'click', { configurable: true, value: previewClick });
      previewTask.appendChild(previewTrigger);
      hostElement.append(scrollTarget, focusTask, previewTask);
      service.init({
        selectedTaskId: signal<string | null>(null),
        deleteConfirmTask: signal<Task | null>(null),
        deleteKeepChildren: signal(false),
        focusFlowNode: { emit: vi.fn() } as never,
        isMobile: signal(false),
        getStagesRef: () => ({ collapseStage, expandStage, isStageExpanded: () => true }),
        getUnassignedRef: () => undefined,
      });

      service.collapseAutoExpandedStages([1]);
      service.restoreAutoCollapsedSourceStage();
      service.scrollToElementById('#late-scroll-target');
      service.scrollToTaskAndFocus('focus-task', 'input[data-title-input]');
      service.scrollToTaskAndFocus('preview-task', 'input[data-title-input]');
      service.scrollToTaskAfterExpand('focus-task');
      const scheduledFrameCount = animationFrames.size;
      service.destroy();
      expect.soft(cancelRafSpy).toHaveBeenCalledTimes(scheduledFrameCount);
      flushAnimationFrames();
      expect.soft(vi.getTimerCount()).toBe(0);
      vi.runAllTimers();
      flushAnimationFrames();
      vi.runAllTimers();
      expect.soft(collapseStage).not.toHaveBeenCalled();
      expect.soft(expandStage).not.toHaveBeenCalled();
      expect.soft(scrollIntoView).not.toHaveBeenCalled();
      expect.soft(inputFocus).not.toHaveBeenCalled();
      expect.soft(previewClick).not.toHaveBeenCalled();
      expect.soft(vi.getTimerCount()).toBe(0);
    } finally {
      cancelRafSpy.mockRestore();
      rafSpy.mockRestore();
    }
  });
});
