import { ComponentFixture, TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockConsoleStackComponent } from './dock-console-stack.component';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { PARKING_CONFIG } from '../../../../config/parking.config';
import { KnowledgeAnchorComponent } from '../../../shared/components/knowledge-anchor/knowledge-anchor.component';
import { KnowledgeAnchorStubComponent } from '../../../../tests/stubs/knowledge-anchor.stub';
import {
  resolveConsoleCardStablePoseKey,
  toConsoleCardFilter,
  toConsoleCardOpacity,
  toConsoleCardTransform,
} from '../utils/dock-console-motion';

const consoleMotion = PARKING_CONFIG.MOTION.console;

type EntryStatus = 'focusing' | 'pending_start' | 'suspended_waiting' | 'stalled';

interface TestEntry {
  taskId: string;
  title: string;
  status: EntryStatus;
  load: 'high' | 'low';
  expectedMinutes: number | null;
  waitMinutes: number | null;
  dockedOrder: number;
  detail: string;
  isMain: boolean;
}

function createEntry(overrides: Partial<TestEntry> & Pick<TestEntry, 'taskId' | 'title'>): TestEntry {
  return {
    taskId: overrides.taskId,
    title: overrides.title,
    status: overrides.status ?? 'pending_start',
    load: overrides.load ?? 'low',
    expectedMinutes: overrides.expectedMinutes ?? 15,
    waitMinutes: overrides.waitMinutes ?? null,
    dockedOrder: overrides.dockedOrder ?? 0,
    detail: overrides.detail ?? '',
    isMain: overrides.isMain ?? true,
  };
}

describe('DockConsoleStackComponent', () => {
  let fixture: ComponentFixture<DockConsoleStackComponent>;
  let component: DockConsoleStackComponent;

  const entries = signal<TestEntry[]>([]);

  function seedEntries(): void {
    entries.set([
      createEntry({
        taskId: 'focus-task',
        title: 'Focus Task',
        status: 'focusing',
        load: 'high',
        expectedMinutes: 45,
        detail: 'Focus detail',
        dockedOrder: 0,
      }),
      createEntry({
        taskId: 'depth-1-task',
        title: 'Depth 1 Task',
        status: 'pending_start',
        waitMinutes: 5,
        dockedOrder: 1,
      }),
      createEntry({
        taskId: 'depth-2-task',
        title: 'Depth 2 Task',
        status: 'pending_start',
        expectedMinutes: 25,
        dockedOrder: 2,
      }),
      createEntry({
        taskId: 'depth-3-task',
        title: 'Depth 3 Task',
        status: 'pending_start',
        expectedMinutes: 10,
        dockedOrder: 3,
      }),
      createEntry({
        taskId: 'reserve-task',
        title: 'Reserve Task',
        status: 'pending_start',
        expectedMinutes: 20,
        dockedOrder: 4,
      }),
    ]);
  }

  const mockEngine = {
    consoleEntries: computed(() => entries()),
    consoleVisibleEntries: computed(() => entries().slice(0, 4)),
    focusingEntry: computed(() => entries().find(entry => entry.status === 'focusing') ?? null),
    lastRadarInsertedTaskId: signal<string | null>(null),
    pendingRadarEviction: signal<string | null>(null),
    flushRadarEviction: vi.fn((taskId: string) => {
      mockEngine.pendingRadarEviction.set(null);
      return taskId;
    }),
    completeTask: vi.fn((taskId: string) => {
      const next = entries()
        .filter(entry => entry.taskId !== taskId)
        .map((entry, index) => ({
          ...entry,
          status: (index === 0 ? 'focusing' : 'pending_start') as EntryStatus,
        }));
      entries.set(next);
    }),
    suspendTask: vi.fn((taskId: string, minutes: number) => {
      const current = entries();
      const suspended = current.find(entry => entry.taskId === taskId) ?? null;
      const remaining = current
        .filter(entry => entry.taskId !== taskId)
        .map((entry, index) => ({
          ...entry,
          status: (index === 0 ? 'focusing' : 'pending_start') as EntryStatus,
        }));
      if (suspended) {
        const visible = remaining.slice(0, 3);
        const overflow = remaining.slice(3);
        entries.set([
          ...visible,
          {
            ...suspended,
            status: 'suspended_waiting' as EntryStatus,
            waitMinutes: minutes,
          },
          ...overflow,
        ]);
      }
    }),
    switchToTask: vi.fn((taskId: string) => {
      const current = entries();
      const target = current.find(entry => entry.taskId === taskId) ?? null;
      if (!target) return;
      const others = current
        .filter(entry => entry.taskId !== taskId)
        .map(entry => ({
          ...entry,
          status: (entry.status === 'focusing' ? 'stalled' : 'pending_start') as EntryStatus,
        }));
      entries.set([
        {
          ...target,
          status: 'focusing' as EntryStatus,
          waitMinutes: null,
        },
        ...others,
      ]);
    }),
    toggleLoad: vi.fn(),
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockEngine.lastRadarInsertedTaskId.set(null);
    mockEngine.pendingRadarEviction.set(null);
    seedEntries();

    await TestBed.configureTestingModule({
      imports: [DockConsoleStackComponent],
      providers: [{ provide: DockEngineService, useValue: mockEngine }],
    })
      .overrideComponent(DockConsoleStackComponent, {
        remove: { imports: [KnowledgeAnchorComponent] },
        add: { imports: [KnowledgeAnchorStubComponent] },
      })
      .compileComponents();

    fixture = TestBed.createComponent(DockConsoleStackComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture?.destroy();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('lockInteractions 在旧 lock timer handle 为 0 时也应清理，避免上一批动画提前解锁交互', () => {
    const internals = component as unknown as {
      interactionLockTimer: ReturnType<typeof setTimeout> | null;
      lockInteractions: (durationMs: number) => void;
    };
    const zeroTimer = 0 as unknown as ReturnType<typeof setTimeout>;
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    internals.interactionLockTimer = zeroTimer;

    try {
      internals.lockInteractions(100);

      expect(clearTimeoutSpy).toHaveBeenCalledWith(zeroTimer);
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });

  it('ngOnDestroy 在 lock timer handle 为 0 时也应清理', () => {
    const internals = component as unknown as {
      interactionLockTimer: ReturnType<typeof setTimeout> | null;
    };
    const zeroTimer = 0 as unknown as ReturnType<typeof setTimeout>;
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    internals.interactionLockTimer = zeroTimer;

    try {
      component.ngOnDestroy();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(zeroTimer);
      expect(internals.interactionLockTimer).toBeNull();
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });

  it('should expose explicit load controls and completion on the focus card', () => {
    const loadControl = fixture.nativeElement.querySelector('[data-testid="dock-v3-load-control"]') as HTMLElement | null;
    expect(loadControl).toBeTruthy();
    expect(loadControl?.querySelector('[data-testid="dock-v3-load-low"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(loadControl?.querySelector('[data-testid="dock-v3-load-high"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-complete-btn"]')).toBeTruthy();
  });

  it('should expose localized wait presets and hide unsupported custom preset', () => {
    expect(component.waitPresets.map(preset => preset.label)).toEqual([
      '5 分钟',
      '15 分钟',
      '30 分钟',
      '1 小时',
      '2 小时',
      '3 小时',
      '1 天',
    ]);
    expect(component.waitPresets.some(preset => preset.minutes! < 0)).toBe(false);
  });

  it('setLoad should only toggle when target load differs', () => {
    component.setLoad('focus-task', 'high');
    expect(mockEngine.toggleLoad).not.toHaveBeenCalled();

    component.setLoad('focus-task', 'low');
    expect(mockEngine.toggleLoad).toHaveBeenCalledWith('focus-task', 'down');
  });

  it('explicit load buttons should use the focused task load operation', () => {
    const lowLoadButton = fixture.nativeElement.querySelector('[data-testid="dock-v3-load-low"]') as HTMLButtonElement | null;
    expect(lowLoadButton).toBeTruthy();

    lowLoadButton?.click();

    expect(mockEngine.toggleLoad).toHaveBeenCalledWith('focus-task', 'down');
  });

  it('should disable focused task mutations for a read-only follower', () => {
    fixture.componentRef.setInput('canMutate', false);
    fixture.detectChanges();

    expect((fixture.nativeElement.querySelector('[data-testid="dock-v3-load-low"]') as HTMLButtonElement).disabled).toBe(true);
    expect((fixture.nativeElement.querySelector('[data-testid="dock-v3-complete-btn"]') as HTMLButtonElement).disabled).toBe(true);
    expect((fixture.nativeElement.querySelector('[data-testid="dock-v3-wait-trigger"]') as HTMLButtonElement).disabled).toBe(true);
    const backgroundCards = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid="dock-v3-console-card"]'),
    ) as HTMLElement[];
    const backgroundCard = backgroundCards.find(card => card.textContent?.includes('Depth 1 Task'));
    expect(backgroundCard?.getAttribute('role')).toBeNull();

    component.setLoad('focus-task', 'low');
    component.onComplete('focus-task');
    component.onWait('focus-task', 15);
    component.toggleWaitPresets('focus-task');
    const backgroundEntry = component.stackEntries().find(entry => entry.taskId === 'depth-1-task');
    if (backgroundEntry) component.onCardClick(backgroundEntry);

    expect(mockEngine.toggleLoad).not.toHaveBeenCalled();
    expect(mockEngine.completeTask).not.toHaveBeenCalled();
    expect(mockEngine.suspendTask).not.toHaveBeenCalled();
    expect(mockEngine.switchToTask).not.toHaveBeenCalled();
    expect(component.isWaitPresetVisible('focus-task')).toBe(false);
  });

  it('wheel and swipe gestures should not mutate or complete the focused task', () => {
    const focusCard = (fixture.nativeElement.querySelector('[data-testid="dock-v3-complete-btn"]') as HTMLElement | null)
      ?.closest('[data-testid="dock-v3-console-card"]') as HTMLElement | null;
    expect(focusCard).toBeTruthy();
    if (!focusCard) return;

    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      altKey: true,
      deltaY: -120,
    });
    focusCard.dispatchEvent(wheel);

    const touchEvent = (type: string, clientY: number): Event => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: type === 'touchend' ? [] : [{ clientY }] },
        changedTouches: { value: [{ clientY }] },
      });
      return event;
    };
    focusCard.dispatchEvent(touchEvent('touchstart', 180));
    focusCard.dispatchEvent(touchEvent('touchmove', 90));
    focusCard.dispatchEvent(touchEvent('touchend', 90));

    const pointerEvent = (type: string, clientY: number): Event => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        button: { value: 0 },
        clientY: { value: clientY },
        pointerId: { value: 1 },
        isPrimary: { value: true },
      });
      return event;
    };
    focusCard.dispatchEvent(pointerEvent('pointerdown', 180));
    focusCard.dispatchEvent(pointerEvent('pointermove', 90));
    focusCard.dispatchEvent(pointerEvent('pointerup', 90));

    expect(wheel.defaultPrevented).toBe(false);
    expect(mockEngine.toggleLoad).not.toHaveBeenCalled();
    expect(mockEngine.completeTask).not.toHaveBeenCalled();
  });

  it('should expose a closable wait menu and respond to the global close event', () => {
    component.toggleWaitPresets('focus-task');
    fixture.detectChanges();

    const menu = fixture.nativeElement.querySelector('[data-testid="dock-v3-wait-menu"]') as HTMLElement | null;
    expect(menu?.classList.contains('visible')).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-wait-close"]')).toBeTruthy();

    window.dispatchEvent(new CustomEvent('dock-close-transient-surfaces'));
    fixture.detectChanges();

    expect(component.isWaitPresetVisible('focus-task')).toBe(false);
  });

  it('should derive stable card geometry from the shared pose table', () => {
    const backgroundEntry = entries()[1]!;
    const depth1Pose = resolveConsoleCardStablePoseKey(backgroundEntry as never, 1);
    const depth2Pose = resolveConsoleCardStablePoseKey(backgroundEntry as never, 2);
    const depth3Pose = resolveConsoleCardStablePoseKey(backgroundEntry as never, 3);

    expect(component.getCardOpacity(backgroundEntry as never, 1)).toBeCloseTo(toConsoleCardOpacity(depth1Pose), 3);
    expect(component.getCardTransform(backgroundEntry as never, 1)).toBe(toConsoleCardTransform(depth1Pose));
    expect(component.getCardFilter(backgroundEntry as never, 1)).toBe(toConsoleCardFilter(depth1Pose));

    expect(component.getCardOpacity(backgroundEntry as never, 2)).toBeCloseTo(toConsoleCardOpacity(depth2Pose), 3);
    expect(component.getCardTransform(backgroundEntry as never, 2)).toBe(toConsoleCardTransform(depth2Pose));
    expect(component.getCardFilter(backgroundEntry as never, 2)).toBe(toConsoleCardFilter(depth2Pose));

    expect(component.getCardOpacity(backgroundEntry as never, 3)).toBeCloseTo(toConsoleCardOpacity(depth3Pose), 3);
    expect(component.getCardTransform(backgroundEntry as never, 3)).toBe(toConsoleCardTransform(depth3Pose));
    expect(component.getCardFilter(backgroundEntry as never, 3)).toBe(toConsoleCardFilter(depth3Pose));
    expect(component.getCardZIndex(backgroundEntry as never, 1)).toBeGreaterThan(component.getCardZIndex(backgroundEntry as never, 2));
    expect(component.getCardZIndex(backgroundEntry as never, 2)).toBeGreaterThan(component.getCardZIndex(backgroundEntry as never, 3));
  });

  it('onComplete should build a batch that keeps the exiting focus card until settle', async () => {
    component.onComplete('focus-task');
    fixture.detectChanges();

    expect(mockEngine.completeTask).toHaveBeenCalledWith('focus-task');
    expect(component.renderCards().map(card => card.renderId)).toContain('focus-task::complete-1::complete-exit');
    expect(component.motionState('depth-1-task')?.fromPoseKey).toBe('depth-1');
    expect(component.motionState('depth-1-task')?.toPoseKey).toBe('focus');

    await vi.advanceTimersByTimeAsync(consoleMotion.durationMs.completeShift + 20);
    fixture.detectChanges();

    expect(component.motionState('depth-1-task')).toBeNull();
    expect(component.renderCards().map(card => card.taskId)).not.toContain('focus-task');
  });

  it('onWait should reinsert the suspended card from offstage-back after the focus card exits', async () => {
    component.onWait('focus-task', 15);
    fixture.detectChanges();

    expect(mockEngine.suspendTask).toHaveBeenCalledWith('focus-task', 15);
    expect(component.motionState('focus-task')?.fromPoseKey).toBe('offstage-back');
    expect(component.motionState('focus-task')?.toPoseKey).toBe('depth-3');
    expect(component.motionState('focus-task::suspend-1::suspend-exit')?.toPoseKey).toBe('offstage-bottom');

    await vi.advanceTimersByTimeAsync(consoleMotion.durationMs.suspendReturn + 20);
    fixture.detectChanges();

    expect(component.motionState('focus-task')).toBeNull();
    expect(entries()[3]?.status).toBe('suspended_waiting');
  });

  it('onCardClick should switch to the selected deep card and shift intermediate cards', async () => {
    component.onCardClick(entries()[2] as never);
    fixture.detectChanges();

    expect(mockEngine.switchToTask).toHaveBeenCalledWith('depth-2-task');
    expect(component.motionState('depth-2-task')?.toPoseKey).toBe('focus');
    expect(component.motionState('depth-1-task')?.fromPoseKey).toBe('depth-1');
    expect(component.motionState('depth-1-task')?.toPoseKey).toBe('depth-2');

    await vi.advanceTimersByTimeAsync(consoleMotion.durationMs.switch + 20);
    fixture.detectChanges();

    expect(component.motionState('depth-2-task')).toBeNull();
    expect(entries()[0]?.taskId).toBe('depth-2-task');
  });

  it('should animate radar promotions from the radar-entry pose and flush pending eviction after settle', async () => {
    mockEngine.pendingRadarEviction.set('depth-3-task');
    entries.set([
      createEntry({
        taskId: 'incoming-task',
        title: 'Incoming Task',
        status: 'focusing',
        expectedMinutes: 12,
        dockedOrder: 0,
      }),
      createEntry({
        taskId: 'focus-task',
        title: 'Focus Task',
        status: 'stalled',
        load: 'high',
        expectedMinutes: 45,
        detail: 'Focus detail',
        dockedOrder: 1,
      }),
      createEntry({
        taskId: 'depth-1-task',
        title: 'Depth 1 Task',
        status: 'pending_start',
        waitMinutes: 5,
        dockedOrder: 2,
      }),
      createEntry({
        taskId: 'depth-2-task',
        title: 'Depth 2 Task',
        status: 'pending_start',
        expectedMinutes: 25,
        dockedOrder: 3,
      }),
    ]);
    mockEngine.lastRadarInsertedTaskId.set('incoming-task');
    fixture.detectChanges();

    expect(component.motionState('incoming-task')?.fromPoseKey).toBe('radar-entry');
    expect(component.motionState('depth-3-task::radar-1::radar-evict')?.toPoseKey).toBe('offstage-back');

    await vi.advanceTimersByTimeAsync(consoleMotion.durationMs.radar + 20);
    fixture.detectChanges();

    expect(mockEngine.flushRadarEviction).toHaveBeenCalledWith('depth-3-task');
  });

  it('should expose background cards as keyboard-focusable switch targets', () => {
    const cards = Array.from(fixture.nativeElement.querySelectorAll('[data-testid="dock-v3-console-card"]')) as HTMLElement[];
    expect(cards).toHaveLength(4);

    const focusCard = cards[0]!;
    const backgroundCard = cards[1]!;

    expect(focusCard.getAttribute('role')).toBeNull();
    expect(backgroundCard.getAttribute('role')).toBe('button');
    expect(backgroundCard.getAttribute('tabindex')).toBe('0');
    expect(backgroundCard.getAttribute('aria-label')).toContain('切换到任务');
  });

  it('should ignore repeated card switches while the motion window is active', async () => {
    component.onCardClick(entries()[1] as never);
    component.onCardClick(entries()[2] as never);

    expect(mockEngine.switchToTask).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(consoleMotion.durationMs.switch + 60);
    component.onCardClick(entries()[1] as never);

    expect(mockEngine.switchToTask).toHaveBeenCalledTimes(2);
  });

  it('should clamp card size on narrow viewports', () => {
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    component.onViewportResize();

    expect(component.cardSize().width).toBeLessThanOrEqual(PARKING_CONFIG.CONSOLE_CARD_WIDTH);
    expect(component.cardSize().height).toBeLessThanOrEqual(PARKING_CONFIG.CONSOLE_CARD_HEIGHT);
    expect(component.cardSize().height).toBeGreaterThanOrEqual(336);

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight });
  });
});
