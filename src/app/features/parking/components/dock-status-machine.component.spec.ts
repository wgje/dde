import { ComponentFixture, TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DockStatusMachineComponent } from './dock-status-machine.component';
import { DockEngineService } from '../../../../services/dock-engine.service';
import {
  StatusMachineEntry,
  DockPendingDecision,
  DockPendingDecisionEntry,
} from '../../../../models/parking-dock';

describe('DockStatusMachineComponent', () => {
  let fixture: ComponentFixture<DockStatusMachineComponent>;
  let component: DockStatusMachineComponent;

  const statusEntries = signal<StatusMachineEntry[]>([
    {
      taskId: 'A',
      title: 'Focus A',
      uiStatus: 'focusing',
      label: '专注中',
      waitRemainingSeconds: null,
      waitTotalSeconds: null,
    },
    {
      taskId: 'B',
      title: 'Waiting B',
      uiStatus: 'suspended_waiting',
      label: '挂起等待',
      waitRemainingSeconds: 120,
      waitTotalSeconds: 300,
    },
  ]);
  const muted = signal(false);
  const pendingDecision = signal<DockPendingDecision | null>(null);
  const pendingDecisionEntries = signal<DockPendingDecisionEntry[]>([]);
  const fragmentEntryCountdown = signal<number | null>(null);

  const mockEngine = {
    statusMachineEntries: statusEntries,
    muteWaitTone: muted,
    pendingDecision,
    pendingDecisionEntries,
    fragmentEntryCountdown,
    switchToTask: vi.fn(),
    toggleMuteWaitTone: vi.fn(() => muted.update(value => !value)),
    isBurnoutActive: signal(false),
    blankPeriodActive: computed(
      () =>
        fragmentEntryCountdown() === null
        && pendingDecision() !== null
        && pendingDecisionEntries().length === 0,
    ),
    fragmentDefenseLevel: signal(1 as 1 | 2),
    burnoutTriggeredAt: signal<number | null>(null),
    restReminderActive: signal(false),
    cumulativeHighLoadMs: signal(0),
    cumulativeLowLoadMs: signal(0),
    fragmentRest: {
      dismissRestReminder: vi.fn(),
    },
    tick: signal(0),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    muted.set(false);
    pendingDecision.set(null);
    pendingDecisionEntries.set([]);
    fragmentEntryCountdown.set(null);
    mockEngine.isBurnoutActive.set(false);
    mockEngine.fragmentDefenseLevel.set(1);
    statusEntries.set([
      {
        taskId: 'A',
        title: 'Focus A',
        uiStatus: 'focusing',
        label: '专注中',
        waitRemainingSeconds: null,
        waitTotalSeconds: null,
      },
      {
        taskId: 'B',
        title: 'Waiting B',
        uiStatus: 'suspended_waiting',
        label: '挂起等待',
        waitRemainingSeconds: 120,
        waitTotalSeconds: 300,
      },
    ]);

    await TestBed.configureTestingModule({
      imports: [DockStatusMachineComponent],
      providers: [{ provide: DockEngineService, useValue: mockEngine }],
    }).compileComponents();

    fixture = TestBed.createComponent(DockStatusMachineComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should compute ring progress and keep waiting entries non-expired', () => {
    const waiting = component.suspendedEntries()[0];
    expect(waiting.taskId).toBe('B');
    expect(component.isExpired(waiting)).toBe(false);
    expect(component.getRingOffset(waiting)).toBeGreaterThan(0);
  });

  it('should mark waiting_done entry as expired', () => {
    statusEntries.set([
      {
        taskId: 'C',
        title: 'Expired C',
        uiStatus: 'waiting_done',
        label: '等待结束',
        waitRemainingSeconds: 0,
        waitTotalSeconds: 60,
      },
    ]);
    fixture.detectChanges();

    expect(component.hasExpiredTask()).toBe(true);
    expect(component.isExpired(component.suspendedEntries()[0])).toBe(true);
  });

  it('clicking suspended item should switch focus task', () => {
    const waiting = component.suspendedEntries()[0];
    component.onSuspendedClick(waiting);
    expect(mockEngine.switchToTask).toHaveBeenCalledWith('B');
  });

  it('should render stalled entries separately and allow resume', () => {
    statusEntries.set([
      {
        taskId: 'A',
        title: 'Main A',
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
    fixture.componentRef.setInput('forcedMode', 'full');
    fixture.detectChanges();

    expect(component.stalledEntries()).toHaveLength(1);
    expect(fixture.nativeElement.textContent).toContain('停滞中');

    component.onStalledClick(component.stalledEntries()[0]);
    expect(mockEngine.switchToTask).toHaveBeenCalledWith('B');
  });

  it('toggleMute should switch mute state via engine', () => {
    component.toggleMute();
    expect(mockEngine.toggleMuteWaitTone).toHaveBeenCalled();
    expect(muted()).toBe(true);
  });

  it('status mute button should keep a 44px touch target', () => {
    fixture.componentRef.setInput('forcedMode', 'full');
    fixture.detectChanges();

    const muteButton = fixture.nativeElement.querySelector('[data-testid="dock-v3-status-mute"]') as HTMLButtonElement | null;
    expect(muteButton?.getAttribute('style')).toContain('min-height: 44px;');
  });

  it('should keep status extra glow enabled for T0 performance mode when the product flag is on', () => {
    expect(component.enableStatusExtraGlow()).toBe(true);
  });

  it('should enable rest reminder glow through the dedicated config path', () => {
    expect(component.enableRestReminderGlow()).toBe(true);
  });

  it('should allow forced minimal HUD mode override', () => {
    fixture.componentRef.setInput('forcedMode', 'minimal');
    fixture.detectChanges();
    expect(component.hudMode()).toBe('minimal');
  });

  it('should switch to full mode for blank period when not forced', () => {
    pendingDecision.set({ reason: '窗口过短', rootTaskId: 'root', rootRemainingMinutes: 0, candidateGroups: [], createdAt: new Date().toISOString() });
    pendingDecisionEntries.set([]);
    statusEntries.set([]);
    fixture.componentRef.setInput('forcedMode', null);
    fixture.detectChanges();

    expect(component.blankPeriodActive()).toBe(true);
    expect(component.hudMode()).toBe('full');
    expect(fixture.nativeElement.textContent).toContain('留白期');
  });

  it('should render the same four entries provided by the console-visible source without overflow folding', () => {
    statusEntries.set([
      {
        taskId: 'A',
        title: 'Focus A',
        uiStatus: 'focusing',
        label: '专注中',
        waitRemainingSeconds: null,
        waitTotalSeconds: null,
      },
      {
        taskId: 'B',
        title: 'Waiting B',
        uiStatus: 'suspended_waiting',
        label: '挂起等待',
        waitRemainingSeconds: 120,
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
        title: 'Queued D',
        uiStatus: 'queued',
        label: '待启动',
        waitRemainingSeconds: null,
        waitTotalSeconds: null,
      },
    ]);
    fixture.componentRef.setInput('forcedMode', 'full');
    fixture.detectChanges();

    expect(component.allEntries()).toHaveLength(4);
    expect(fixture.nativeElement.textContent).toContain('4');
    expect(fixture.nativeElement.textContent).toContain('Focus A');
    expect(fixture.nativeElement.textContent).toContain('Waiting B');
    expect(fixture.nativeElement.textContent).toContain('Stalled C');
    expect(fixture.nativeElement.textContent).toContain('Queued D');
    expect(fixture.nativeElement.querySelectorAll('[data-testid="dock-v3-status-entry-suspended"]')).toHaveLength(1);
    expect(fixture.nativeElement.querySelectorAll('[data-testid="dock-v3-status-entry-stalled"]')).toHaveLength(1);
    expect(fixture.nativeElement.querySelectorAll('[data-state="idle"]')).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-status-overflow"]')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('第五项');
  });
});
