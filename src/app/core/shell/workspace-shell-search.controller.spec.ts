import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { WorkspaceShellSearchController, readWorkspaceTextInputValue } from './workspace-shell-search.controller';

describe('WorkspaceShellSearchController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function createController() {
    const unifiedSearchQuery = signal('');
    const uiState = {
      projectSearchQuery: signal(''),
      searchQuery: signal(''),
      clearSearch: vi.fn(() => {
        uiState.projectSearchQuery.set('');
        uiState.searchQuery.set('');
      }),
    };

    return {
      controller: new WorkspaceShellSearchController(uiState, unifiedSearchQuery),
      unifiedSearchQuery,
      uiState,
    };
  }

  it('应立即更新输入显示值，并防抖同步项目与任务搜索', () => {
    const { controller, unifiedSearchQuery, uiState } = createController();

    controller.update('roadmap');

    expect(unifiedSearchQuery()).toBe('roadmap');
    expect(uiState.projectSearchQuery()).toBe('');
    expect(uiState.searchQuery()).toBe('');

    vi.advanceTimersByTime(299);
    expect(uiState.projectSearchQuery()).toBe('');

    vi.advanceTimersByTime(1);
    expect(uiState.projectSearchQuery()).toBe('roadmap');
    expect(uiState.searchQuery()).toBe('roadmap');
  });

  it('应以后一次输入覆盖前一次待执行防抖', () => {
    const { controller, uiState } = createController();

    controller.update('old');
    vi.advanceTimersByTime(100);
    controller.update('new');
    vi.advanceTimersByTime(299);

    expect(uiState.projectSearchQuery()).toBe('');

    vi.advanceTimersByTime(1);
    expect(uiState.projectSearchQuery()).toBe('new');
    expect(uiState.searchQuery()).toBe('new');
  });

  it('clear 应清空显示值并取消待执行防抖', () => {
    const { controller, unifiedSearchQuery, uiState } = createController();

    controller.update('pending');
    controller.clear();
    vi.advanceTimersByTime(300);

    expect(unifiedSearchQuery()).toBe('');
    expect(uiState.clearSearch).toHaveBeenCalledTimes(1);
    expect(uiState.projectSearchQuery()).toBe('');
    expect(uiState.searchQuery()).toBe('');
  });

  it('cleanup 应取消待执行防抖', () => {
    const { controller, uiState } = createController();

    controller.update('pending');
    controller.cleanup();
    vi.advanceTimersByTime(300);

    expect(uiState.projectSearchQuery()).toBe('');
    expect(uiState.searchQuery()).toBe('');
  });

  it('cleanup 应取消 timer handle 为 0 的待执行防抖', () => {
    const { controller } = createController();
    vi.spyOn(globalThis, 'setTimeout')
      .mockReturnValueOnce(0 as unknown as ReturnType<typeof setTimeout>);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    controller.update('pending');
    controller.cleanup();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
  });

  it('连续输入应取消 timer handle 为 0 的旧防抖', () => {
    const { controller } = createController();
    vi.spyOn(globalThis, 'setTimeout')
      .mockReturnValueOnce(0 as unknown as ReturnType<typeof setTimeout>)
      .mockReturnValueOnce(1 as unknown as ReturnType<typeof setTimeout>);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    controller.update('old');
    controller.update('new');

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
  });

  it('清理旧 debounce 失败时不应中断新输入，旧回调也不应覆盖新查询', () => {
    const { controller, uiState } = createController();
    const scheduledCallbacks: Array<() => void> = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: TimerHandler) => {
      scheduledCallbacks.push(callback as () => void);
      return scheduledCallbacks.length as unknown as ReturnType<typeof setTimeout>;
    });
    vi.spyOn(globalThis, 'clearTimeout').mockImplementationOnce(() => {
      throw new Error('clear failed');
    });

    controller.update('old');
    expect(() => controller.update('new')).not.toThrow();

    scheduledCallbacks[0]?.();
    expect(uiState.projectSearchQuery()).toBe('');
    expect(uiState.searchQuery()).toBe('');

    scheduledCallbacks[1]?.();
    expect(uiState.projectSearchQuery()).toBe('new');
    expect(uiState.searchQuery()).toBe('new');
  });

  it('调度 debounce 失败时不应抛出，并应保底同步搜索状态', () => {
    const { controller, unifiedSearchQuery, uiState } = createController();
    vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce(() => {
      throw new Error('schedule failed');
    });

    expect(() => controller.update('fallback')).not.toThrow();

    expect(unifiedSearchQuery()).toBe('fallback');
    expect(uiState.projectSearchQuery()).toBe('fallback');
    expect(uiState.searchQuery()).toBe('fallback');
  });

  it('hasActiveQuery 应聚合显示值、任务搜索和项目搜索状态', () => {
    const { controller, unifiedSearchQuery, uiState } = createController();

    expect(controller.hasActiveQuery()).toBe(false);

    unifiedSearchQuery.set('  roadmap  ');
    expect(controller.hasActiveQuery()).toBe(true);

    unifiedSearchQuery.set('   ');
    uiState.searchQuery.set('task');
    expect(controller.hasActiveQuery()).toBe(true);

    uiState.searchQuery.set('');
    uiState.projectSearchQuery.set('project');
    expect(controller.hasActiveQuery()).toBe(true);

    uiState.projectSearchQuery.set('   ');
    expect(controller.hasActiveQuery()).toBe(false);
  });
});

describe('readWorkspaceTextInputValue', () => {
  it('应从字符串或输入事件中读取文本值', () => {
    expect(readWorkspaceTextInputValue('direct')).toBe('direct');
    expect(readWorkspaceTextInputValue({ target: { value: 'event value' } } as unknown as Event)).toBe('event value');
    expect(readWorkspaceTextInputValue({ target: { value: 123 } } as unknown as Event)).toBe('');
  });
});
