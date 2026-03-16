import { ComponentFixture, TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DockStatusMachinePipComponent } from './dock-status-machine-pip.component';
import { DockEngineService } from '../../../../services/dock-engine.service';
import {
  StatusMachineEntry,
  DockEntry,
  DockPendingDecision,
  DockPendingDecisionEntry,
} from '../../../../models/parking-dock';

describe('DockStatusMachinePipComponent', () => {
  let fixture: ComponentFixture<DockStatusMachinePipComponent>;
  let component: DockStatusMachinePipComponent;

  const focusMode = signal(true);
  const muted = signal(false);
  const statusEntries = signal<StatusMachineEntry[]>([]);
  const focusingEntry = signal<DockEntry | null>(null);
  const pendingDecision = signal<DockPendingDecision | null>(null);
  const pendingDecisionEntries = signal<DockPendingDecisionEntry[]>([]);
  const fragmentEntryCountdown = signal<number | null>(null);
  const isBurnoutActive = signal(false);
  const restReminderActive = signal(false);
  const cumulativeHighLoadMs = signal(0);
  const cumulativeLowLoadMs = signal(0);

  const mockEngine = {
    focusMode,
    toggleFocusMode: vi.fn(() => focusMode.set(false)),
    statusMachineEntries: statusEntries,
    focusingEntry: computed(() => focusingEntry()),
    muteWaitTone: muted,
    pendingDecision,
    pendingDecisionEntries,
    fragmentEntryCountdown,
    isBurnoutActive,
    restReminderActive,
    cumulativeHighLoadMs,
    cumulativeLowLoadMs,
    switchToTask: vi.fn(),
    toggleMuteWaitTone: vi.fn(() => muted.update(value => !value)),
    fragmentRest: {
      dismissRestReminder: vi.fn(),
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    focusMode.set(true);
    muted.set(false);
    pendingDecision.set(null);
    pendingDecisionEntries.set([]);
    fragmentEntryCountdown.set(null);
    isBurnoutActive.set(false);
    restReminderActive.set(false);
    cumulativeHighLoadMs.set(0);
    cumulativeLowLoadMs.set(0);
    focusingEntry.set({
      taskId: 'A',
      title: 'Current Focus',
      expectedMinutes: 25,
      waitMinutes: null,
      isMain: true,
    });
    statusEntries.set([
      {
        taskId: 'A',
        title: 'Current Focus',
        uiStatus: 'focusing',
        label: '专注中',
        waitRemainingSeconds: null,
        waitTotalSeconds: null,
      },
    ]);

    await TestBed.configureTestingModule({
      imports: [DockStatusMachinePipComponent],
      providers: [{ provide: DockEngineService, useValue: mockEngine }],
    }).compileComponents();

    fixture = TestBed.createComponent(DockStatusMachinePipComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should prioritize wait-finished as the primary alert', () => {
    statusEntries.set([
      {
        taskId: 'A',
        title: 'Current Focus',
        uiStatus: 'focusing',
        label: '专注中',
        waitRemainingSeconds: null,
        waitTotalSeconds: null,
      },
      {
        taskId: 'B',
        title: 'Wait Done',
        uiStatus: 'waiting_done',
        label: '等待结束',
        waitRemainingSeconds: 0,
        waitTotalSeconds: 300,
      },
    ]);
    fixture.detectChanges();

    expect(component.primaryAlert().kind).toBe('wait-finished');
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-primary-headline"]')?.textContent).toContain('Wait Done');
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-focus-card"]')).toBeTruthy();
  });

  it('should treat zero-second suspended waiting entries as wait-finished alerts', () => {
    statusEntries.set([
      {
        taskId: 'A',
        title: 'Current Focus',
        uiStatus: 'focusing',
        label: '专注中',
        waitRemainingSeconds: null,
        waitTotalSeconds: null,
      },
      {
        taskId: 'B',
        title: 'Boundary Wait',
        uiStatus: 'suspended_waiting',
        label: '挂起等待',
        waitRemainingSeconds: 0,
        waitTotalSeconds: 300,
      },
    ]);
    fixture.detectChanges();

    expect(component.primaryAlert().kind).toBe('wait-finished');
    expect(component.primaryAlert().taskId).toBe('B');
  });

  it('should fall back to current focus summary when there is no urgent alert', () => {
    fixture.detectChanges();

    expect(component.primaryAlert().kind).toBe('focus');
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-primary-headline"]')?.textContent).toContain('Current Focus');
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-focus-card"]')).toBeNull();
  });

  it('should render all secondary alerts directly without folding when four tasks are present', () => {
    statusEntries.set([
      {
        taskId: 'A',
        title: 'Current Focus',
        uiStatus: 'focusing',
        label: '专注中',
        waitRemainingSeconds: null,
        waitTotalSeconds: null,
      },
      {
        taskId: 'B',
        title: 'Expired B',
        uiStatus: 'waiting_done',
        label: '等待结束',
        waitRemainingSeconds: 0,
        waitTotalSeconds: 300,
      },
      {
        taskId: 'C',
        title: 'Expired C',
        uiStatus: 'waiting_done',
        label: '等待结束',
        waitRemainingSeconds: 0,
        waitTotalSeconds: 300,
      },
      {
        taskId: 'D',
        title: 'Stalled D',
        uiStatus: 'stalled',
        label: '停滞中',
        waitRemainingSeconds: null,
        waitTotalSeconds: null,
      },
      {
        taskId: 'E',
        title: 'Waiting E',
        uiStatus: 'suspended_waiting',
        label: '挂起等待',
        waitRemainingSeconds: 180,
        waitTotalSeconds: 300,
      },
    ]);
    fixture.detectChanges();

    expect(component.secondaryAlerts()).toHaveLength(3);
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-secondary-list"]')?.textContent).toContain('Expired C');
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-secondary-list"]')?.textContent).toContain('Stalled D');
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-secondary-list"]')?.textContent).toContain('Waiting E');
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-secondary-list"]')?.textContent).not.toContain('折叠');
  });

  it('primary alert action should switch task for wait-finished items', () => {
    const returnSpy = vi.fn();
    component.returnRequested.subscribe(returnSpy);
    statusEntries.set([
      {
        taskId: 'A',
        title: 'Current Focus',
        uiStatus: 'focusing',
        label: '专注中',
        waitRemainingSeconds: null,
        waitTotalSeconds: null,
      },
      {
        taskId: 'B',
        title: 'Expired B',
        uiStatus: 'waiting_done',
        label: '等待结束',
        waitRemainingSeconds: 0,
        waitTotalSeconds: 300,
      },
    ]);
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-primary-action-wait-finished"]')?.click();

    expect(mockEngine.switchToTask).toHaveBeenCalledWith('B');
    expect(returnSpy).toHaveBeenCalledTimes(1);
  });

  it('waiting alerts should also switch to the related task before returning', () => {
    const returnSpy = vi.fn();
    component.returnRequested.subscribe(returnSpy);
    focusingEntry.set(null);
    statusEntries.set([
      {
        taskId: 'B',
        title: 'Waiting B',
        uiStatus: 'suspended_waiting',
        label: '挂起等待',
        waitRemainingSeconds: 180,
        waitTotalSeconds: 300,
      },
    ]);
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-primary-action-waiting"]')?.click();

    expect(mockEngine.switchToTask).toHaveBeenCalledWith('B');
    expect(returnSpy).toHaveBeenCalledTimes(1);
  });

  it('rest reminder action should dismiss in place without returning', () => {
    const returnSpy = vi.fn();
    component.returnRequested.subscribe(returnSpy);
    restReminderActive.set(true);
    cumulativeHighLoadMs.set(45 * 60 * 1000);
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-primary-action-rest-reminder"]')?.click();

    expect(mockEngine.fragmentRest.dismissRestReminder).toHaveBeenCalledTimes(1);
    expect(returnSpy).not.toHaveBeenCalled();
  });
});
