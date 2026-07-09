import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createWorkspaceShellCriticalFeatureFlagsLazyLoadDelegate,
  type WorkspaceShellCriticalFeatureFlagsDelegate,
} from './workspace-shell-critical-feature-flags-lazy-load-delegate.factory';

function createDelegate(): WorkspaceShellCriticalFeatureFlagsDelegate {
  return {
    validate: vi.fn(),
  };
}

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

describe('createWorkspaceShellCriticalFeatureFlagsLazyLoadDelegate', () => {
  it('keeps critical feature flag lazy-load controller logic out of the factory entry', () => {
    const factorySource = readFileSync(
      join(__dirname, 'workspace-shell-critical-feature-flags-lazy-load-delegate.factory.ts'),
      'utf8',
    );

    expect(factorySource).toContain(
      "from './workspace-shell-critical-feature-flags-lazy-load-delegate.controller'",
    );
    expect(factorySource).not.toContain('let controller:');
    expect(factorySource).not.toContain('controllerPromise');
    expect(factorySource).not.toContain('function validateController');
    expect(factorySource).not.toContain('function resolveController');
    expect(factorySource).not.toContain("import('./workspace-shell-critical-feature-flags.controller')");
    expect(factorySource).not.toContain("import('../../../config/feature-flags.config')");
  });

  it('lazy-loads the critical feature flag validator on first validation', async () => {
    const validator = createDelegate();
    const createCriticalFeatureFlagsController = vi.fn().mockResolvedValue(validator);
    const delegate = createWorkspaceShellCriticalFeatureFlagsLazyLoadDelegate({
      createCriticalFeatureFlagsController,
      warn: vi.fn(),
      warning: vi.fn(),
      getHostname: () => 'localhost',
    });

    expect(createCriticalFeatureFlagsController).not.toHaveBeenCalled();

    delegate.validate();
    await flushMicrotasks();

    expect(createCriticalFeatureFlagsController).toHaveBeenCalledTimes(1);
    expect(validator.validate).toHaveBeenCalledTimes(1);
  });

  it('warns and allows retrying when the validator chunk fails', async () => {
    const error = new Error('critical flags chunk missing');
    const validator = createDelegate();
    const createCriticalFeatureFlagsController = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(validator);
    const warn = vi.fn();
    const delegate = createWorkspaceShellCriticalFeatureFlagsLazyLoadDelegate({
      createCriticalFeatureFlagsController,
      warn,
      warning: vi.fn(),
      getHostname: () => 'localhost',
    });

    delegate.validate();
    await flushMicrotasks();
    delegate.validate();
    await flushMicrotasks();

    expect(createCriticalFeatureFlagsController).toHaveBeenCalledTimes(2);
    expect(validator.validate).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '关键安全开关 lazy-load 校验器加载失败，已跳过本次启动校验',
      error,
    );
  });

  it('warns and keeps startup alive when a loaded validator throws', async () => {
    const error = new Error('critical flags validation failed');
    const validator = createDelegate();
    vi.mocked(validator.validate).mockImplementation(() => {
      throw error;
    });
    const warn = vi.fn();
    const delegate = createWorkspaceShellCriticalFeatureFlagsLazyLoadDelegate({
      createCriticalFeatureFlagsController: vi.fn().mockResolvedValue(validator),
      warn,
      warning: vi.fn(),
      getHostname: () => 'localhost',
    });

    expect(() => delegate.validate()).not.toThrow();
    await flushMicrotasks();

    expect(validator.validate).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '关键安全开关 lazy-load 校验器执行失败，已跳过本次启动校验',
      error,
    );
  });
});
