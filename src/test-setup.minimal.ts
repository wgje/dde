/**
 * 最小化测试初始化（用于纯 TypeScript 测试）
 * 
 * 只包含必要的 polyfill 和全局配置，不加载 Angular/zone.js
 * 适用于不依赖 Angular DI 的纯逻辑测试
 * 
 * @see docs/test-architecture-modernization-plan.md Section 2.1.2
 */

// 纯测试环境仍有部分服务需要 JIT 注入器，显式引入编译器避免 "JIT compiler is not available"。
import '@angular/compiler';

// 导入全局 Mocks（Supabase/Sentry/浏览器 API）
import './test-setup.mocks';

// ============================================
// 必要的 Polyfill
// ============================================

// ResizeObserver polyfill（GoJS 等库可能使用）
if (typeof ResizeObserver === 'undefined') {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// MutationObserver 基本 polyfill
if (typeof MutationObserver === 'undefined') {
  (globalThis as unknown as { MutationObserver: unknown }).MutationObserver = class MutationObserver {
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
  };
}

// IntersectionObserver 基本 polyfill
if (typeof IntersectionObserver === 'undefined') {
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class IntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
    root = null;
    rootMargin = '';
    thresholds = [];
  };
}

// matchMedia polyfill
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  });
}

// confirm polyfill（happy-dom 的某些运行场景下不存在 confirm）。
if (typeof window !== 'undefined' && typeof window.confirm !== 'function') {
  Object.defineProperty(window, 'confirm', {
    configurable: true,
    writable: true,
    value: () => true,
  });
}

// requestAnimationFrame polyfill
if (typeof requestAnimationFrame === 'undefined') {
  (globalThis as unknown as { requestAnimationFrame: (cb: () => void) => number }).requestAnimationFrame = 
    (callback: () => void) => setTimeout(callback, 16) as unknown as number;
}

if (typeof cancelAnimationFrame === 'undefined') {
  (globalThis as unknown as { cancelAnimationFrame: (id: number) => void }).cancelAnimationFrame = 
    (id: number) => clearTimeout(id);
}

// ============================================
// 控制台噪音过滤（可选）
// ============================================

// 禁用某些测试中不需要的警告
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  const msg = args[0];
  // 过滤掉一些已知的噪音警告
  if (typeof msg === 'string') {
    // 过滤 Angular zone.js 相关警告（在纯测试中不需要）
    if (msg.includes('Zone') || msg.includes('zone.js')) return;
  }
  originalWarn.apply(console, args);
};

// 导出 resetMocks 供测试使用
export { resetMocks } from './test-setup.mocks';
