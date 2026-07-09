import { ComponentFixture, TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type DockEntry } from '../../../../models/parking-dock';
import { DockPlannerQuickEditService } from '../services/dock-planner-quick-edit.service';
import { DockPlannerQuickEditPanelComponent } from './dock-planner-quick-edit-panel.component';

function createDockEntry(overrides: Partial<DockEntry> = {}): DockEntry {
  return {
    taskId: 'task-1',
    title: 'Planner Task',
    sourceProjectId: null,
    status: 'pending_start',
    load: 'low',
    expectedMinutes: null,
    waitMinutes: null,
    waitStartedAt: null,
    lane: 'backup',
    zoneSource: 'manual',
    isMain: false,
    dockedOrder: 1,
    detail: '',
    sourceKind: 'dock-created',
    systemSelected: false,
    recommendedScore: null,
    ...overrides,
  };
}

describe('DockPlannerQuickEditPanelComponent', () => {
  let fixture: ComponentFixture<DockPlannerQuickEditPanelComponent>;
  let component: DockPlannerQuickEditPanelComponent;
  let activeEntry: ReturnType<typeof signal<DockEntry | null>>;
  let planner: Pick<
    DockPlannerQuickEditService,
    | 'activeEntry'
    | 'expectedPresets'
    | 'missingFieldCount'
    | 'panelClasses'
    | 'presentation'
    | 'setPlannerQuickEditExpected'
    | 'setPlannerQuickEditLoad'
    | 'setPlannerQuickEditWait'
    | 'waitPresets'
  >;

  beforeEach(async () => {
    activeEntry = signal<DockEntry | null>(createDockEntry());
    planner = {
      activeEntry: activeEntry.asReadonly(),
      expectedPresets: [15, 30],
      missingFieldCount: computed(() => activeEntry()?.expectedMinutes === null ? 1 : 0),
      panelClasses: signal('rounded-2xl mx-2 border-amber-500/20').asReadonly(),
      presentation: signal<'popover'>('popover').asReadonly(),
      setPlannerQuickEditExpected: vi.fn(),
      setPlannerQuickEditLoad: vi.fn(),
      setPlannerQuickEditWait: vi.fn(),
      waitPresets: [5, 10],
    };

    await TestBed.configureTestingModule({
      imports: [DockPlannerQuickEditPanelComponent],
      providers: [
        { provide: DockPlannerQuickEditService, useValue: planner },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(DockPlannerQuickEditPanelComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders the active planner entry and exposes the panel element for portal control', () => {
    const panel = fixture.debugElement.query(By.css('[data-testid="dock-v3-planner-panel"]')).nativeElement as HTMLElement;

    expect(panel.textContent).toContain('Planner Task');
    expect(panel.textContent).toContain('当前负荷');
    expect(panel.textContent).toContain('预计投入');
    expect(panel.getAttribute('data-presentation')).toBe('popover');
    expect(component.panelElement()?.nativeElement).toBe(panel);
  });

  it('emits closeRequested from the close button', () => {
    const closeSpy = vi.fn();
    component.closeRequested.subscribe(closeSpy);

    const closeButton = fixture.debugElement.query(By.css('[data-testid="dock-v3-planner-close"]')).nativeElement as HTMLButtonElement;
    closeButton.click();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('delegates expected, load, and wait changes to the planner service', () => {
    fixture.debugElement.query(By.css('[data-testid="dock-v3-planner-expected"]')).nativeElement.click();
    fixture.debugElement.query(By.css('[data-testid="dock-v3-planner-load-high"]')).nativeElement.click();
    fixture.debugElement.query(By.css('[data-testid="dock-v3-planner-wait"]')).nativeElement.click();

    expect(planner.setPlannerQuickEditExpected).toHaveBeenCalledWith('task-1', 15);
    expect(planner.setPlannerQuickEditLoad).toHaveBeenCalledWith('task-1', 'high');
    expect(planner.setPlannerQuickEditWait).toHaveBeenCalledWith('task-1', 5);
  });
});
