import { Injector, runInInjectionContext, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { BlackBoxPanelComponent } from './black-box-panel.component';
import { BlackBoxService } from '../../../../../services/black-box.service';
import { SpeechToTextService } from '../../../../../services/speech-to-text.service';
import { FocusPreferenceService } from '../../../../../services/focus-preference.service';
import { ToastService } from '../../../../../services/toast.service';

describe('BlackBoxPanelComponent', () => {
  function createComponent(blackBoxOverrides: Record<string, unknown> = {}) {
    const blackBoxService = {
      entriesByDate: signal([]),
      pendingCount: signal(0),
      refreshForView: vi.fn().mockResolvedValue(undefined),
      loadFromServer: vi.fn(),
      create: vi.fn(),
      createDurably: vi.fn().mockResolvedValue({ ok: true, value: {} }),
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

    const injector = Injector.create({
      providers: [
        { provide: BlackBoxService, useValue: blackBoxService },
        { provide: SpeechToTextService, useValue: {} },
        { provide: FocusPreferenceService, useValue: {} },
        { provide: ToastService, useValue: toast },
      ],
    });

    const component = runInInjectionContext(injector, () => new BlackBoxPanelComponent());
    return { component, blackBoxService, toast };
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

  it('visibility listener 注册失败时 ngOnInit 不应抛出并允许后续重试', () => {
    const { component, blackBoxService } = createComponent();
    const addVisibilityListener = vi
      .spyOn(document, 'addEventListener')
      .mockImplementationOnce(() => {
        throw new Error('add visibility failed');
      });

    try {
      expect(() => component.ngOnInit()).not.toThrow();
      expect((component as unknown as { visibilityHandler: unknown }).visibilityHandler).toBeNull();
    } finally {
      addVisibilityListener.mockRestore();
    }

    component.ngOnInit();
    blackBoxService.refreshForView.mockClear();

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(blackBoxService.refreshForView).toHaveBeenCalledTimes(1);

    component.ngOnDestroy();
  });

  it('重复初始化时不应重复注册 visibility listener', () => {
    const { component, blackBoxService } = createComponent();
    const registeredVisibilityHandlers: EventListener[] = [];
    const originalAddEventListener = document.addEventListener.bind(document);
    const addVisibilityListener = vi
      .spyOn(document, 'addEventListener')
      .mockImplementation((type, listener, options) => {
        if (type === 'visibilitychange') {
          registeredVisibilityHandlers.push(listener as EventListener);
        }
        originalAddEventListener(type, listener, options);
      });

    try {
      component.ngOnInit();
      component.ngOnInit();
      blackBoxService.refreshForView.mockClear();

      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(blackBoxService.refreshForView).toHaveBeenCalledTimes(1);
    } finally {
      component.ngOnDestroy();
      addVisibilityListener.mockRestore();
      for (const handler of registeredVisibilityHandlers) {
        document.removeEventListener('visibilitychange', handler);
      }
    }
  });

  it('ngOnDestroy 清理 visibility listener 失败时不应向外抛出', () => {
    const { component } = createComponent();
    const removeVisibilityListener = vi
      .spyOn(document, 'removeEventListener')
      .mockImplementationOnce(() => {
        throw new Error('remove visibility failed');
      });
    component.ngOnInit();

    try {
      expect(() => component.ngOnDestroy()).not.toThrow();
      expect((component as unknown as { visibilityHandler: unknown }).visibilityHandler).toBeNull();
    } finally {
      removeVisibilityListener.mockRestore();
    }
  });

  it('onTranscribed 应通过 durable API 写入本地后再暴露成功状态', async () => {
    const { component, blackBoxService } = createComponent();

    await component.onTranscribed('  新条目  ');

    expect(blackBoxService.createDurably).toHaveBeenCalledWith({ content: '新条目' });
    expect(blackBoxService.create).not.toHaveBeenCalled();
  });

  it('onTranscribed durable 写入失败时应提示且不回退到旧 create', async () => {
    const { component, blackBoxService, toast } = createComponent({
      createDurably: vi.fn().mockResolvedValue({
        ok: false,
        error: { message: '本地写入失败' },
      }),
    });

    await component.onTranscribed('新条目');

    expect(toast.warning).toHaveBeenCalledWith('保存失败', '本地写入失败');
    expect(blackBoxService.create).not.toHaveBeenCalled();
  });

  it('onMarkRead 应使用 durable 已读 API', async () => {
    const { component, blackBoxService } = createComponent();

    await component.onMarkRead('entry-1');

    expect(blackBoxService.markAsReadDurably).toHaveBeenCalledWith('entry-1');
    expect(blackBoxService.markAsRead).not.toHaveBeenCalled();
  });

  it('onConfirmDelete 应使用 durable 删除 API', async () => {
    const { component, blackBoxService } = createComponent();

    await component.onConfirmDelete('entry-1');

    expect(blackBoxService.deleteDurably).toHaveBeenCalledWith('entry-1');
    expect(blackBoxService.delete).not.toHaveBeenCalled();
  });
});
