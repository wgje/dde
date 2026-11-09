import { vi, type Mock } from 'vitest';

import type {
  WorkspaceShellSidebarResizeDeferredLazyLoadHostDelegate,
} from './workspace-shell-sidebar-resize-deferred-lazy-load-host.controller';

type WorkspaceShellSidebarResizeMockDelegate =
  WorkspaceShellSidebarResizeDeferredLazyLoadHostDelegate & {
    isResizingAny: Mock<() => boolean>;
    onMouseMove: Mock<(event: MouseEvent) => void>;
    onMouseUp: Mock<() => void>;
    setup: Mock<() => void>;
    startContentResize: Mock<(event: MouseEvent) => void>;
    startSidebarResize: Mock<(event: MouseEvent) => void>;
    teardown: Mock<() => void>;
  };

export function createWorkspaceShellSidebarResizeMouseEvent(): MouseEvent {
  let defaultPrevented = false;

  return {
    get defaultPrevented() {
      return defaultPrevented;
    },
    preventDefault: vi.fn(() => {
      defaultPrevented = true;
    }),
  } as unknown as MouseEvent;
}

export function createWorkspaceShellSidebarResizeDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, reject, resolve };
}

export function createWorkspaceShellSidebarResizeDelegate(
  record: string[] = [],
): WorkspaceShellSidebarResizeMockDelegate {
  let resizing = false;

  return {
    isResizingAny: vi.fn(() => resizing),
    onMouseMove: vi.fn(() => {
      record.push('onMouseMove');
    }),
    onMouseUp: vi.fn(() => {
      resizing = false;
      record.push('onMouseUp');
    }),
    setup: vi.fn(() => {
      record.push('setup');
    }),
    startContentResize: vi.fn(() => {
      resizing = true;
      record.push('startContentResize');
    }),
    startSidebarResize: vi.fn(() => {
      resizing = true;
      record.push('startSidebarResize');
    }),
    teardown: vi.fn(() => {
      resizing = false;
      record.push('teardown');
    }),
  };
}

export async function flushWorkspaceShellSidebarResizeMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}
