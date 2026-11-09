import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ProjectShellTaskDeepLinkRecoveryController,
} from './project-shell-task-deep-link-recovery.controller';

function createContext() {
  let currentGeneration = 1;
  const navigate = vi.fn().mockResolvedValue(true);
  const warning = vi.fn();
  const info = vi.fn();
  const success = vi.fn();
  const addFloatingTask = vi.fn().mockResolvedValue(true);
  const activateFlowIntent = vi.fn();
  const setActiveView = vi.fn();
  const reloadPage = vi.fn();
  const controller = new ProjectShellTaskDeepLinkRecoveryController({
    activateFlowIntent,
    isAttemptCurrent: generation => generation === currentGeneration,
    reloadPage,
    router: { navigate },
    setActiveView,
    taskOpsAdapter: { addFloatingTask },
    toast: { info, success, warning },
  });

  return {
    activateFlowIntent,
    addFloatingTask,
    controller,
    info,
    invalidate: () => {
      currentGeneration += 1;
    },
    navigate,
    reloadPage,
    setActiveView,
    success,
    warning,
  };
}

describe('ProjectShellTaskDeepLinkRecoveryController', () => {
  it('degrades missing startup deep links back to the workspace', async () => {
    const context = createContext();

    expect(context.controller.degradeMissingTaskToWorkspace(false)).toBe(false);
    expect(context.controller.degradeMissingTaskToWorkspace(true)).toBe(true);
    await Promise.resolve();

    expect(context.warning).toHaveBeenCalledWith(
      '任务不存在',
      '请求的任务已失效，已返回工作区',
    );
    expect(context.navigate).toHaveBeenCalledWith(['/projects']);
  });

  it('contains rejected workspace fallback navigation', async () => {
    const context = createContext();
    context.navigate.mockRejectedValueOnce(new Error('navigation failed'));

    context.controller.degradeMissingTaskToWorkspace(true);
    await Promise.resolve();

    expect(context.warning).toHaveBeenCalledWith(
      '返回工作区失败',
      '请稍后重试或手动返回项目列表',
    );
  });

  it('creates a durable fallback task only while the attempt is current', async () => {
    const current = createContext();
    const stale = createContext();

    current.controller.showFallback({ isLoading: false, task: null }, 1);
    stale.controller.showFallback({ isLoading: false, task: null }, 1);
    stale.invalidate();

    const currentAction = current.warning.mock.calls[0]?.[2] as
      | { action?: { onClick?: () => void } }
      | undefined;
    const staleAction = stale.warning.mock.calls[0]?.[2] as
      | { action?: { onClick?: () => void } }
      | undefined;
    currentAction?.action?.onClick?.();
    staleAction?.action?.onClick?.();
    await Promise.resolve();

    expect(current.addFloatingTask).toHaveBeenCalledWith('新任务', '', 100, 100);
    expect(current.success).toHaveBeenCalledWith('已创建新任务');
    expect(stale.addFloatingTask).not.toHaveBeenCalled();
  });

  it('offers force reload when the deep link remains loading', () => {
    const context = createContext();

    context.controller.showFallback({ isLoading: true, task: null }, 1);

    expect(context.activateFlowIntent).toHaveBeenCalledWith('deeplink');
    expect(context.setActiveView).toHaveBeenCalledWith('flow');
    const toastOptions = context.info.mock.calls[0]?.[2] as
      | { action?: { onClick?: () => void } }
      | undefined;
    toastOptions?.action?.onClick?.();
    expect(context.reloadPage).toHaveBeenCalledOnce();
  });

  it('keeps navigation, task creation and timeout recovery outside the main controller', () => {
    const source = readFileSync(
      join(__dirname, 'project-shell-task-deep-link.controller.ts'),
      'utf8',
    );

    expect(source).toContain('ProjectShellTaskDeepLinkRecoveryController');
    expect(source).not.toContain("router.navigate(['/projects'])");
    expect(source).not.toContain('addFloatingTask(');
    expect(source).not.toContain('reloadViaForceClearCache');
    expect(source).not.toContain('showDeepLinkTimeoutToast(');

    const recoverySource = readFileSync(
      join(__dirname, 'project-shell-task-deep-link-recovery.controller.ts'),
      'utf8',
    );
    expect(recoverySource).toContain("router.navigate(['/projects'])");
    expect(recoverySource).toContain('addFloatingTask(');
    expect(recoverySource).toContain('reloadViaForceClearCache');
  });
});
