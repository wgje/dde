import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { createPostHandoffSwRegistrationStrategy } from './sw-registration-strategy';

describe('createPostHandoffSwRegistrationStrategy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete window.__NANOFLOW_BOOT_STAGE__;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete window.__NANOFLOW_BOOT_STAGE__;
  });

  it('should wait for boot-stage handoff before resolving registration', async () => {
    const registerPromise = firstValueFrom(
      createPostHandoffSwRegistrationStrategy({ delayMs: 120, fallbackMs: 2_000 })()
    );

    vi.advanceTimersByTime(119);
    let settled = false;
    void registerPromise.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    window.dispatchEvent(new CustomEvent('nanoflow:boot-stage', {
      detail: { stage: 'handoff' },
    }));
    vi.advanceTimersByTime(119);
    await Promise.resolve();
    expect(settled).toBe(false);

    vi.advanceTimersByTime(1);
    await expect(registerPromise).resolves.toBeUndefined();
  });

  it('should fall back to delayed registration when handoff never arrives', async () => {
    const registerPromise = firstValueFrom(
      createPostHandoffSwRegistrationStrategy({ delayMs: 120, fallbackMs: 800 })()
    );

    vi.advanceTimersByTime(799);
    let settled = false;
    void registerPromise.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    vi.advanceTimersByTime(1);
    await expect(registerPromise).resolves.toBeUndefined();
  });
});
