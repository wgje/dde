import 'zone.js';
import 'zone.js/testing';

import './test-setup.mocks';
import { mockSentryLazyLoaderService } from './test-setup.mocks';
import { TestBed } from '@angular/core/testing';
import { afterEach } from 'vitest';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { SentryLazyLoaderService } from './services/sentry-lazy-loader.service';

// 初始化 Angular TestBed 环境（只初始化一次）
// 在 threads pool 下，每个 worker 都会执行一次 setupFiles，因此需要避免重复 initTestEnvironment。
const globalKey = '__vitest_angular_testbed_init__';
const g = globalThis as Record<string, unknown>;
if (!g[globalKey]) {
  g[globalKey] = true;
  TestBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
    // 全局提供 SentryLazyLoaderService mock
    providers: [
      { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService }
    ]
  });
}

// 某些 no-isolate 组合下可能丢失 raf/cancelRaf（被其他测试 stub/restore 影响）。
// 这里做幂等兜底，保证组件测试可稳定调用。
const ensureAnimationFramePolyfill = () => {
  const globalWithRaf = globalThis as typeof globalThis & {
    requestAnimationFrame?: (cb: FrameRequestCallback) => number;
    cancelAnimationFrame?: (id: number) => void;
  };

  if (typeof globalWithRaf.requestAnimationFrame !== 'function') {
    globalWithRaf.requestAnimationFrame = (callback: FrameRequestCallback) =>
      setTimeout(() => callback(Date.now()), 16) as unknown as number;
  }

  if (typeof globalWithRaf.cancelAnimationFrame !== 'function') {
    globalWithRaf.cancelAnimationFrame = (id: number) => {
      clearTimeout(id);
    };
  }

  if (typeof window !== 'undefined') {
    const windowWithRaf = window as Window & typeof globalThis;
    if (typeof windowWithRaf.requestAnimationFrame !== 'function') {
      windowWithRaf.requestAnimationFrame = globalWithRaf.requestAnimationFrame;
    }
    if (typeof windowWithRaf.cancelAnimationFrame !== 'function') {
      windowWithRaf.cancelAnimationFrame = globalWithRaf.cancelAnimationFrame;
    }
  }
};

ensureAnimationFramePolyfill();

afterEach(() => {
  // 单 worker 全量运行时，强制回收 TestBed 状态，避免跨文件污染。
  try {
    TestBed.resetTestingModule();
  } catch {
    // noop
  }
});

export { resetMocks, mockSentryLazyLoaderService } from './test-setup.mocks';
