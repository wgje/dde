import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DockDailySlotComponent } from './dock-daily-slot.component';
import { DockEngineService } from '../../../../services/dock-engine.service';

describe('DockDailySlotComponent', () => {
  let fixture: ComponentFixture<DockDailySlotComponent>;
  let component: DockDailySlotComponent;

  const availableDailySlots = signal<any[]>([
    {
      id: 'slot-1',
      title: '维生素',
      maxDailyCount: 1,
      todayCompletedCount: 0,
      createdAt: new Date().toISOString(),
    },
  ]);
  const suspendedEntries = signal<any[]>([
    { taskId: 'A', title: '主任务 A' },
    { taskId: 'B', title: '主任务 B' },
  ]);

  const availableFragmentDockTasks = signal<any[]>([]);

  const mockEngine = {
    availableDailySlots,
    suspendedEntries,
    availableFragmentDockTasks,
    getWaitRemainingSeconds: vi.fn((entry: { taskId: string }) => (entry.taskId === 'A' ? 300 : 900)),
    addDailySlot: vi.fn(),
    completeDailySlot: vi.fn(),
    removeDailySlot: vi.fn(),
    switchToTask: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    availableDailySlots.set([
      {
        id: 'slot-1',
        title: '维生素',
        maxDailyCount: 1,
        todayCompletedCount: 0,
        createdAt: new Date().toISOString(),
      },
    ]);
    suspendedEntries.set([
      { taskId: 'A', title: '主任务 A' },
      { taskId: 'B', title: '主任务 B' },
    ]);

    await TestBed.configureTestingModule({
      imports: [DockDailySlotComponent],
      providers: [{ provide: DockEngineService, useValue: mockEngine }],
    }).compileComponents();

    fixture = TestBed.createComponent(DockDailySlotComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should compute soonest waiting label from suspended entries', () => {
    expect(component.soonestWaitLabel()).toContain('主任务 A');
    expect(component.soonestWaitLabel()).toContain('5min');
  });

  it('addSlot should call engine.addDailySlot and reset form', () => {
    component.newTitle = '喝水';
    component.newMaxCount = 2;
    component.addSlot();

    expect(mockEngine.addDailySlot).toHaveBeenCalledWith('喝水', 2);
    expect(component.newTitle).toBe('');
    expect(component.newMaxCount).toBe(1);
    expect(component.showAddForm()).toBe(false);
  });

  it('isSlotDone should match maxDailyCount rule', () => {
    expect(component.isSlotDone({ todayCompletedCount: 1, maxDailyCount: 1 })).toBe(true);
    expect(component.isSlotDone({ todayCompletedCount: 0, maxDailyCount: 1 })).toBe(false);
  });

  it('should disable always-on countdown breathe in performance motion profile', () => {
    expect(component.enableCountdownBreathe).toBe(false);
  });
});
