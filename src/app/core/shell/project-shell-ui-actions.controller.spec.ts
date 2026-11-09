import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import {
  ProjectShellUiActionsController,
} from './project-shell-ui-actions.controller';

describe('ProjectShellUiActionsController', () => {
  it('dispatches sidebar and dock focus session commands', () => {
    const dispatchEvent = vi.fn();
    const controller = new ProjectShellUiActionsController({
      dispatchEvent,
      getTask: vi.fn(),
      uiState: {
        filterMode: signal('all'),
        isTextColumnCollapsed: {
          set: vi.fn(),
          update: vi.fn(),
        },
        textColumnRatio: { set: vi.fn() },
      },
    });

    controller.toggleSidebar();
    controller.toggleDockFocusSession();

    expect(dispatchEvent).toHaveBeenCalledTimes(2);
    expect(dispatchEvent.mock.calls.map(([event]) => event.type)).toEqual([
      'toggle-sidebar',
      'dock-focus-session-toggle',
    ]);
  });

  it('toggles and expands the desktop text column', () => {
    const setCollapsed = vi.fn();
    const updateCollapsed = vi.fn((update: (value: boolean) => boolean) => update(true));
    const setRatio = vi.fn();
    const controller = new ProjectShellUiActionsController({
      dispatchEvent: vi.fn(),
      getTask: vi.fn(),
      uiState: {
        filterMode: signal('all'),
        isTextColumnCollapsed: {
          set: setCollapsed,
          update: updateCollapsed,
        },
        textColumnRatio: { set: setRatio },
      },
    });

    controller.toggleTextColumn();
    controller.expandTextColumnToMin();

    expect(updateCollapsed).toHaveBeenCalledOnce();
    expect(updateCollapsed.mock.calls[0]?.[0](false)).toBe(true);
    expect(setRatio).toHaveBeenCalledWith(25);
    expect(setCollapsed).toHaveBeenCalledWith(false);
  });

  it('owns filter open state and derives the current filter label', () => {
    const filterMode = signal('all');
    const getTask = vi.fn((taskId: string) => taskId === 'task-1'
      ? { title: 'Plan launch', displayId: 'T-1' }
      : null);
    const controller = new ProjectShellUiActionsController({
      dispatchEvent: vi.fn(),
      getTask,
      uiState: {
        filterMode,
        isTextColumnCollapsed: {
          set: vi.fn(),
          update: vi.fn(),
        },
        textColumnRatio: { set: vi.fn() },
      },
    });

    expect(controller.isFilterOpen()).toBe(false);
    expect(controller.currentFilterLabel()).toBe('全部任务');

    controller.isFilterOpen.set(true);
    filterMode.set('task-1');

    expect(controller.isFilterOpen()).toBe(true);
    expect(controller.currentFilterLabel()).toBe('Plan launch');
    expect(getTask).toHaveBeenCalledWith('task-1');
  });
});
