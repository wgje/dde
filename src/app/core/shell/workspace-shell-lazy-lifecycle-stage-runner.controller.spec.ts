import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellLazyLifecycleStageRunnerController,
  type WorkspaceShellLazyLifecycleStageStep,
} from './workspace-shell-lazy-lifecycle-stage-runner.controller';

function createStep(
  label: string,
  record: string[],
  error?: Error,
): WorkspaceShellLazyLifecycleStageStep {
  return {
    label,
    run: vi.fn(() => {
      record.push(label);
      if (error) throw error;
    }),
  };
}

describe('WorkspaceShellLazyLifecycleStageRunnerController', () => {
  it('runs stage steps in order and continues when one step throws', () => {
    const error = new Error('keyboard shortcuts failed');
    const warn = vi.fn();
    const record: string[] = [];
    const controller = new WorkspaceShellLazyLifecycleStageRunnerController({ warn });

    expect(() => controller.run([
      createStep('keyboardShortcuts.initialize', record, error),
      createStep('startupBreadcrumb.initialize', record),
    ])).not.toThrow();

    expect(record).toEqual([
      'keyboardShortcuts.initialize',
      'startupBreadcrumb.initialize',
    ]);
    expect(warn).toHaveBeenCalledWith(
      '工作区懒生命周期步骤 keyboardShortcuts.initialize 执行失败，已继续后续生命周期',
      error,
    );
  });

  it('keeps running stage steps when the warning sink throws', () => {
    const stepError = new Error('startup teardown failed');
    const warn = vi.fn(() => {
      throw new Error('warn failed');
    });
    const record: string[] = [];
    const controller = new WorkspaceShellLazyLifecycleStageRunnerController({ warn });

    expect(() => controller.run([
      createStep('startupBreadcrumb.teardown', record, stepError),
      createStep('swUpdateLifecycle.teardown', record),
    ])).not.toThrow();

    expect(record).toEqual([
      'startupBreadcrumb.teardown',
      'swUpdateLifecycle.teardown',
    ]);
    expect(warn).toHaveBeenCalledWith(
      '工作区懒生命周期步骤 startupBreadcrumb.teardown 执行失败，已继续后续生命周期',
      stepError,
    );
  });
});
