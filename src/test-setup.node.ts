/**
 * Node 最小化测试初始化
 *
 * 用于不依赖 DOM 的纯逻辑测试车道，尽量降低 environment 固定成本。
 */

import '@angular/compiler';
import './test-setup.mocks';

const g = globalThis as typeof globalThis & {
  window?: Window & typeof globalThis;
  sessionStorage?: Storage;
};

if (typeof g.window === 'undefined') {
  Object.defineProperty(globalThis, 'window', {
    value: globalThis,
    writable: true,
    configurable: true,
  });
}

const windowLike = window as unknown as {
  addEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
  dispatchEvent?: (event: Event) => boolean;
  sessionStorage?: Storage;
};

if (typeof windowLike.addEventListener !== 'function') {
  windowLike.addEventListener = () => undefined;
}
if (typeof windowLike.removeEventListener !== 'function') {
  windowLike.removeEventListener = () => undefined;
}
if (typeof windowLike.dispatchEvent !== 'function') {
  windowLike.dispatchEvent = () => true;
}

if (typeof g.sessionStorage === 'undefined') {
  const store: Record<string, string> = {};
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        Object.keys(store).forEach((key) => delete store[key]);
      },
      key: (index: number) => Object.keys(store)[index] ?? null,
      get length() {
        return Object.keys(store).length;
      },
    } as Storage,
    writable: true,
    configurable: true,
  });
}

if (typeof windowLike.sessionStorage === 'undefined' && typeof globalThis.sessionStorage !== 'undefined') {
  windowLike.sessionStorage = globalThis.sessionStorage;
}

if (typeof window.confirm !== 'function') {
  Object.defineProperty(window, 'confirm', {
    value: () => true,
    writable: true,
    configurable: true,
  });
}

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  });
}

if (typeof requestAnimationFrame === 'undefined') {
  (globalThis as typeof globalThis & { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame =
    (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16) as unknown as number;
}

if (typeof cancelAnimationFrame === 'undefined') {
  (globalThis as typeof globalThis & { cancelAnimationFrame: (id: number) => void }).cancelAnimationFrame =
    (id: number) => clearTimeout(id);
}

export { resetMocks } from './test-setup.mocks';
