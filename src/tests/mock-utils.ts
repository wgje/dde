/**
 * 测试 Mock 工具函数
 * 
 * 提供类型安全的 mock 创建方法，替代 any 类型
 * 
 * @example
 * // Before (不安全)
 * let mockService: any;
 * mockService = { foo: vi.fn() };
 * 
 * // After (类型安全)
 * const mockService = createMock<FooService>({ foo: vi.fn() });
 */

import { vi, type Mock } from 'vitest';

/**
 * Mock 类型定义
 * 将类型 T 的所有方法转换为 Mock 函数
 */
export type MockType<T> = {
  [P in keyof T]: T[P] extends (...args: unknown[]) => unknown
    ? Mock
    : T[P];
};

/**
 * 创建类型安全的 mock 对象
 * 
 * @param overrides - 需要覆盖的属性和方法
 * @returns 类型安全的 mock 对象
 * 
 * @example
 * const mockLogger = createMock<LoggerService>({
 *   info: vi.fn(),
 *   error: vi.fn(),
 *   warn: vi.fn(),
 *   debug: vi.fn()
 * });
 */
export function createMock<T extends object>(
  overrides: Partial<Record<keyof T, unknown>> = {}
): MockType<T> {
  return new Proxy({} as MockType<T>, {
    get(target, prop: string | symbol) {
      if (prop in overrides) {
        return overrides[prop as keyof T];
      }
      // 返回一个空 mock 函数，避免未定义属性报错
      if (!(prop in target)) {
        (target as Record<string | symbol, unknown>)[prop] = vi.fn();
      }
      return target[prop as keyof typeof target];
    }
  });
}

/**
 * 创建服务 mock 的辅助函数
 * 自动为服务类的所有方法创建 mock
 * 
 * @param ServiceClass - 服务类（用于获取原型方法）
 * @param overrides - 需要覆盖的方法实现
 * @returns 类型安全的服务 mock
 * 
 * @example
 * const mockToast = createServiceMock(ToastService, {
 *   success: vi.fn(),
 *   error: vi.fn()
 * });
 */
export function createServiceMock<T extends object>(
  ServiceClass: new (...args: unknown[]) => T,
  overrides: Partial<T> = {}
): MockType<T> {
  const mock = {} as MockType<T>;
  
  // 获取类原型上的方法
  const prototype = ServiceClass.prototype;
  const methodNames = Object.getOwnPropertyNames(prototype)
    .filter(name => name !== 'constructor' && typeof prototype[name] === 'function');
  
  // 为每个方法创建 mock
  for (const methodName of methodNames) {
    (mock as Record<string, unknown>)[methodName] = vi.fn();
  }
  
  // 应用覆盖
  return { ...mock, ...overrides };
}

/**
 * 创建 Signal mock
 * 
 * @param initialValue - Signal 的初始值
 * @returns 可读取和设置的 Signal mock
 * 
 * @example
 * const mockUserId = createSignalMock<string | null>('test-user');
 * expect(mockUserId()).toBe('test-user');
 * mockUserId.set('new-user');
 */
export function createSignalMock<T>(initialValue: T): (() => T) & { set: (value: T) => void } {
  let value = initialValue;
  const signal = (() => value) as (() => T) & { set: (value: T) => void };
  signal.set = (newValue: T) => { value = newValue; };
  return signal;
}

/**
 * 创建 WritableSignal mock
 * 
 * @param initialValue - Signal 的初始值
 * @returns 完整的 WritableSignal mock
 */
export function createWritableSignalMock<T>(initialValue: T) {
  let value = initialValue;
  return {
    get: () => value,
    set: (newValue: T) => { value = newValue; },
    update: (updater: (current: T) => T) => { value = updater(value); },
    asReadonly: () => () => value
  };
}

/**
 * 创建 Observable mock
 * 
 * @example
 * const mockOnConflict$ = createObservableMock<ConflictData>();
 * mockOnConflict$.emit({ projectId: 'test' });
 */
export function createObservableMock<T>() {
  const subscribers: Array<(value: T) => void> = [];
  return {
    subscribe: (callback: (value: T) => void) => {
      subscribers.push(callback);
      return { unsubscribe: () => subscribers.splice(subscribers.indexOf(callback), 1) };
    },
    emit: (value: T) => subscribers.forEach(cb => cb(value)),
    pipe: () => createObservableMock<T>()
  };
}
