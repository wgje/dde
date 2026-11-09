import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellSignalEffectsLazyLoadDelegate,
  type WorkspaceShellSignalEffectsLazyLoadDelegate,
} from './workspace-shell-signal-effects-lazy-load-delegate.factory';

function createSignalEffectsHost(): WorkspaceShellSignalEffectsLazyLoadDelegate {
  return {
    setup: vi.fn(),
    teardown: vi.fn(),
  };
}

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

describe('createWorkspaceShellSignalEffectsLazyLoadDelegate', () => {
  it('delegates signal effects lazy host resolution to the loader factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-signal-effects-lazy-load-delegate.factory.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellSignalEffectsLazyLoadHostLoader');
    expect(source).not.toContain("import('./workspace-shell-signal-effects-lazy-load-host.controller')");
    expect(source).not.toContain('new WorkspaceShellSignalEffectsLazyLoadHostController');
  });

  it('loads the signal effects lazy host once and forwards setup calls', async () => {
    const signalEffects = createSignalEffectsHost();
    const createSignalEffectsLazyLoadHost = vi.fn().mockResolvedValue(signalEffects);
    const delegate = createWorkspaceShellSignalEffectsLazyLoadDelegate({
      createSignalEffectsLazyLoadHost,
      warn: vi.fn(),
    });

    void delegate.setup();
    void delegate.setup();
    await flushMicrotasks();

    expect(createSignalEffectsLazyLoadHost).toHaveBeenCalledTimes(1);
    expect(signalEffects.setup).toHaveBeenCalledTimes(2);
  });

  it('warns and allows retrying after the signal effects lazy host chunk fails', async () => {
    const error = new Error('signal effects lazy host chunk missing');
    const signalEffects = createSignalEffectsHost();
    const createSignalEffectsLazyLoadHost = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(signalEffects);
    const warn = vi.fn();
    const delegate = createWorkspaceShellSignalEffectsLazyLoadDelegate({
      createSignalEffectsLazyLoadHost,
      warn,
    });

    void delegate.setup();
    await flushMicrotasks();
    void delegate.setup();
    await flushMicrotasks();

    expect(createSignalEffectsLazyLoadHost).toHaveBeenCalledTimes(2);
    expect(signalEffects.setup).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Workspace shell signal effects lazy-load host failed',
      error,
    );
  });
});
