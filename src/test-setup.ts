import 'zone.js';
import 'zone.js/testing';

import './test-setup.mocks';
import { mockSentryLazyLoaderService } from './test-setup.mocks';
import { TestBed } from '@angular/core/testing';
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

export { resetMocks, mockSentryLazyLoaderService } from './test-setup.mocks';
