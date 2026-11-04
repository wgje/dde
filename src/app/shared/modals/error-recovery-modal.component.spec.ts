import { afterEach, describe, expect, it, vi } from 'vitest';

import { ErrorRecoveryModalComponent } from './error-recovery-modal.component';

describe('ErrorRecoveryModalComponent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('用户选择选项时应清理 handle 为 0 的自动选择 interval', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
      .mockReturnValue(0 as unknown as ReturnType<typeof setInterval>);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    const component = new ErrorRecoveryModalComponent();
    const emitted: unknown[] = [];
    component.options = [
      { id: 'retry', label: '重试', style: 'primary' },
      { id: 'ignore', label: '忽略', style: 'secondary' },
    ];
    component.autoSelectIn = 3;
    component.defaultOptionId = 'retry';
    component.select.subscribe(value => emitted.push(value));

    component.ngOnInit();
    component.selectOption(component.options[1]);

    expect(setIntervalSpy).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledWith(0);
    expect(emitted).toEqual([{ optionId: 'ignore', rememberChoice: undefined }]);
  });

  it('销毁时应清理 handle 为 0 的自动选择 interval', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
      .mockReturnValue(0 as unknown as ReturnType<typeof setInterval>);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    const component = new ErrorRecoveryModalComponent();
    component.autoSelectIn = 3;

    component.ngOnInit();
    component.ngOnDestroy();

    expect(setIntervalSpy).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledWith(0);
  });

  it('重复选择时只应发出第一次恢复结果', () => {
    const component = new ErrorRecoveryModalComponent();
    const emitted: unknown[] = [];
    component.options = [
      { id: 'retry', label: '重试', style: 'primary' },
      { id: 'ignore', label: '忽略', style: 'secondary' },
    ];
    component.select.subscribe(value => emitted.push(value));

    component.selectOption(component.options[0]);
    component.selectOption(component.options[1]);

    expect(emitted).toEqual([{ optionId: 'retry', rememberChoice: undefined }]);
  });

  it('背景关闭后不得再由已排队的倒计时回调发出选择', () => {
    let intervalCallback: (() => void) | undefined;
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation((handler) => {
      intervalCallback = handler as () => void;
      return 7 as unknown as ReturnType<typeof setInterval>;
    });
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    const component = new ErrorRecoveryModalComponent();
    const selections: unknown[] = [];
    let closeCount = 0;
    component.autoSelectIn = 1;
    component.select.subscribe(value => selections.push(value));
    component.close.subscribe(() => closeCount += 1);
    const backdrop = {};

    component.ngOnInit();
    component.onBackdropClick({ target: backdrop, currentTarget: backdrop } as MouseEvent);
    intervalCallback?.();

    expect(setIntervalSpy).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledWith(7);
    expect(closeCount).toBe(1);
    expect(selections).toEqual([]);
  });

  it('销毁后不得再由已排队的倒计时回调发出选择', () => {
    let intervalCallback: (() => void) | undefined;
    vi.spyOn(globalThis, 'setInterval').mockImplementation((handler) => {
      intervalCallback = handler as () => void;
      return 9 as unknown as ReturnType<typeof setInterval>;
    });
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    const component = new ErrorRecoveryModalComponent();
    const selections: unknown[] = [];
    component.autoSelectIn = 1;
    component.select.subscribe(value => selections.push(value));

    component.ngOnInit();
    component.ngOnDestroy();
    intervalCallback?.();

    expect(selections).toEqual([]);
  });
});
