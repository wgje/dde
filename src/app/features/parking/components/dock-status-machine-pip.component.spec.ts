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
    blankPeriodActive: computed(
      () =>
        fragmentEntryCountdown() === null
        && pendingDecision() !== null
        && pendingDecisionEntries().length === 0,
    ),
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
    } as DockEntry);
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
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-focus-inline-row"]')?.textContent).toContain('Current Focus');
    expect(component.taskRows()[0]?.type).toBe('focus-context');
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
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-focus-inline-row"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-task-list"]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-toolbar"]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('header')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('Status PiP');
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-summary"]')?.getAttribute('data-summary-mode')).toBe('regular');
  });

  it('should render current focus and all secondary alerts in one task list without folding', () => {
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
    expect(component.taskRows()).toHaveLength(4);
    expect(component.taskRows()[0]?.type).toBe('focus-context');

    const taskList = fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-task-list"]') as HTMLElement | null;
    expect(taskList?.textContent).toContain('Current Focus');
    expect(taskList?.textContent).toContain('Expired C');
    expect(taskList?.textContent).toContain('Stalled D');
    expect(taskList?.textContent).toContain('Waiting E');
    expect(taskList?.textContent).not.toContain('折叠');
    expect(taskList?.textContent).not.toContain('更多');
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

  it('should collapse summary tokens into a single-line overflow summary in micro layout', () => {
    const original = { width: window.innerWidth, height: window.innerHeight };
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
        title: 'Stalled C',
        uiStatus: 'stalled',
        label: '停滞中',
        waitRemainingSeconds: null,
        waitTotalSeconds: null,
      },
      {
        taskId: 'D',
        title: 'Waiting D',
        uiStatus: 'suspended_waiting',
        label: '挂起等待',
        waitRemainingSeconds: 180,
        waitTotalSeconds: 300,
      },
    ]);
    fixture.detectChanges();

    try {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 280 });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 300 });
      component.onViewportResize();
      fixture.detectChanges();

      expect(component.layoutMode()).toBe('micro');
      expect(component.summaryTokens().map(token => token.id)).toEqual(['expired', 'stalled', 'waiting', 'focus']);
      expect(component.visibleSummaryTokens().map(token => token.label)).toEqual(['到时', '停滞', '+2']);

      const summary = fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-summary"]') as HTMLElement | null;
      expect(summary).toBeNull();
      expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-toolbar"]')?.getAttribute('data-toolbar-mode')).toBe('buttons-only');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: original.width });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: original.height });
      component.onViewportResize();
      fixture.detectChanges();
    }
  });

  it('secondary task rows should preserve click behavior inside the compact task list', () => {
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
        title: 'Stalled B',
        uiStatus: 'stalled',
        label: '停滞中',
        waitRemainingSeconds: null,
        waitTotalSeconds: null,
      },
    ]);
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-task-row-stalled"]')?.click();

    expect(mockEngine.switchToTask).toHaveBeenCalledWith('B');
    expect(returnSpy).toHaveBeenCalledTimes(1);
  });

  it('should switch to micro layouts at 280x300 while keeping toolbar actions clickable', () => {
    const original = { width: window.innerWidth, height: window.innerHeight };
    const returnSpy = vi.fn();
    const closeSpy = vi.fn();
    component.returnRequested.subscribe(returnSpy);
    component.closeRequested.subscribe(closeSpy);
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
        title: 'Stalled C',
        uiStatus: 'stalled',
        label: '停滞中',
        waitRemainingSeconds: null,
        waitTotalSeconds: null,
      },
    ]);
    fixture.detectChanges();

    try {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 280 });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 300 });
      component.onViewportResize();
      fixture.detectChanges();

      expect(component.layoutMode()).toBe('micro');
      expect(component.primaryCardLayout()).toBe('stack');
      expect(component.toolbarMode()).toBe('buttons-only');
      expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-task-list"]')?.textContent).toContain('Current Focus');
      expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-task-list"]')?.textContent).toContain('Stalled C');
      expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-toolbar"]')?.getAttribute('data-toolbar-mode')).toBe('buttons-only');
      expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-toolbar-buttons"]')).toBeTruthy();
      expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-toolbar-buttons"]')?.children.length).toBe(4);
      expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-status-machine-pip"]')?.getAttribute('data-layout-mode')).toBe('micro');
      expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-primary-action-wait-finished"]')?.closest('section')?.getAttribute('data-primary-layout')).toBe('stack');

      fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-return"]')?.click();
      fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-mute"]')?.click();
      fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-close"]')?.click();
      fixture.nativeElement.querySelector('[data-testid="dock-v3-pip-exit-focus"]')?.click();

      expect(returnSpy).toHaveBeenCalledTimes(1);
      expect(mockEngine.toggleMuteWaitTone).toHaveBeenCalledTimes(1);
      expect(mockEngine.toggleFocusMode).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledTimes(2);
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: original.width });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: original.height });
      component.onViewportResize();
      fixture.detectChanges();
    }
  });
});
