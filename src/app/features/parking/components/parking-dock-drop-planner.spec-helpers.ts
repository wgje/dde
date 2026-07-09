import type { ComponentFixture } from '@angular/core/testing';
import type { WritableSignal } from '@angular/core';
import { expect, it, vi } from 'vitest';

import type { DockEntry } from '../../../../models/parking-dock';
import { ParkingDockComponent } from '../parking-dock.component';

type MockFn = ReturnType<typeof vi.fn>;
type DropPlannerDockEntry = Partial<DockEntry>
  & Pick<DockEntry, 'taskId' | 'title' | 'status' | 'load' | 'lane' | 'isMain'>;

export interface ParkingDockDropPlannerSpecContext {
  fixture: ComponentFixture<ParkingDockComponent>;
  component: ParkingDockComponent;
  dockedEntries: WritableSignal<DropPlannerDockEntry[]>;
  focusMode: WritableSignal<boolean>;
  focusScrimOn: WritableSignal<boolean>;
  mockEngine: {
    dockTaskFromExternalDrag: MockFn;
    dockTask: MockFn;
    setExpectedTime: MockFn;
    setWaitTime: MockFn;
    toggleLoad: MockFn;
  };
}

export function registerParkingDockDropPlannerSpecs(getContext: () => ParkingDockDropPlannerSpecContext): void {
  it('onDrop should prefer unified payload protocol taskId', () => {
    const { component, mockEngine } = getContext();
    const getData = vi.fn((mime: string) => {
      if (mime === 'application/x-nanoflow-task') {
        return JSON.stringify({ v: 1, type: 'task', taskId: 'task-1', projectId: 'p-1', source: 'flow' });
      }
      return '';
    });

    component.onDrop({
      preventDefault: vi.fn(),
      dataTransfer: { getData } as unknown as DataTransfer,
    } as unknown as DragEvent);

    expect(mockEngine.dockTaskFromExternalDrag).toHaveBeenCalledWith('task-1', 'flow');
    expect(component.dragDrop.dropState()).toBe('idle');
  });

  it('onDrop should fallback to text/plain and use default backup entrypoint', () => {
    const { component, mockEngine } = getContext();
    const getData = vi.fn((mime: string) => (mime === 'text/plain' ? 'legacy-task' : ''));

    component.onDrop({
      preventDefault: vi.fn(),
      dataTransfer: { getData } as unknown as DataTransfer,
    } as unknown as DragEvent);

    expect(mockEngine.dockTaskFromExternalDrag).toHaveBeenCalledWith('legacy-task', undefined);
  });

  it('drop-zone drag depth should prevent state jitter when moving over child elements', () => {
    const { component } = getContext();
    const taskDragTransfer = {
      types: ['application/x-nanoflow-task'],
    } as unknown as DataTransfer;

    component.dragDrop.onDropZoneDragEnter({
      preventDefault: vi.fn(),
      dataTransfer: taskDragTransfer,
    } as unknown as DragEvent);
    component.dragDrop.onDropZoneDragEnter({
      preventDefault: vi.fn(),
      dataTransfer: taskDragTransfer,
    } as unknown as DragEvent);

    component.dragDrop.onDropZoneDragLeave();
    expect(component.dragDrop.dropState()).toBe('isOver');

    component.dragDrop.onDropZoneDragLeave();
    expect(component.dragDrop.dropState()).toBe('canDrop');
  });

  it('drop-zone dragover without task types should not flash reject', () => {
    const { component } = getContext();
    component.dragDrop.dropState.set('isOver');

    component.dragDrop.onDropZoneDragOver({
      preventDefault: vi.fn(),
      dataTransfer: { types: [] } as unknown as DataTransfer,
    } as unknown as DragEvent);

    expect(component.dragDrop.dropState()).toBe('canDrop');
  });

  it('onDrop should ignore laneHint and still use default backup entrypoint', () => {
    const { component, mockEngine } = getContext();
    const getData = vi.fn((mime: string) => {
      if (mime === 'application/x-nanoflow-task') {
        return JSON.stringify({
          v: 1,
          type: 'task',
          taskId: 'task-lane-hint',
          projectId: 'p-1',
          source: 'text',
          laneHint: 'combo-select',
        });
      }
      return '';
    });

    component.onDrop({
      preventDefault: vi.fn(),
      dataTransfer: { getData } as unknown as DataTransfer,
    } as unknown as DragEvent);

    expect(mockEngine.dockTaskFromExternalDrag).toHaveBeenCalledWith('task-lane-hint', 'text');
    expect(mockEngine.dockTask).not.toHaveBeenCalled();
  });

  it('invalid drop should enter reject state and not dock duplicated task', async () => {
    const { component, dockedEntries, mockEngine } = getContext();
    dockedEntries.set([
      {
        taskId: 'task-1',
        title: 'Task 1',
        status: 'pending_start',
        load: 'low',
        lane: 'combo-select',
        isMain: false,
      },
    ]);

    const getData = vi.fn((mime: string) => {
      if (mime === 'application/x-nanoflow-task') {
        return JSON.stringify({ v: 1, type: 'task', taskId: 'task-1', projectId: 'p-1', source: 'flow' });
      }
      return '';
    });

    component.onDrop({
      preventDefault: vi.fn(),
      dataTransfer: { getData } as unknown as DataTransfer,
    } as unknown as DragEvent);

    expect(component.dragDrop.dropState()).toBe('reject');
    expect(mockEngine.dockTaskFromExternalDrag).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(240);
    expect(component.dragDrop.dropState()).toBe('idle');
  });

  it('drop with incomplete planner fields should keep planner as an explicit opt-in action', () => {
    const { component } = getContext();
    const getData = vi.fn((mime: string) => {
      if (mime === 'application/x-nanoflow-task') {
        return JSON.stringify({
          v: 1,
          type: 'task',
          taskId: 'task-missing-fields',
          projectId: 'p-1',
          source: 'text',
        });
      }
      return '';
    });

    component.onDrop({
      preventDefault: vi.fn(),
      dataTransfer: { getData } as unknown as DataTransfer,
    } as unknown as DragEvent);

    expect(component.isPlannerQuickEditOpen('task-missing-fields')).toBe(false);
    expect(component.planner.recentlyDockedTaskId()).toBe('task-missing-fields');
  });

  it('planner quick edit should forward explicit planner changes to the engine', () => {
    const { component, dockedEntries, mockEngine } = getContext();
    dockedEntries.set([
      {
        taskId: 'task-planner',
        title: 'Planner Task',
        status: 'pending_start',
        load: 'low',
        lane: 'backup',
        expectedMinutes: null,
        waitMinutes: null,
        isMain: false,
      },
    ]);

    component.togglePlannerQuickEdit('task-planner');
    component.setPlannerQuickEditExpected('task-planner', 45);
    component.setPlannerQuickEditWait('task-planner', 15);
    component.setPlannerQuickEditLoad('task-planner', 'high');

    expect(mockEngine.setExpectedTime).toHaveBeenCalledWith('task-planner', 45);
    expect(mockEngine.setWaitTime).toHaveBeenCalledWith('task-planner', 15);
    expect(mockEngine.toggleLoad).toHaveBeenCalledWith('task-planner', 'up');
  });

  it('planner quick edit should render a card-level trigger even when planner fields are already complete', () => {
    const { fixture, dockedEntries } = getContext();
    dockedEntries.set([
      {
        taskId: 'task-planner-complete',
        title: 'Planner Complete Task',
        status: 'pending_start',
        load: 'low',
        lane: 'backup',
        expectedMinutes: 45,
        waitMinutes: 15,
        isMain: false,
      },
    ]);
    fixture.detectChanges();

    const card = fixture.nativeElement.querySelector('[data-testid="dock-v3-item"]') as HTMLElement | null;
    const trigger = card?.querySelector('[data-testid="dock-v3-planner-toggle"]') as HTMLButtonElement | null;

    expect(trigger).toBeTruthy();
    expect(trigger?.getAttribute('data-planner-task-id')).toBe('task-planner-complete');
    expect(trigger?.disabled).toBe(false);
  });

  it('planner quick edit should mark the dock card as open while rendering the panel outside the card rail', () => {
    const { fixture, component, dockedEntries } = getContext();
    dockedEntries.set([
      {
        taskId: 'task-planner-open',
        title: 'Planner Open Task',
        status: 'pending_start',
        load: 'low',
        lane: 'backup',
        expectedMinutes: null,
        waitMinutes: null,
        isMain: false,
      },
    ]);

    component.togglePlannerQuickEdit('task-planner-open');
    fixture.detectChanges();
    // 避免 vi.runAllTimersAsync() —— 在 isolate:false 环境下会触发其它测试文件泄漏的 setInterval，导致 10000 timer 限制
    vi.advanceTimersByTime(0);
    fixture.detectChanges();

    const card = fixture.nativeElement.querySelector('[data-testid="dock-v3-item"]') as HTMLElement | null;
    const panel = fixture.nativeElement.querySelector('[data-testid="dock-v3-planner-panel"]') as HTMLElement | null;

    expect(card?.classList.contains('planner-open')).toBe(true);
    expect(component.isPlannerQuickEditOpen('task-planner-open')).toBe(true);
    expect(panel).toBeTruthy();
    expect(card?.contains(panel as Node)).toBe(false);
    expect(panel?.className).toContain('rounded-2xl');
    expect(panel?.className).toContain('mx-2');
    expect(panel?.className).toContain('border-amber-500/20');
    expect(panel?.className).toContain('animate-[plannerInlineExpand_300ms');
    expect(panel?.getAttribute('data-presentation')).toBe('popover');
    expect(panel?.textContent).toContain('当前负荷');
    expect(panel?.textContent).toContain('预计投入');
  });

  it('secondary rail banner should follow the current focusing task when opening planner quick edit', () => {
    const { fixture, component, dockedEntries, focusMode, focusScrimOn } = getContext();
    dockedEntries.set([
      {
        taskId: 'focus-prev',
        title: 'Previous Focus',
        status: 'stalled',
        load: 'low',
        lane: 'backup',
        expectedMinutes: 30,
        waitMinutes: null,
        isMain: true,
      },
      {
        taskId: 'focus-current',
        title: 'Current Focus',
        status: 'focusing',
        load: 'high',
        lane: 'combo-select',
        expectedMinutes: null,
        waitMinutes: null,
        isMain: false,
      },
    ]);
    focusMode.set(true);
    focusScrimOn.set(true);
    fixture.detectChanges();

    const bannerToggle = fixture.nativeElement.querySelector(
      '[data-testid="dock-v3-secondary-rail-banner"] [data-testid="dock-v3-planner-toggle"]',
    ) as HTMLButtonElement | null;

    expect(component.planner.bannerTarget()?.taskId).toBe('focus-current');
    expect(fixture.nativeElement.textContent).toContain('Current Focus');

    bannerToggle?.click();
    fixture.detectChanges();

    expect(component.planner.activeEntry()?.taskId).toBe('focus-current');
  });

  it('desktop planner quick edit should close on outside pointer down', () => {
    const { fixture, component, dockedEntries } = getContext();
    dockedEntries.set([
      {
        taskId: 'task-planner-outside',
        title: 'Planner Outside Task',
        status: 'pending_start',
        load: 'low',
        lane: 'backup',
        expectedMinutes: null,
        waitMinutes: null,
        isMain: false,
      },
    ]);

    component.togglePlannerQuickEdit('task-planner-outside');
    fixture.detectChanges();

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    fixture.detectChanges();

    expect(component.isPlannerQuickEditOpen('task-planner-outside')).toBe(false);
  });
}
