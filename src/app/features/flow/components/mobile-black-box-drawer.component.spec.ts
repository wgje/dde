import { Injector, runInInjectionContext, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { MobileBlackBoxDrawerComponent } from './mobile-black-box-drawer.component';
import { BlackBoxService } from '../../../../services/black-box.service';
import { SpeechToTextService } from '../../../../services/speech-to-text.service';
import { FocusPreferenceService } from '../../../../services/focus-preference.service';
import { ToastService } from '../../../../services/toast.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';

describe('MobileBlackBoxDrawerComponent', () => {
  function createComponent(blackBoxOverrides: Record<string, unknown> = {}) {
    const blackBoxService = {
      entriesByDate: signal([]),
      pendingCount: signal(0),
      refreshForView: vi.fn().mockResolvedValue(undefined),
      loadFromServer: vi.fn(),
      create: vi.fn(),
      createDurably: vi.fn().mockResolvedValue({ ok: true, value: {} }),
      update: vi.fn(),
      updateDurably: vi.fn().mockResolvedValue({ ok: true, value: {} }),
      markAsRead: vi.fn(),
      markAsReadDurably: vi.fn().mockResolvedValue({ ok: true, value: {} }),
      markAsCompleted: vi.fn(),
      markAsCompletedDurably: vi.fn().mockResolvedValue({ ok: true, value: {} }),
      delete: vi.fn(),
      deleteDurably: vi.fn().mockResolvedValue({ ok: true, value: {} }),
      ...blackBoxOverrides,
    };
    const toast = {
      warning: vi.fn(),
    };
    const taskOpsAdapter = {
      updateTaskStatus: vi.fn().mockResolvedValue(true),
    };

    const injector = Injector.create({
      providers: [
        { provide: BlackBoxService, useValue: blackBoxService },
        { provide: SpeechToTextService, useValue: {} },
        { provide: FocusPreferenceService, useValue: {} },
        { provide: ToastService, useValue: toast },
        { provide: TaskOperationAdapterService, useValue: taskOpsAdapter },
      ],
    });

    const component = runInInjectionContext(injector, () => new MobileBlackBoxDrawerComponent());
    return { component, blackBoxService, toast, taskOpsAdapter };
  }

  it('ngOnInit 应只补本地快照，不触发远端拉取', async () => {
    const { component, blackBoxService } = createComponent();

    component.ngOnInit();
    await Promise.resolve();

    expect(blackBoxService.refreshForView).toHaveBeenCalledTimes(1);
    expect(blackBoxService.loadFromServer).not.toHaveBeenCalled();

    // 清理 visibilitychange 监听器
    component.ngOnDestroy();
  });

  it('visibilitychange → visible 时应触发 refreshForView', async () => {
    const { component, blackBoxService } = createComponent();
    component.ngOnInit();
    blackBoxService.refreshForView.mockClear();

    // 模拟 visibility 变为 visible
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(blackBoxService.refreshForView).toHaveBeenCalledTimes(1);

    component.ngOnDestroy();
  });

  it('visibilitychange 监听注册失败时不应阻塞后续重试', () => {
    const setupError = new Error('visibility setup failed');
    const originalAdd = document.addEventListener.bind(document);
    let addRestored = false;
    const addDocumentListener = vi
      .spyOn(document, 'addEventListener')
      .mockImplementation((...args: Parameters<typeof document.addEventListener>) => {
        if (args[0] === 'visibilitychange') {
          throw setupError;
        }
        return originalAdd(...args);
      });
    const { component, blackBoxService } = createComponent();

    try {
      expect(() => component.ngOnInit()).not.toThrow();

      addDocumentListener.mockRestore();
      addRestored = true;
      component.ngOnInit();
      blackBoxService.refreshForView.mockClear();

      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(blackBoxService.refreshForView).toHaveBeenCalledTimes(1);
    } finally {
      if (!addRestored) {
        addDocumentListener.mockRestore();
      }
      component.ngOnDestroy();
    }
  });

  it('销毁时 visibilitychange 解绑失败不应抛错且应清空 handler', () => {
    const { component } = createComponent();
    component.ngOnInit();
    const registeredHandler = (component as unknown as { visibilityHandler: EventListener | null }).visibilityHandler;
    const removeError = new Error('visibility cleanup failed');
    const removeDocumentListener = vi
      .spyOn(document, 'removeEventListener')
      .mockImplementationOnce(() => {
        throw removeError;
      });

    try {
      expect(() => component.ngOnDestroy()).not.toThrow();
      expect((component as unknown as { visibilityHandler: unknown }).visibilityHandler).toBeNull();
    } finally {
      removeDocumentListener.mockRestore();
      if (registeredHandler) {
        document.removeEventListener('visibilitychange', registeredHandler);
      }
    }
  });

  it('onTranscribed 应通过 durable API 写入', async () => {
    const { component, blackBoxService } = createComponent();

    await component.onTranscribed('  移动端条目  ');

    expect(blackBoxService.createDurably).toHaveBeenCalledWith({ content: '移动端条目' });
    expect(blackBoxService.create).not.toHaveBeenCalled();
  });

  it('onMarkCompleted 应使用 durable 完成 API', async () => {
    const { component, blackBoxService } = createComponent();

    await component.onMarkCompleted('entry-1');

    expect(blackBoxService.markAsCompletedDurably).toHaveBeenCalledWith('entry-1');
    expect(blackBoxService.markAsCompleted).not.toHaveBeenCalled();
  });

  it('onConfirmDelete 应使用 durable 删除 API', async () => {
    const { component, blackBoxService } = createComponent();

    await component.onConfirmDelete('entry-1');

    expect(blackBoxService.deleteDurably).toHaveBeenCalledWith('entry-1');
    expect(blackBoxService.delete).not.toHaveBeenCalled();
  });

  it('onRestoreFromHistory 应通过 durable 更新恢复 black-box 条目', async () => {
    const { component, blackBoxService } = createComponent();

    await component.onRestoreFromHistory({ type: 'black_box', id: 'entry-1' });

    expect(blackBoxService.updateDurably).toHaveBeenCalledWith('entry-1', { isCompleted: false });
    expect(blackBoxService.update).not.toHaveBeenCalled();
  });

  it('onRestoreFromHistory 应等待 durable 状态写入恢复 task 条目', async () => {
    const { component, taskOpsAdapter } = createComponent();
    let resolveRestore!: () => void;
    taskOpsAdapter.updateTaskStatus.mockReturnValueOnce(new Promise<boolean>(resolve => {
      resolveRestore = () => resolve(true);
    }));

    let completed = false;
    const pending = component.onRestoreFromHistory({ type: 'task', id: 'task-1' }).then(() => {
      completed = true;
    });

    await Promise.resolve();
    expect(completed).toBe(false);
    expect(taskOpsAdapter.updateTaskStatus).toHaveBeenCalledWith('task-1', 'active');

    resolveRestore();
    await pending;

    expect(completed).toBe(true);
  });

  it('onRestoreFromHistory 应提示 task 恢复本地保存失败', async () => {
    const { component, taskOpsAdapter, toast } = createComponent();
    taskOpsAdapter.updateTaskStatus.mockResolvedValueOnce(false);

    await component.onRestoreFromHistory({ type: 'task', id: 'task-1' });

    expect(taskOpsAdapter.updateTaskStatus).toHaveBeenCalledWith('task-1', 'active');
    expect(toast.warning).toHaveBeenCalledWith(
      '恢复失败',
      '任务状态本地保存失败，请释放浏览器存储空间后重试',
    );
  });
});
