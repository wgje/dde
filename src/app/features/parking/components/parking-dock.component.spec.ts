/**
 * ParkingDockComponent 组件测试
 * 覆盖 A12 验收标准 P-08/P-12/P-15/P-29/P-38 + UI 交互
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Task } from '../../../../models';
import { PARKING_CONFIG } from '../../../../config/parking.config';
import { ParkingDockComponent } from '../parking-dock.component';
import { UiStateService } from '../../../../services/ui-state.service';
import { ParkingService } from '../../../../services/parking.service';
import { SimpleReminderService } from '../../../../services/simple-reminder.service';
import { SpotlightService } from '../../../../services/spotlight.service';
import { TaskStore, ProjectStore } from '../../../core/state/stores';

describe('ParkingDockComponent', () => {
  let fixture: ComponentFixture<ParkingDockComponent>;
  let component: ParkingDockComponent;

  const parkedCount = signal(0);
  const hasUpcomingReminder = signal(false);
  const isOverSoftLimit = signal(false);
  const dockOpen = signal(false);
  const parkedTasks = signal<Task[]>([]);
  const taskMap = new Map<string, Task>();

  const createTask = (id: string, overrides: Partial<Task> = {}): Task => ({
    id,
    title: id,
    content: '',
    stage: 0,
    parentId: null,
    order: 0,
    rank: 10000,
    status: 'active',
    x: 0,
    y: 0,
    displayId: id,
    createdDate: new Date().toISOString(),
    deletedAt: null,
    parkingMeta: {
      state: 'parked',
      parkedAt: new Date().toISOString(),
      lastVisitedAt: new Date().toISOString(),
      contextSnapshot: null,
      reminder: null,
      pinned: false,
    },
    ...overrides,
  });

  const mockUiState = {
    isMobile: signal(false),
    isTextColumnCollapsed: signal(false),
    textColumnRatio: signal(50),
    isResizing: signal(false),
    isParkingDockOpen: dockOpen,
    toggleParkingDock: vi.fn(() => dockOpen.update(v => !v)),
    setParkingDockOpen: vi.fn((open: boolean) => dockOpen.set(open)),
  };

  const mockParkingService = {
    parkedCount,
    hasUpcomingReminder,
    isOverSoftLimit,
    badgedTaskIds: signal<Set<string>>(new Set()),
    quickSwitch: vi.fn(),
    previewTask: vi.fn(),
    startWork: vi.fn(),
    removeParkedTask: vi.fn(),
    togglePinned: vi.fn(),
    keepParked: vi.fn(),
    addNote: vi.fn(),
  };

  const mockReminderService = {
    setReminder: vi.fn(),
  };

  const mockSpotlightService = {
    isActive: signal(false),
  };

  const mockTaskStore = {
    parkedTasks,
    getTask: vi.fn((id: string) => taskMap.get(id)),
    setTask: vi.fn((task: Task) => taskMap.set(task.id, task)),
    getTaskProjectId: vi.fn(() => 'proj-1'),
  };

  const mockProjectStore = {
    activeProjectId: signal<string | null>('proj-1'),
    getProject: vi.fn(() => ({ id: 'proj-1', name: '测试项目' })),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    taskMap.clear();
    parkedTasks.set([]);
    parkedCount.set(0);
    hasUpcomingReminder.set(false);
    isOverSoftLimit.set(false);
    dockOpen.set(false);
    mockSpotlightService.isActive.set(false);
    mockParkingService.badgedTaskIds.set(new Set());

    await TestBed.configureTestingModule({
      imports: [ParkingDockComponent],
      providers: [
        { provide: UiStateService, useValue: mockUiState },
        { provide: ParkingService, useValue: mockParkingService },
        { provide: SimpleReminderService, useValue: mockReminderService },
        { provide: SpotlightService, useValue: mockSpotlightService },
        { provide: TaskStore, useValue: mockTaskStore },
        { provide: ProjectStore, useValue: mockProjectStore },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ParkingDockComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  // ─── 触发条显示/隐藏 ───

  it('N=0 且关闭时应隐藏触发条', () => {
    parkedCount.set(0);
    dockOpen.set(false);
    fixture.detectChanges();

    const trigger = fixture.nativeElement.querySelector('[data-testid="parking-dock-trigger"]');
    expect(trigger).toBeNull();
  });

  it('有停泊任务时应显示触发条', () => {
    const task = createTask('task-1');
    taskMap.set(task.id, task);
    parkedTasks.set([task]);
    parkedCount.set(1);
    fixture.detectChanges();

    const trigger = fixture.nativeElement.querySelector('[data-testid="parking-dock-trigger"]');
    expect(trigger).toBeTruthy();
  });

  // ─── P-38: 触发条居中于 Resizer 分隔线 ───

  describe('P-38: triggerLeftPercent', () => {
    it('triggerLeftPercent 应跟随 textColumnRatio', () => {
      mockUiState.textColumnRatio.set(60);
      mockUiState.isTextColumnCollapsed.set(false);
      expect(component.triggerLeftPercent()).toBe(60);
    });

    it('Text 列折叠时 triggerLeftPercent 应为 50', () => {
      mockUiState.isTextColumnCollapsed.set(true);
      expect(component.triggerLeftPercent()).toBe(50);
    });
  });

  // ─── 排序逻辑 ───

  it('排序应为 parkedAt 降序 + <1h 提醒临时置顶', () => {
    const now = Date.now();
    const recentNoReminder = createTask('recent', {
      parkingMeta: {
        state: 'parked',
        parkedAt: new Date(now - 5 * 60 * 1000).toISOString(),
        lastVisitedAt: new Date(now - 5 * 60 * 1000).toISOString(),
        contextSnapshot: null,
        reminder: null,
        pinned: false,
      },
    });
    const olderWithReminder = createTask('older-reminder', {
      parkingMeta: {
        state: 'parked',
        parkedAt: new Date(now - 120 * 60 * 1000).toISOString(),
        lastVisitedAt: new Date(now - 120 * 60 * 1000).toISOString(),
        contextSnapshot: null,
        reminder: {
          reminderAt: new Date(now + 20 * 60 * 1000).toISOString(),
          snoozeCount: 0,
          maxSnoozeCount: 5,
        },
        pinned: false,
      },
    });

    parkedTasks.set([recentNoReminder, olderWithReminder]);
    parkedCount.set(2);
    fixture.detectChanges();

    expect(component.sortedParkedTasks()[0].id).toBe('older-reminder');
  });

  // ─── 键盘快捷键 ───

  describe('键盘快捷键', () => {
    it('Windows/Linux 快捷键 Alt+Shift+P 应触发快速回切', () => {
      vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux');
      parkedCount.set(1);

      const event = new KeyboardEvent('keydown', {
        key: 'p',
        altKey: true,
        shiftKey: true,
      });
      component.onKeydown(event);

      expect(mockParkingService.quickSwitch).toHaveBeenCalledTimes(1);
    });

    it('Escape 应收起已展开的 Dock', () => {
      dockOpen.set(true);
      fixture.detectChanges();

      const closeSpy = vi.spyOn(component, 'closeDock');
      const event = new KeyboardEvent('keydown', { key: 'Escape' });
      component.onKeydown(event);

      expect(closeSpy).toHaveBeenCalled();
    });

    it('ArrowDown 应选中下一个任务', () => {
      const t1 = createTask('t1');
      const t2 = createTask('t2');
      parkedTasks.set([t1, t2]);
      parkedCount.set(2);
      dockOpen.set(true);
      fixture.detectChanges();

      const event = new KeyboardEvent('keydown', { key: 'ArrowDown' });
      component.onKeydown(event);

      expect(component.selectedTaskId()).toBe('t1');
    });

    it('ArrowUp 应选中上一个任务（循环到末尾）', () => {
      const t1 = createTask('t1');
      const t2 = createTask('t2');
      parkedTasks.set([t1, t2]);
      parkedCount.set(2);
      dockOpen.set(true);
      fixture.detectChanges();

      const event = new KeyboardEvent('keydown', { key: 'ArrowUp' });
      component.onKeydown(event);

      expect(component.selectedTaskId()).toBe('t2');
    });
  });

  // ─── P-29: Spotlight 阻止 startWork ───

  describe('P-29: Spotlight 激活时禁用切换', () => {
    it('Spotlight 激活时 startWork 不应调用 parkingService', () => {
      mockSpotlightService.isActive.set(true);

      component.startWork('task-1');

      expect(mockParkingService.startWork).not.toHaveBeenCalled();
    });

    it('Spotlight 激活时快速回切不应触发', () => {
      vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux');
      mockSpotlightService.isActive.set(true);
      parkedCount.set(1);

      const event = new KeyboardEvent('keydown', {
        key: 'p',
        altKey: true,
        shiftKey: true,
      });
      component.onKeydown(event);

      expect(mockParkingService.quickSwitch).not.toHaveBeenCalled();
    });
  });

  // ─── P-08: 即将清理标签（stale warning） ───

  describe('P-08: isStaleWarning', () => {
    it('超过 64h 未访问应显示即将清理标签', () => {
      const task = createTask('stale-task', {
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date(Date.now() - 70 * 60 * 60 * 1000).toISOString(),
          lastVisitedAt: new Date(Date.now() - 70 * 60 * 60 * 1000).toISOString(),
          contextSnapshot: null,
          reminder: null,
          pinned: false,
        },
      });

      expect(component.isStaleWarning(task)).toBe(true);
    });

    it('最近访问的任务不应显示即将清理标签', () => {
      const task = createTask('fresh-task', {
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: null,
          pinned: false,
        },
      });

      expect(component.isStaleWarning(task)).toBe(false);
    });

    it('P-32: pinned 任务即使超时也不应显示即将清理标签', () => {
      const task = createTask('pinned-stale', {
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date(Date.now() - 70 * 60 * 60 * 1000).toISOString(),
          lastVisitedAt: new Date(Date.now() - 70 * 60 * 60 * 1000).toISOString(),
          contextSnapshot: null,
          reminder: null,
          pinned: true,
        },
      });

      expect(component.isStaleWarning(task)).toBe(false);
    });
  });

  // ─── P-15: structuralAnchor 重复过滤 ───

  describe('P-15: getAnchorDisplay', () => {
    it('fallback 类型且 label 与标题重复时返回 null', () => {
      const task = createTask('anchor-dup', {
        title: '测试任务',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: {
            savedAt: new Date().toISOString(),
            contentHash: 'hash',
            viewMode: 'text',
            cursorPosition: null,
            scrollAnchor: null,
            structuralAnchor: { type: 'fallback', label: '测试任务' },
            flowViewport: null,
          },
          reminder: null,
          pinned: false,
        },
      });

      expect(component.getAnchorDisplay(task)).toBeNull();
    });

    it('heading 类型锚点应正常显示', () => {
      const task = createTask('anchor-ok', {
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: {
            savedAt: new Date().toISOString(),
            contentHash: 'hash',
            viewMode: 'text',
            cursorPosition: null,
            scrollAnchor: null,
            structuralAnchor: { type: 'heading', label: '第二章', line: 5 },
            flowViewport: null,
          },
          reminder: null,
          pinned: false,
        },
      });

      expect(component.getAnchorDisplay(task)).toBe('第二章');
    });

    it('无快照时应返回 null', () => {
      const task = createTask('no-snap');
      expect(component.getAnchorDisplay(task)).toBeNull();
    });
  });

  // ─── 选择与预览 ───

  describe('selectTask', () => {
    it('选中任务应调用 parkingService.previewTask', () => {
      component.selectTask('task-1');

      expect(component.selectedTaskId()).toBe('task-1');
      expect(mockParkingService.previewTask).toHaveBeenCalledWith('task-1');
    });

    it('选中新任务应关闭更多菜单', () => {
      component.showMoreMenu.set(true);
      component.selectTask('task-2');

      expect(component.showMoreMenu()).toBe(false);
    });
  });

  // ─── 移除任务 ───

  describe('removeTask', () => {
    it('移除应调用 parkingService.removeParkedTask', () => {
      component.selectedTaskId.set('task-1');

      component.removeTask('task-1');

      expect(mockParkingService.removeParkedTask).toHaveBeenCalledWith('task-1');
      expect(component.selectedTaskId()).toBeNull();
    });

    it('移除非选中任务不应清除选中状态', () => {
      component.selectedTaskId.set('task-1');

      component.removeTask('task-2');

      expect(component.selectedTaskId()).toBe('task-1');
    });
  });

  // ─── togglePinned ───

  describe('togglePinned', () => {
    it('togglePinned 应调用 parkingService 并关闭菜单', () => {
      component.showMoreMenu.set(true);

      component.togglePinned('task-1');

      expect(mockParkingService.togglePinned).toHaveBeenCalledWith('task-1');
      expect(component.showMoreMenu()).toBe(false);
    });
  });

  // ─── 备注提交 ───

  describe('submitNote', () => {
    it('有内容时应调用 addNote 并清空输入', () => {
      component.noteInput = '这是备注';

      component.submitNote('task-1');

      expect(mockParkingService.addNote).toHaveBeenCalledWith('task-1', '这是备注');
      expect(component.noteInput).toBe('');
    });

    it('空白内容不应调用 addNote', () => {
      component.noteInput = '   ';

      component.submitNote('task-1');

      expect(mockParkingService.addNote).not.toHaveBeenCalled();
    });
  });

  // ─── 红点徽章 ───

  describe('hasBadge', () => {
    it('有红点的任务应返回 true', () => {
      mockParkingService.badgedTaskIds.set(new Set(['badge-task']));

      expect(component.hasBadge('badge-task')).toBe(true);
    });

    it('无红点的任务应返回 false', () => {
      mockParkingService.badgedTaskIds.set(new Set());

      expect(component.hasBadge('no-badge')).toBe(false);
    });
  });

  // ─── 格式化辅助方法 ───

  describe('formatDuration', () => {
    it('几分钟前', () => {
      const result = component.formatDuration(new Date(Date.now() - 5 * 60_000).toISOString());
      expect(result).toContain('分钟前');
    });

    it('几小时前', () => {
      const result = component.formatDuration(new Date(Date.now() - 3 * 60 * 60_000).toISOString());
      expect(result).toContain('小时前');
    });

    it('几天前', () => {
      const result = component.formatDuration(new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString());
      expect(result).toContain('天前');
    });

    it('null 返回空字符串', () => {
      expect(component.formatDuration(null)).toBe('');
    });
  });

  describe('formatReminderCountdown', () => {
    it('即将到期时返回"即将提醒"', () => {
      const task = createTask('countdown', {
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date(Date.now() - 1000).toISOString(),
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });

      expect(component.formatReminderCountdown(task)).toBe('即将提醒');
    });

    it('30 分钟后时显示分钟倒计时', () => {
      const task = createTask('countdown-30m', {
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date(Date.now() + 30 * 60_000).toISOString(),
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });

      const result = component.formatReminderCountdown(task);
      expect(result).toContain('分钟后提醒');
    });

    it('无提醒时返回空字符串', () => {
      const task = createTask('no-reminder');
      expect(component.formatReminderCountdown(task)).toBe('');
    });
  });

  describe('getContentPreview', () => {
    it('长内容应截断到 300 字符', () => {
      const longContent = 'A'.repeat(500);
      const task = createTask('preview', { content: longContent });
      expect(component.getContentPreview(task).length).toBe(300);
    });

    it('无内容应返回"无内容"', () => {
      const task = createTask('empty', { content: '' });
      expect(component.getContentPreview(task)).toBe('无内容');
    });
  });

  describe('hasUpcomingReminderForTask', () => {
    it('有 <1h 提醒的任务返回 true', () => {
      const task = createTask('upcoming', {
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date(Date.now() + 30 * 60_000).toISOString(),
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });

      expect(component.hasUpcomingReminderForTask(task)).toBe(true);
    });

    it('>1h 提醒的任务返回 false', () => {
      const task = createTask('far-away', {
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });

      expect(component.hasUpcomingReminderForTask(task)).toBe(false);
    });
  });

  // ─── closeDock ───

  describe('closeDock', () => {
    it('移动端 closeDock 应直接清理状态', () => {
      mockUiState.isMobile.set(true);
      dockOpen.set(true);
      component.selectedTaskId.set('task-1');
      component.showMoreMenu.set(true);

      component.closeDock();

      expect(mockUiState.setParkingDockOpen).toHaveBeenCalledWith(false);
      expect(component.selectedTaskId()).toBeNull();
    });

    it('桌面端 closeDock 应先播放关闭动画', () => {
      mockUiState.isMobile.set(false);
      dockOpen.set(true);

      component.closeDock();

      // 桌面端先设置 isPanelClosing，延迟 200ms 后关闭
      expect(component.isPanelClosing()).toBe(true);
    });
  });

  // ─── 移动端 Bottom Sheet 手势 ───

  describe('移动端 Bottom Sheet 手势', () => {
    it('下拉超过阈值应触发收起', () => {
      const closeSpy = vi.spyOn(component, 'closeDock');
      component.onSheetTouchStart({ touches: [{ clientY: 0 }] } as unknown as TouchEvent);
      component.onSheetTouchMove({
        touches: [{ clientY: PARKING_CONFIG.DOCK_MOBILE_DISMISS_THRESHOLD + 1 }],
      } as unknown as TouchEvent);
      component.onSheetTouchEnd();

      expect(closeSpy).toHaveBeenCalled();
    });

    it('下拉未超过阈值不应收起', () => {
      const closeSpy = vi.spyOn(component, 'closeDock');
      component.onSheetTouchStart({ touches: [{ clientY: 0 }] } as unknown as TouchEvent);
      component.onSheetTouchMove({
        touches: [{ clientY: PARKING_CONFIG.DOCK_MOBILE_DISMISS_THRESHOLD - 1 }],
      } as unknown as TouchEvent);
      component.onSheetTouchEnd();

      expect(closeSpy).not.toHaveBeenCalled();
    });
  });

  // ─── keepParked ───

  describe('keepParked', () => {
    it('应委托给 parkingService.keepParked', () => {
      component.keepParked('task-1');
      expect(mockParkingService.keepParked).toHaveBeenCalledWith('task-1');
    });
  });

  // ─── setReminderPreset ───

  describe('setReminderPreset', () => {
    it('应按预设计算 reminderAt 并调用 setReminder', () => {
      component.setReminderPreset('task-1', 'QUICK');

      expect(mockReminderService.setReminder).toHaveBeenCalled();
      const [taskId, reminderAt] = mockReminderService.setReminder.mock.calls[0];
      expect(taskId).toBe('task-1');
      const reminderTime = new Date(reminderAt).getTime();
      const expectedTime = Date.now() + PARKING_CONFIG.SNOOZE_PRESETS.QUICK;
      expect(Math.abs(reminderTime - expectedTime)).toBeLessThan(1000);
    });

    it('设置提醒后应关闭子菜单和更多菜单', () => {
      component.showReminderPresetsMenu.set(true);
      component.showMoreMenu.set(true);

      component.setReminderPreset('task-1', 'NORMAL');

      expect(component.showReminderPresetsMenu()).toBe(false);
      expect(component.showMoreMenu()).toBe(false);
    });
  });

  // ─── P-21: 软上限警告 ───

  describe('P-21: 软上限警告', () => {
    it('isOverSoftLimit 为 true 时组件应反映', () => {
      isOverSoftLimit.set(true);
      expect(component.isOverSoftLimit()).toBe(true);
    });
  });

  // ─── 提醒标签文案 ───

  describe('reminderLabel', () => {
    it('有即将到期提醒时应显示文案', () => {
      hasUpcomingReminder.set(true);
      expect(component.reminderLabel()).toBeTruthy();
    });

    it('无即将到期提醒时应为空', () => {
      hasUpcomingReminder.set(false);
      expect(component.reminderLabel()).toBe('');
    });
  });
});
