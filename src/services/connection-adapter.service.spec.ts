import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Injector } from '@angular/core';
import { ConnectionAdapterService } from './connection-adapter.service';
import { TaskOperationService } from './task-operation.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { UndoService } from './undo.service';
import { UiStateService } from './ui-state.service';
import { ProjectStateService } from './project-state.service';
import { LayoutService } from './layout.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';

const mockLoggerCategory = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
};

describe('ConnectionAdapterService', () => {
  let service: ConnectionAdapterService;
  let taskOps: any;
  let syncCoordinator: any;
  let undoService: any;
  let toastService: any;

  beforeEach(() => {
    taskOps = {
      addConnection: vi.fn(),
      removeConnection: vi.fn(),
      updateConnection: vi.fn(),
      addCrossTreeConnection: vi.fn(),
      relinkCrossTreeConnection: vi.fn(),
      updateConnectionContent: vi.fn(),
    };
    syncCoordinator = {
      scheduleSync: vi.fn(),
      core: { scheduleSync: vi.fn() },
    };
    undoService = {
      push: vi.fn(),
      pushAction: vi.fn(),
    };
    toastService = {
      show: vi.fn(),
      info: vi.fn(),
      success: vi.fn(),
      error: vi.fn(),
      warning: vi.fn(),
    };

    const injector = Injector.create({
      providers: [
        { provide: ConnectionAdapterService, useClass: ConnectionAdapterService },
        { provide: TaskOperationService, useValue: taskOps },
        { provide: SyncCoordinatorService, useValue: syncCoordinator },
        { provide: UndoService, useValue: undoService },
        { provide: UiStateService, useValue: { selectedTaskId: vi.fn(() => null), isMobile: vi.fn(() => false), markEditing: vi.fn(), clearEditing: vi.fn() } },
        { provide: ProjectStateService, useValue: { tasks: vi.fn(() => new Map()), connections: vi.fn(() => new Map()) } },
        { provide: LayoutService, useValue: {} },
        { provide: ToastService, useValue: toastService },
        { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
      ],
    });

    service = injector.get(ConnectionAdapterService);
  });

  describe('addCrossTreeConnection', () => {
    it('添加连接不出错', () => {
      expect(() => service.addCrossTreeConnection('src-1', 'tgt-1')).not.toThrow();
    });
  });

  describe('removeConnection', () => {
    it('删除连接不出错', () => {
      expect(() => service.removeConnection('src-1', 'tgt-1')).not.toThrow();
    });
  });

  describe('relinkCrossTreeConnection', () => {
    it('重新连接不出错', () => {
      expect(() => service.relinkCrossTreeConnection('old-s', 'old-t', 'new-s', 'new-t')).not.toThrow();
    });
  });

  describe('updateConnectionContent', () => {
    it('更新内容不出错', () => {
      expect(() => service.updateConnectionContent('src-1', 'tgt-1', 'New Title', 'New desc')).not.toThrow();
    });
  });
});
