import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type MockFunction = ReturnType<typeof vi.fn<(...args: never[]) => unknown>>;

interface LoaderHarness {
  document: {
    body: { appendChild: MockFunction };
    getElementById: MockFunction;
    querySelector: MockFunction;
  };
  getPendingTimer: () => (() => void) | null;
  getLoader: () => { innerHTML: string; style: { display: string } };
  location: { href: string; replace: MockFunction };
  pushTrace: MockFunction;
  setBootStage: (stage: 'handoff' | 'ready' | null) => void;
  window: Window;
}

const indexHtml = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
const markerStart = indexHtml.indexOf('<!-- LAUNCH_SHARED_LOADER_DISMISS_START -->');
const markerEnd = indexHtml.indexOf('<!-- LAUNCH_SHARED_LOADER_DISMISS_END -->', markerStart);
const loaderBlock = indexHtml.slice(markerStart, markerEnd);
const script = loaderBlock.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error('Launch loader script is missing');

function createHarness(href: string): LoaderHarness {
  let now = 1_000;
  class FakeDate extends Date {
    static now(): number {
      return now;
    }
  }
  const status = { textContent: '' };
  const loader = { innerHTML: '', style: { display: '' } };
  const listeners = new Map<string, (event: Event) => void>();
  let timer: (() => void) | null = null;
  const pushTrace = vi.fn();
  const location = { href, replace: vi.fn() };
  const document = {
    body: { appendChild: vi.fn() },
    getElementById: vi.fn((id: string) => id === 'initial-loader' ? loader : id === 'loader-status' ? status : null),
    querySelector: vi.fn(() => null),
  };
  const windowStub = {
    __NANOFLOW_BOOT_STAGE__: null as string | null,
    __NANOFLOW_PUSH_STARTUP_TRACE__: pushTrace,
    __NANOFLOW_STARTUP_TRACE__: [],
    location,
    addEventListener: vi.fn((type: string, listener: EventListener) => listeners.set(type, listener as (event: Event) => void)),
  };
  const context = vm.createContext({
    URL,
    Date: FakeDate,
    document,
    window: windowStub,
    setTimeout: vi.fn((callback: () => void) => {
      timer = () => {
        now += 25_100;
        callback();
      };
      return 1;
    }),
  });
vm.runInContext(script!, context);

  return {
    document,
    getPendingTimer: () => timer,
    getLoader: () => loader,
    location,
    pushTrace,
    setBootStage(stage) {
      windowStub.__NANOFLOW_BOOT_STAGE__ = stage;
      if (stage) listeners.get('nanoflow:boot-stage')?.({ detail: { stage } } as CustomEvent);
    },
    window: windowStub as unknown as Window,
  };
}

describe('launch loader worker recovery', () => {
  it('keeps the normal boot-stage handoff path and does not navigate', () => {
    const harness = createHarness('https://nanoflow.pages.dev/app?keep=1#/projects/p/text');
    harness.setBootStage('handoff');
    harness.getPendingTimer()?.();

    expect(harness.location.replace).not.toHaveBeenCalled();
    expect(harness.getLoader().style.display).toBe('none');
  });

  it('preserves URL state and bypasses the worker once after handoff timeout', () => {
    const harness = createHarness('https://nanoflow.pages.dev/app?keep=1#/projects/p/text?taskId=t');
    harness.getPendingTimer()?.();

    expect(harness.location.replace).toHaveBeenCalledTimes(1);
    const recovered = new URL(harness.location.replace.mock.calls[0]?.[0] as string);
    expect(recovered.origin).toBe('https://nanoflow.pages.dev');
    expect(recovered.pathname).toBe('/app');
    expect(recovered.searchParams.get('keep')).toBe('1');
    expect(recovered.searchParams.has('ngsw-bypass')).toBe(true);
    expect(recovered.searchParams.get('nanoflow-startup-recovery')).toBe('bypass-worker-v1');
    expect(recovered.hash).toBe('#/projects/p/text?taskId=t');
    expect(harness.pushTrace).toHaveBeenCalledWith('loader.handoff_timeout', expect.objectContaining({ recoveryAttempted: false }));
    expect(harness.pushTrace).toHaveBeenCalledWith('loader.worker_bypass', expect.any(Object));
    expect(harness.getLoader().innerHTML).toBe('');
  });

  it('does not loop after a bypassed startup times out again and never clears storage', () => {
    const harness = createHarness('https://nanoflow.pages.dev/?ngsw-bypass&nanoflow-startup-recovery=bypass-worker-v1');
    harness.getPendingTimer()?.();

    expect(harness.location.replace).not.toHaveBeenCalled();
    expect(harness.getLoader().innerHTML).toContain('加载超时');
    expect(harness.getLoader().innerHTML).toContain('未被清理');
    expect(harness.pushTrace).toHaveBeenCalledWith('loader.handoff_timeout', expect.objectContaining({ recoveryAttempted: true }));
    expect(harness.window).not.toHaveProperty('caches');
    expect(harness.document).not.toHaveProperty('cookie');
  });
});
