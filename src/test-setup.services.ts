import 'zone.js';
import 'zone.js/testing';

import './test-setup.mocks';
import { mockSentryLazyLoaderService } from './test-setup.mocks';

import { TestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { SentryLazyLoaderService } from './services/sentry-lazy-loader.service';

// Services 套件使用更轻的 BrowserTestingModule，减少 dynamic testing 的额外初始化成本。
const globalKey = '__vitest_angular_testbed_init__';
const g = globalThis as Record<string, unknown>;
if (!g[globalKey]) {
  g[globalKey] = true;
  TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting(), {
    // 全局提供 SentryLazyLoaderService mock
    providers: [
      { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService }
    ]
  });
}

export { resetMocks, mockSentryLazyLoaderService } from './test-setup.mocks';
