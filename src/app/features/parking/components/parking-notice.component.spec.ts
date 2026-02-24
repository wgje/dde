/**
 * ParkingNoticeComponent 组件测试
 * 覆盖 A12 验收标准 P-05b/P-06/P-13/P-26 + 三阶段消散 + 动作委托
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ParkingNotice, ParkingNoticeActionKey } from '../../../../models';
import { ParkingNoticeComponent } from '../parking-notice.component';
import { ParkingService } from '../../../../services/parking.service';
import { SimpleReminderService } from '../../../../services/simple-reminder.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { GateService } from '../../../../services/gate.service';

describe('ParkingNoticeComponent', () => {
  let fixture: ComponentFixture<ParkingNoticeComponent>;
  let component: ParkingNoticeComponent;

  const pendingNotices = signal<ParkingNotice[]>([]);
  const activeReminder = signal<ParkingNotice | null>(null);
  const gateActive = signal(false);
  const isMobile = signal(false);

  const mockParkingService = {
    pendingNotices,
    startWork: vi.fn(),
    undoEviction: vi.fn(),
    keepParked: vi.fn(),
    consumeNotice: vi.fn(),
    getEvictionToken: vi.fn((tokenId: string) => ({ tokenId })),
  };

  const mockReminderService = {
    activeNotice: activeReminder,
    snooze5m: vi.fn(),
    snooze30m: vi.fn(),
    snooze2h: vi.fn(),
    cancelReminder: vi.fn(),
    handleNoticeFadeout: vi.fn(),
  };

  const mockUiState = {
    isMobile,
  };

  const mockGateService = {
    isActive: gateActive,
  };

  const createEvictionNotice = (overrides: Partial<ParkingNotice> = {}): ParkingNotice => ({
    id: 'eviction-1',
    type: 'eviction',
    taskId: 'task-1',
    taskTitle: '任务 1',
    minVisibleMs: 10,
    fallbackTimeoutMs: 1000,
    evictionTokenId: 'token-1',
    actions: [
      { key: 'undo-eviction', label: '撤回' },
      { key: 'keep-parked', label: '关闭' },
    ],
    ...overrides,
  });

  const createReminderNotice = (overrides: Partial<ParkingNotice> = {}): ParkingNotice => ({
    id: 'reminder-1',
    type: 'reminder',
    taskId: 'task-r',
    taskTitle: '提醒任务',
    minVisibleMs: 10,
    fallbackTimeoutMs: 200,
    actions: [
      { key: 'start-work', label: '切换到此任务' },
      { key: 'snooze-5m', label: '5 分钟后' },
      { key: 'snooze-30m', label: '30 分钟后' },
      { key: 'snooze-2h-later', label: '2 小时后' },
      { key: 'ignore', label: '忽略' },
    ],
    ...overrides,
  });

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    pendingNotices.set([]);
    activeReminder.set(null);
    gateActive.set(false);
    isMobile.set(false);

    await TestBed.configureTestingModule({
      imports: [ParkingNoticeComponent],
      providers: [
        { provide: ParkingService, useValue: mockParkingService },
        { provide: SimpleReminderService, useValue: mockReminderService },
        { provide: UiStateService, useValue: mockUiState },
        { provide: GateService, useValue: mockGateService },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ParkingNoticeComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    vi.useRealTimers();
    fixture.destroy();
    TestBed.resetTestingModule();
  });

  // ─── P-26: Gate 优先级队列 ───

  describe('P-26: Gate 激活时延迟展示', () => {
    it('Gate 激活时应延迟展示 eviction notice，Gate 关闭后显示', () => {
      pendingNotices.set([createEvictionNotice()]);
      gateActive.set(true);
      fixture.detectChanges();

      expect(component.currentNotice()).toBeNull();

      gateActive.set(false);
      fixture.detectChanges();
      expect(component.currentNotice()?.id).toBe('eviction-1');
    });

    it('Gate 激活时 reminder 应正常显示（不被延迟）', () => {
      activeReminder.set(createReminderNotice());
      gateActive.set(true);
      fixture.detectChanges();

      expect(component.currentNotice()?.type).toBe('reminder');
    });
  });

  // ─── currentNotice 优先级 ───

  describe('currentNotice 优先级', () => {
    it('reminder 优先于 eviction', () => {
      pendingNotices.set([createEvictionNotice()]);
      activeReminder.set(createReminderNotice());
      fixture.detectChanges();

      expect(component.currentNotice()?.type).toBe('reminder');
    });

    it('无通知时为 null', () => {
      fixture.detectChanges();
      expect(component.currentNotice()).toBeNull();
    });
  });

  // ─── 动作委托 ───

  describe('handleAction 动作委托', () => {
    it('undo-eviction 应调用 undoEviction 并消费通知', () => {
      const notice = createEvictionNotice();
      pendingNotices.set([notice]);
      fixture.detectChanges();

      component.handleAction(notice, 'undo-eviction');
      expect(mockParkingService.undoEviction).toHaveBeenCalledWith('token-1');

      vi.advanceTimersByTime(350);
      expect(mockParkingService.consumeNotice).toHaveBeenCalledWith('eviction-1');
    });

    it('start-work 应调用 parkingService.startWork', () => {
      const notice = createReminderNotice();
      activeReminder.set(notice);
      fixture.detectChanges();

      component.handleAction(notice, 'start-work');
      expect(mockParkingService.startWork).toHaveBeenCalledWith('task-r');
    });

    it('snooze-5m 应调用 reminderService.snooze5m', () => {
      const notice = createReminderNotice();
      activeReminder.set(notice);
      fixture.detectChanges();

      component.handleAction(notice, 'snooze-5m');
      expect(mockReminderService.snooze5m).toHaveBeenCalledWith('task-r');
    });

    it('snooze-30m 应调用 reminderService.snooze30m', () => {
      const notice = createReminderNotice();
      activeReminder.set(notice);
      fixture.detectChanges();

      component.handleAction(notice, 'snooze-30m');
      expect(mockReminderService.snooze30m).toHaveBeenCalledWith('task-r');
    });

    it('snooze-2h-later 应调用 reminderService.snooze2h', () => {
      const notice = createReminderNotice();
      activeReminder.set(notice);
      fixture.detectChanges();

      component.handleAction(notice, 'snooze-2h-later');
      expect(mockReminderService.snooze2h).toHaveBeenCalledWith('task-r');
    });

    it('ignore 应调用 reminderService.cancelReminder', () => {
      const notice = createReminderNotice();
      activeReminder.set(notice);
      fixture.detectChanges();

      component.handleAction(notice, 'ignore');
      expect(mockReminderService.cancelReminder).toHaveBeenCalledWith('task-r');
    });

    it('keep-parked 应调用 parkingService.keepParked', () => {
      const notice = createEvictionNotice({
        actions: [{ key: 'keep-parked', label: '关闭' }],
      });
      pendingNotices.set([notice]);
      fixture.detectChanges();

      component.handleAction(notice, 'keep-parked');
      expect(mockParkingService.keepParked).toHaveBeenCalledWith('task-1');
    });

    it('keep-parked 批量应对每个 evictionItem 调用 keepParked', () => {
      const notice = createEvictionNotice({
        evictionItems: [
          { taskId: 'task-a', taskTitle: 'A', evictionTokenId: 'token-a' },
          { taskId: 'task-b', taskTitle: 'B', evictionTokenId: 'token-b' },
        ],
        actions: [{ key: 'keep-parked', label: '关闭' }],
      });
      pendingNotices.set([notice]);
      fixture.detectChanges();

      component.handleAction(notice, 'keep-parked');
      expect(mockParkingService.keepParked).toHaveBeenCalledWith('task-a');
      expect(mockParkingService.keepParked).toHaveBeenCalledWith('task-b');
    });
  });

  // ─── reminder 兜底消散 ───

  describe('reminder 兜底消散', () => {
    it('reminder 兜底消散应调用 handleNoticeFadeout', () => {
      activeReminder.set(createReminderNotice({
        minVisibleMs: 10,
        fallbackTimeoutMs: 20,
      }));
      fixture.detectChanges();

      vi.advanceTimersByTime(400);
      expect(mockReminderService.handleNoticeFadeout).toHaveBeenCalledWith('task-r');
    });
  });

  // ─── 批量逐条撤回 ───

  describe('批量逐条撤回', () => {
    it('应按 token 调用 undo', () => {
      const notice = createEvictionNotice({
        id: 'batch-1',
        taskTitle: '2 个停泊任务已移回任务列表',
        taskId: 'task-a',
        evictionTokenId: null,
        evictionItems: [
          { taskId: 'task-a', taskTitle: 'A', evictionTokenId: 'token-a' },
          { taskId: 'task-b', taskTitle: 'B', evictionTokenId: 'token-b' },
        ],
        actions: [{ key: 'keep-parked', label: '关闭' }],
      });
      pendingNotices.set([notice]);
      fixture.detectChanges();

      component.undoEvictionItem(
        notice,
        notice.evictionItems![0],
        { stopPropagation: vi.fn() } as unknown as Event
      );

      expect(mockParkingService.undoEviction).toHaveBeenCalledWith('token-a');
      expect(mockParkingService.consumeNotice).not.toHaveBeenCalled();
    });

    it('所有 item 都撤回后应自动消散通知', () => {
      // 只有一个 item 的批量通知
      const notice = createEvictionNotice({
        id: 'auto-dismiss',
        evictionTokenId: null,
        evictionItems: [
          { taskId: 'task-solo', taskTitle: 'Solo', evictionTokenId: 'token-solo' },
        ],
        actions: [{ key: 'keep-parked', label: '关闭' }],
      });
      pendingNotices.set([notice]);
      fixture.detectChanges();

      // 撤回后 visibleEvictionItems 应为空 → 触发 dismissNotice
      // getEvictionToken 返回 null 意味着 token 已消费
      mockParkingService.getEvictionToken.mockReturnValueOnce({ tokenId: 'token-solo' });
      mockParkingService.getEvictionToken.mockReturnValue(null);

      component.undoEvictionItem(
        notice,
        notice.evictionItems![0],
        { stopPropagation: vi.fn() } as unknown as Event
      );

      // 应该触发 dismissNotice (isExiting)
      expect(component.isExiting()).toBe(true);
    });

    it('toggleEvictionExpanded 应切换展开状态', () => {
      expect(component.evictionExpanded()).toBe(false);

      component.toggleEvictionExpanded();
      expect(component.evictionExpanded()).toBe(true);

      component.toggleEvictionExpanded();
      expect(component.evictionExpanded()).toBe(false);
    });
  });

  // ─── visibleEvictionItems ───

  describe('visibleEvictionItems', () => {
    it('应过滤已撤回的 token', () => {
      const notice = createEvictionNotice({
        evictionItems: [
          { taskId: 'task-a', taskTitle: 'A', evictionTokenId: 'token-a' },
          { taskId: 'task-b', taskTitle: 'B', evictionTokenId: 'token-b' },
        ],
      });

      // 确保 mock 对 token-b 返回有效值
      mockParkingService.getEvictionToken.mockImplementation(
        (tokenId: string) => ({ tokenId })
      );
      component.dismissedEvictionTokenIds.set(new Set(['token-a']));

      const visible = component.visibleEvictionItems(notice);
      expect(visible.length).toBe(1);
      expect(visible[0].taskId).toBe('task-b');
    });

    it('应过滤 token 已过期的 item', () => {
      const notice = createEvictionNotice({
        evictionItems: [
          { taskId: 'task-x', taskTitle: 'X', evictionTokenId: 'token-x' },
        ],
      });

      mockParkingService.getEvictionToken.mockReturnValue(null);

      const visible = component.visibleEvictionItems(notice);
      expect(visible.length).toBe(0);
    });
  });

  // ─── isEvictionTokenActive ───

  describe('isEvictionTokenActive', () => {
    it('token 存在时返回 true', () => {
      mockParkingService.getEvictionToken.mockReturnValue({ tokenId: 'active-token' });
      expect(component.isEvictionTokenActive('active-token')).toBe(true);
    });

    it('token 不存在时返回 false', () => {
      mockParkingService.getEvictionToken.mockReturnValue(null);
      expect(component.isEvictionTokenActive('expired-token')).toBe(false);
    });
  });

  // ─── 移动端操作按钮过滤 ───

  describe('移动端操作按钮过滤', () => {
    it('桌面端应显示所有操作', () => {
      isMobile.set(false);
      const notice = createReminderNotice();

      const visible = component.visibleActions(notice);
      expect(visible.length).toBe(5);
    });

    it('移动端应只显示主要操作', () => {
      isMobile.set(true);
      const notice = createReminderNotice();

      const visible = component.visibleActions(notice);
      const keys = visible.map(a => a.key);
      expect(keys).toContain('start-work');
      expect(keys).toContain('snooze-5m');
      expect(keys).toContain('ignore');
      // snooze-30m 和 snooze-2h-later 应被隐藏
      expect(keys).not.toContain('snooze-30m');
      expect(keys).not.toContain('snooze-2h-later');
    });

    it('移动端展开后应显示所有操作', () => {
      isMobile.set(true);
      component.mobileExpanded.set(true);
      const notice = createReminderNotice();

      const visible = component.visibleActions(notice);
      expect(visible.length).toBe(5);
    });

    it('hasCollapsedActions 应检测隐藏按钮', () => {
      isMobile.set(true);
      const notice = createReminderNotice();

      expect(component.hasCollapsedActions(notice)).toBe(true);
    });

    it('桌面端 hasCollapsedActions 应为 false', () => {
      isMobile.set(false);
      const notice = createReminderNotice();

      expect(component.hasCollapsedActions(notice)).toBe(false);
    });
  });

  // ─── snooze 弱化提示 ───

  describe('showSnoozeGuidance / isSnoozeWeakened', () => {
    it('ignore label 包含"已延后"时 showSnoozeGuidance 为 true', () => {
      activeReminder.set(createReminderNotice({
        actions: [
          { key: 'start-work', label: '切换到此任务' },
          { key: 'snooze-5m', label: '5 分钟后' },
          { key: 'ignore', label: '忽略（已延后 5 次）' },
        ],
      }));
      fixture.detectChanges();

      expect(component.showSnoozeGuidance()).toBe(true);
    });

    it('snooze 按钮在 guidance 模式下应弱化', () => {
      activeReminder.set(createReminderNotice({
        actions: [
          { key: 'snooze-5m', label: '5 分钟后' },
          { key: 'ignore', label: '忽略（已延后 5 次）' },
        ],
      }));
      fixture.detectChanges();

      expect(component.isSnoozeWeakened('snooze-5m')).toBe(true);
      expect(component.isSnoozeWeakened('start-work')).toBe(false);
    });

    it('无"已延后"时 snooze 不应弱化', () => {
      activeReminder.set(createReminderNotice());
      fixture.detectChanges();

      expect(component.isSnoozeWeakened('snooze-5m')).toBe(false);
    });
  });

  // ─── DOM 渲染 ───

  describe('DOM 渲染', () => {
    it('无通知时不应渲染 notice 容器', () => {
      fixture.detectChanges();

      const el = fixture.nativeElement.querySelector('[data-testid="parking-notice"]');
      expect(el).toBeNull();
    });

    it('有通知时应渲染 notice 容器', () => {
      pendingNotices.set([createEvictionNotice()]);
      fixture.detectChanges();

      const el = fixture.nativeElement.querySelector('[data-testid="parking-notice"]');
      expect(el).toBeTruthy();
    });

    it('通知容器应包含 role=alert 和 aria-live=assertive', () => {
      pendingNotices.set([createEvictionNotice()]);
      fixture.detectChanges();

      const el = fixture.nativeElement.querySelector('[data-testid="parking-notice"]');
      expect(el?.getAttribute('role')).toBe('alert');
      expect(el?.getAttribute('aria-live')).toBe('assertive');
    });
  });
});
