import 'zone.js';
import 'zone.js/testing';

import './test-setup.mocks';

import { TestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';

// Services 套件使用更轻的 BrowserTestingModule，减少 dynamic testing 的额外初始化成本。
const globalKey = '__vitest_angular_testbed_init__';
const g = globalThis as Record<string, unknown>;
if (!g[globalKey]) {
  g[globalKey] = true;
  TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
}

export { resetMocks } from './test-setup.mocks';
