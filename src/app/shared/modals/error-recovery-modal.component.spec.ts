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
});
