import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Injector } from '@angular/core';
import { EventBusService } from './event-bus.service';
import { firstValueFrom, take, toArray } from 'rxjs';

describe('EventBusService', () => {
  let service: EventBusService;

  beforeEach(() => {
    const injector = Injector.create({
      providers: [
        { provide: EventBusService, useClass: EventBusService },
      ],
    });
    service = injector.get(EventBusService);
  });

  describe('初始状态', () => {
    it('lastEvent 为 null', () => {
      expect(service.lastEvent()).toBeNull();
    });
  });

  describe('requestUndo / onUndoRequest$', () => {
    it('发布撤销事件', async () => {
      const eventPromise = firstValueFrom(service.onUndoRequest$.pipe(take(1)));
      service.requestUndo('test-source');
      const event = await eventPromise;
      expect(event.type).toBe('undo-request');
    });
  });

  describe('requestRedo / onRedoRequest$', () => {
    it('发布重做事件', async () => {
      const eventPromise = firstValueFrom(service.onRedoRequest$.pipe(take(1)));
      service.requestRedo('test-source');
      const event = await eventPromise;
      expect(event.type).toBe('redo-request');
    });
  });

  describe('publishProjectSwitch / onProjectSwitch$', () => {
    it('发布项目切换事件', async () => {
      const eventPromise = firstValueFrom(service.onProjectSwitch$.pipe(take(1)));
      service.publishProjectSwitch('proj-1', 'test');
      const event = await eventPromise;
      expect(event.type).toBe('project-switch');
      expect(event.projectId).toBe('proj-1');
    });

    it('项目 ID 为 null', async () => {
      const eventPromise = firstValueFrom(service.onProjectSwitch$.pipe(take(1)));
      service.publishProjectSwitch(null, 'test');
      const event = await eventPromise;
      expect(event.projectId).toBeNull();
    });
  });

  describe('publishSyncStatus / onSyncStatus$', () => {
    it('发布同步状态', async () => {
      const eventPromise = firstValueFrom(service.onSyncStatus$.pipe(take(1)));
      service.publishSyncStatus('synced', 'all done');
      const event = await eventPromise;
      expect(event.type).toBe('sync-status');
      expect(event.status).toBe('synced');
    });
  });

  describe('requestForceSync / onForceSyncRequest$', () => {
    it('发布强制同步请求', async () => {
      const eventPromise = firstValueFrom(service.onForceSyncRequest$.pipe(take(1)));
      service.requestForceSync('user-action');
      const event = await eventPromise;
      expect(event.type).toBe('force-sync-request');
    });
  });

  describe('publishTaskUpdate / onTaskUpdate$', () => {
    it('发布任务更新事件', async () => {
      const eventPromise = firstValueFrom(service.onTaskUpdate$.pipe(take(1)));
      service.publishTaskUpdate('task-1', 'content', 'editor');
      const event = await eventPromise;
      expect(event.type).toBe('task-update');
      expect(event.taskId).toBe('task-1');
    });
  });

  describe('publishSessionRestored / onSessionRestored$', () => {
    it('发布会话恢复事件', async () => {
      const eventPromise = firstValueFrom(service.onSessionRestored$.pipe(take(1)));
      service.publishSessionRestored('user-1', 'auth');
      const event = await eventPromise;
      expect(event.type).toBe('session-restored');
      expect(event.userId).toBe('user-1');
    });
  });

  describe('allEvents$', () => {
    it('接收所有类型的事件', async () => {
      const eventPromise = firstValueFrom(service.allEvents$.pipe(take(1)));
      service.requestUndo('test');
      const event = await eventPromise;
      expect(event).toBeDefined();
    });
  });

  describe('lastEvent signal', () => {
    it('发布事件后更新', () => {
      service.requestUndo('test');
      expect(service.lastEvent()).not.toBeNull();
    });
  });
});
