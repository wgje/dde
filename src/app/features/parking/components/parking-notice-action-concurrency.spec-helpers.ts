import type { ComponentFixture } from '@angular/core/testing';
import type { WritableSignal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import type {
  ParkingEvictionNotice,
  ParkingNotice,
  ParkingReminderNotice,
} from '../../../../models';
import { ParkingNoticeComponent } from '../parking-notice.component';

type MockFn = ReturnType<typeof vi.fn>;

export interface ParkingNoticeActionConcurrencySpecContext {
  fixture: ComponentFixture<ParkingNoticeComponent>;
  component: ParkingNoticeComponent;
  pendingNotices: WritableSignal<ParkingNotice[]>;
  activeReminder: WritableSignal<ParkingNotice | null>;
  mockParkingService: {
    startWork: MockFn;
    undoEviction: MockFn;
  };
  mockReminderService: {
    snooze5m: MockFn;
    snooze30m: MockFn;
  };
  createEvictionNotice: (overrides?: Partial<Omit<ParkingEvictionNotice, 'type'>>) => ParkingEvictionNotice;
  createReminderNotice: (overrides?: Partial<Omit<ParkingReminderNotice, 'type'>>) => ParkingReminderNotice;
}

export function registerParkingNoticeActionConcurrencySpecs(
  getContext: () => ParkingNoticeActionConcurrencySpecContext,
): void {
  describe('handleAction 并发守卫', () => {
    it('动作进行中时连点其他按钮不应重复触发动作', async () => {
      const { fixture, component, activeReminder, mockParkingService, mockReminderService, createReminderNotice } = getContext();

      let resolveStartWork!: (value: boolean) => void;
      mockParkingService.startWork.mockReturnValueOnce(
        new Promise<boolean>(resolve => {
          resolveStartWork = resolve;
        }),
      );
      const notice = createReminderNotice();
      activeReminder.set(notice);
      fixture.detectChanges();

      const first = component.handleAction(notice, 'start-work');
      const second = component.handleAction(notice, 'snooze-5m');

      resolveStartWork(true);
      await first;
      await second;

      expect(mockParkingService.startWork).toHaveBeenCalledTimes(1);
      expect(mockReminderService.snooze5m).not.toHaveBeenCalled();
    });

    it('外部清空当前通知为 null 后，旧动作晚到成功时不应复活旧通知', async () => {
      const { fixture, component, activeReminder, mockParkingService, createReminderNotice } = getContext();

      let resolveStartWork!: (value: boolean) => void;
      mockParkingService.startWork.mockReturnValueOnce(
        new Promise<boolean>(resolve => {
          resolveStartWork = resolve;
        }),
      );
      const notice = createReminderNotice({ id: 'reminder-a', taskId: 'task-a' });
      activeReminder.set(notice);
      fixture.detectChanges();

      const action = component.handleAction(notice, 'start-work');
      activeReminder.set(null);
      fixture.detectChanges();

      resolveStartWork(true);
      await action;

      expect(component.currentNotice()).toBeNull();
      expect(component.renderNotice()).toBeNull();
      expect(component.isExiting()).toBe(false);
    });

    it('成功的 reminder 动作若先清空当前通知，仍应保留旧通知直到退场动画结束', async () => {
      const { fixture, component, activeReminder, mockReminderService, createReminderNotice } = getContext();

      let resolveSnooze!: (value: boolean) => void;
      mockReminderService.snooze5m.mockReturnValueOnce(
        new Promise<boolean>(resolve => {
          resolveSnooze = resolve;
        }),
      );
      const notice = createReminderNotice({ id: 'reminder-a', taskId: 'task-a' });
      activeReminder.set(notice);
      fixture.detectChanges();

      const action = component.handleAction(notice, 'snooze-5m');
      activeReminder.set(null);
      fixture.detectChanges();

      expect(component.currentNotice()).toBeNull();
      expect(component.renderNotice()?.id).toBe('reminder-a');
      expect(component.isExiting()).toBe(false);

      resolveSnooze(true);
      await action;

      expect(component.renderNotice()?.id).toBe('reminder-a');
      expect(component.isExiting()).toBe(true);

      vi.advanceTimersByTime(300);
      fixture.detectChanges();

      expect(component.renderNotice()).toBeNull();
    });

    it('旧通知动作晚到成功时不应消散已经切换的新通知', async () => {
      const { fixture, component, activeReminder, mockReminderService, createReminderNotice } = getContext();

      let resolveSnooze!: (value: boolean) => void;
      mockReminderService.snooze5m.mockReturnValueOnce(
        new Promise<boolean>(resolve => {
          resolveSnooze = resolve;
        }),
      );
      const firstNotice = createReminderNotice({ id: 'reminder-a', taskId: 'task-a' });
      const nextNotice = createReminderNotice({ id: 'reminder-b', taskId: 'task-b' });
      activeReminder.set(firstNotice);
      fixture.detectChanges();

      const action = component.handleAction(firstNotice, 'snooze-5m');
      activeReminder.set(nextNotice);
      fixture.detectChanges();

      resolveSnooze(true);
      await action;

      expect(component.currentNotice()?.id).toBe('reminder-b');
      expect(component.renderNotice()?.id).toBe('reminder-b');
      expect(component.isExiting()).toBe(false);
    });

    it('旧通知动作在途时应允许新通知执行自己的动作', async () => {
      const { fixture, component, activeReminder, mockReminderService, createReminderNotice } = getContext();

      let resolveFirstAction!: (value: boolean) => void;
      mockReminderService.snooze5m.mockReturnValueOnce(
        new Promise<boolean>(resolve => {
          resolveFirstAction = resolve;
        }),
      );
      const firstNotice = createReminderNotice({ id: 'reminder-a', taskId: 'task-a' });
      const nextNotice = createReminderNotice({ id: 'reminder-b', taskId: 'task-b' });
      activeReminder.set(firstNotice);
      fixture.detectChanges();

      const firstAction = component.handleAction(firstNotice, 'snooze-5m');
      activeReminder.set(nextNotice);
      fixture.detectChanges();
      await component.handleAction(nextNotice, 'snooze-30m');

      expect(mockReminderService.snooze30m).toHaveBeenCalledWith('proj-a', 'task-b');

      resolveFirstAction(false);
      await firstAction;
    });

    it('同一按钮连点时 undoEviction 只应触发一次', async () => {
      const { fixture, component, pendingNotices, mockParkingService, createEvictionNotice } = getContext();

      let resolveUndo!: (value: boolean) => void;
      mockParkingService.undoEviction.mockReturnValueOnce(
        new Promise<boolean>(resolve => {
          resolveUndo = resolve;
        }),
      );
      const notice = createEvictionNotice();
      pendingNotices.set([notice]);
      fixture.detectChanges();

      const first = component.handleAction(notice, 'undo-eviction');
      const second = component.handleAction(notice, 'undo-eviction');

      resolveUndo(true);
      await first;
      await second;

      expect(mockParkingService.undoEviction).toHaveBeenCalledTimes(1);
    });

    it('动作完成后守卫应释放并允许下一次动作', async () => {
      const { fixture, component, activeReminder, mockReminderService, createReminderNotice } = getContext();

      const notice = createReminderNotice();
      activeReminder.set(notice);
      fixture.detectChanges();

      await component.handleAction(notice, 'snooze-5m');
      await component.handleAction(notice, 'snooze-5m');

      expect(mockReminderService.snooze5m).toHaveBeenCalledTimes(2);
    });

    it('A→B→A replacement remains rendered when the old A action settles', async () => {
      const { fixture, component, activeReminder, mockParkingService, createReminderNotice } = getContext();
      let resolveOld!: (value: boolean) => void;
      mockParkingService.startWork.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
      const oldA = createReminderNotice({ id: 'shared-notice', projectId: 'project-a', taskId: 'shared' });
      activeReminder.set(oldA);
      fixture.detectChanges();

      const pending = component.handleAction(oldA, 'start-work');
      activeReminder.set(createReminderNotice({ id: 'shared-notice', projectId: 'project-b', taskId: 'shared' }));
      fixture.detectChanges();
      const replacementA = createReminderNotice({ id: 'shared-notice', projectId: 'project-a', taskId: 'shared' });
      activeReminder.set(replacementA);
      fixture.detectChanges();
      resolveOld(true);
      await pending;

      expect(component.currentNotice()).toBe(replacementA);
      expect(component.renderNotice()).toBe(replacementA);
      expect(component.isExiting()).toBe(false);
    });
  });
}
