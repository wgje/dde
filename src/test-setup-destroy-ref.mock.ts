import { vi } from 'vitest';

/**
 * 创建 DestroyRef Mock 工厂函数
 * 用于测试使用 inject(DestroyRef) 的服务
 *
 * @example
 * const { destroyRef, destroy } = createMockDestroyRef();
 * const injector = Injector.create({
 *   providers: [{ provide: DestroyRef, useValue: destroyRef }]
 * });
 * // 触发销毁回调
 * destroy();
 */
export function createMockDestroyRef() {
  const callbacks: Array<() => void> = [];

  const destroyRef = {
    onDestroy: vi.fn((callback: () => void) => {
      callbacks.push(callback);
      // 返回取消注册函数
      return () => {
        const index = callbacks.indexOf(callback);
        if (index > -1) callbacks.splice(index, 1);
      };
    }),
  };

  const destroy = () => {
    callbacks.forEach(cb => cb());
    callbacks.length = 0;
  };

  return { destroyRef, destroy };
}
