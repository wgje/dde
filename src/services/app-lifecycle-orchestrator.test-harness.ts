import { vi } from 'vitest';

export function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    configurable: true,
  });
}

export function setStandaloneDisplayMode(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query === '(display-mode: standalone)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as MediaQueryList)),
  });
}

export function installRequestIdleCallbackMock(): void {
  Object.defineProperty(window, 'requestIdleCallback', {
    configurable: true,
    writable: true,
    value: vi.fn((callback: IdleRequestCallback) => {
      queueMicrotask(() => callback({
        didTimeout: false,
        timeRemaining: () => 50,
      } as IdleDeadline));
      return 1;
    }),
  });
}

export function restoreWindowProperty(
  name: 'requestIdleCallback' | 'matchMedia',
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(window, name, descriptor);
    return;
  }

  Reflect.deleteProperty(window as unknown as Record<string, unknown>, name);
}

export async function flushResumeWithoutDrainingLongTimers(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}
