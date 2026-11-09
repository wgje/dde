export function asTimeoutHandle(value: number): ReturnType<typeof setTimeout> {
  return value as unknown as ReturnType<typeof setTimeout>;
}

export type FakeIdbTransaction = {
  objectStore: (...args: unknown[]) => unknown;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  error: DOMException | Error | null;
};
