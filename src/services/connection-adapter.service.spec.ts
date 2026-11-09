import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Injector } from '@angular/core';
import { ConnectionAdapterService } from './connection-adapter.service';
import { TaskOperationService } from './task-operation.service';
import { UiStateService } from './ui-state.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { UserSessionService } from './user-session.service';
import { TaskRecordTrackingService } from './task-record-tracking.service';

const mockLoggerCategory = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
};

describe('ConnectionAdapterService', () => {
  let service: ConnectionAdapterService;
  let taskOps: {
    addConnection: ReturnType<typeof vi.fn>;
    removeConnection: ReturnType<typeof vi.fn>;
    updateConnection: ReturnType<typeof vi.fn>;
    addCrossTreeConnection: ReturnType<typeof vi.fn>;
    addCrossTreeConnectionDurably: ReturnType<typeof vi.fn>;
    relinkCrossTreeConnection: ReturnType<typeof vi.fn>;
    relinkCrossTreeConnectionDurably: ReturnType<typeof vi.fn>;
    updateConnectionContent: ReturnType<typeof vi.fn>;
    updateConnectionContentDurably: ReturnType<typeof vi.fn>;
    removeConnectionDurably: ReturnType<typeof vi.fn>;
  };
  let uiState: {
    selectedTaskId: ReturnType<typeof vi.fn>;
    isMobile: ReturnType<typeof vi.fn>;
    markEditing: ReturnType<typeof vi.fn>;
    clearEditing: ReturnType<typeof vi.fn>;
  };
  let recorder: { performUndo: ReturnType<typeof vi.fn> };
  let toastService: {
    show: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    success: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    warning: ReturnType<typeof vi.fn>;
  };
  let userSession: { isHintOnlyStartupPlaceholderVisible: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    taskOps = {
      addConnection: vi.fn(),
      removeConnection: vi.fn(),
      updateConnection: vi.fn(),
      addCrossTreeConnection: vi.fn(),
      addCrossTreeConnectionDurably: vi.fn().mockResolvedValue(true),
      relinkCrossTreeConnection: vi.fn(),
      relinkCrossTreeConnectionDurably: vi.fn().mockResolvedValue(true),
      updateConnectionContent: vi.fn(),
      updateConnectionContentDurably: vi.fn().mockResolvedValue(true),
      removeConnectionDurably: vi.fn().mockResolvedValue(true),
    };
    uiState = {
      selectedTaskId: vi.fn(() => null),
      isMobile: vi.fn(() => false),
      markEditing: vi.fn(),
      clearEditing: vi.fn(),
    };
    recorder = {
      performUndo: vi.fn().mockResolvedValue(true),
    };
    toastService = {
      show: vi.fn(),
      info: vi.fn(),
      success: vi.fn(),
      error: vi.fn(),
      warning: vi.fn(),
    };
    userSession = {
      isHintOnlyStartupPlaceholderVisible: vi.fn(() => false),
    };

    const injector = Injector.create({
      providers: [
        { provide: ConnectionAdapterService, useClass: ConnectionAdapterService },
        { provide: TaskOperationService, useValue: taskOps },
        { provide: UiStateService, useValue: uiState },
        { provide: ToastService, useValue: toastService },
        { provide: UserSessionService, useValue: userSession },
        { provide: TaskRecordTrackingService, useValue: recorder },
        { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
      ],
    });

    service = injector.get(ConnectionAdapterService);
  });

  describe('addCrossTreeConnection', () => {
    it('添加连接成功后才显示成功提示', async () => {
      await expect(service.addCrossTreeConnection('src-1', 'tgt-1')).resolves.toBe(true);

      expect(taskOps.addCrossTreeConnectionDurably).toHaveBeenCalledWith('src-1', 'tgt-1');
      expect(taskOps.addCrossTreeConnection).not.toHaveBeenCalled();
      expect(toastService.success).toHaveBeenCalledWith('已添加关联', undefined, { duration: 3000 });
    });

    it('移动端撤销按钮应通过统一记录服务执行 durable-first 撤销', async () => {
      uiState.isMobile.mockReturnValue(true);

      await expect(service.addCrossTreeConnection('src-1', 'tgt-1')).resolves.toBe(true);

      const action = toastService.success.mock.calls[0][2]?.action;
      expect(action).toEqual(expect.objectContaining({
        label: '撤销',
        pendingLabel: '撤销中...',
      }));

      await action.onClick();

      expect(recorder.performUndo).toHaveBeenCalledOnce();
    });

    it('添加连接本地持久化失败时不显示成功提示', async () => {
      taskOps.addCrossTreeConnectionDurably.mockResolvedValueOnce(false);

      await expect(service.addCrossTreeConnection('src-1', 'tgt-1')).resolves.toBe(false);

      expect(toastService.success).not.toHaveBeenCalled();
      expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
        '添加连接本地持久化失败，未显示成功反馈',
        { sourceId: 'src-1', targetId: 'tgt-1' },
      );
    });

    it('hint-only 时应阻止添加连接', async () => {
      userSession.isHintOnlyStartupPlaceholderVisible.mockReturnValue(true);

      await expect(service.addCrossTreeConnection('src-1', 'tgt-1')).resolves.toBe(false);

      expect(taskOps.addCrossTreeConnection).not.toHaveBeenCalled();
      expect(taskOps.addCrossTreeConnectionDurably).not.toHaveBeenCalled();
      expect(toastService.info).toHaveBeenCalledWith('会话确认中', '编辑关联暂不可用，owner 确认完成前保持只读');
    });
  });

  describe('removeConnection', () => {
    it('删除连接成功后才显示成功提示', async () => {
      await expect(service.removeConnection('src-1', 'tgt-1')).resolves.toBe(true);

      expect(taskOps.removeConnectionDurably).toHaveBeenCalledWith('src-1', 'tgt-1');
      expect(taskOps.removeConnection).not.toHaveBeenCalled();
      expect(toastService.success).toHaveBeenCalledWith('已删除关联', undefined, { duration: 3000 });
    });

    it('删除连接本地持久化失败时不显示成功提示', async () => {
      taskOps.removeConnectionDurably.mockResolvedValueOnce(false);

      await expect(service.removeConnection('src-1', 'tgt-1')).resolves.toBe(false);

      expect(toastService.success).not.toHaveBeenCalled();
    });
  });

  describe('relinkCrossTreeConnection', () => {
    it('重新连接成功后才显示成功提示', async () => {
      await expect(service.relinkCrossTreeConnection('old-s', 'old-t', 'new-s', 'new-t')).resolves.toBe(true);

      expect(taskOps.relinkCrossTreeConnectionDurably).toHaveBeenCalledWith('old-s', 'old-t', 'new-s', 'new-t');
      expect(taskOps.relinkCrossTreeConnection).not.toHaveBeenCalled();
      expect(toastService.success).toHaveBeenCalledWith('已重连关联', undefined, { duration: 3000 });
    });

    it('重新连接本地持久化失败时不显示成功提示', async () => {
      taskOps.relinkCrossTreeConnectionDurably.mockResolvedValueOnce(false);

      await expect(service.relinkCrossTreeConnection('old-s', 'old-t', 'new-s', 'new-t')).resolves.toBe(false);

      expect(toastService.success).not.toHaveBeenCalled();
    });
  });

  describe('updateConnectionContent', () => {
    it('更新内容成功时才标记编辑态', async () => {
      await expect(service.updateConnectionContent('src-1', 'tgt-1', 'New Title', 'New desc')).resolves.toBe(true);

      expect(taskOps.updateConnectionContentDurably).toHaveBeenCalledWith('src-1', 'tgt-1', 'New Title', 'New desc');
      expect(taskOps.updateConnectionContent).not.toHaveBeenCalled();
      expect(uiState.markEditing).toHaveBeenCalled();
    });

    it('更新内容本地持久化失败时不标记编辑态', async () => {
      taskOps.updateConnectionContentDurably.mockResolvedValueOnce(false);

      await expect(service.updateConnectionContent('src-1', 'tgt-1', 'New Title', 'New desc')).resolves.toBe(false);

      expect(uiState.markEditing).not.toHaveBeenCalled();
    });

    it('hint-only 时应阻止更新关联内容', async () => {
      userSession.isHintOnlyStartupPlaceholderVisible.mockReturnValue(true);

      await expect(service.updateConnectionContent('src-1', 'tgt-1', 'New Title', 'New desc')).resolves.toBe(false);

      expect(taskOps.updateConnectionContent).not.toHaveBeenCalled();
      expect(taskOps.updateConnectionContentDurably).not.toHaveBeenCalled();
      expect(toastService.info).toHaveBeenCalledWith('会话确认中', '编辑关联暂不可用，owner 确认完成前保持只读');
    });
  });
});
