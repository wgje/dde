import { Observable } from 'rxjs';

interface SwRegistrationStrategyOptions {
  delayMs?: number;
  fallbackMs?: number;
}

/**
 * Service worker registration waits until the launch shell hands off control,
 * but still has a fallback timer so registration cannot stall forever.
 */
export function createPostHandoffSwRegistrationStrategy(
  options: SwRegistrationStrategyOptions = {},
): () => Observable<void> {
  const delayMs = options.delayMs ?? 300;
  const fallbackMs = options.fallbackMs ?? 4_000;

  return () => new Observable<void>((subscriber) => {
    if (typeof window === 'undefined') {
      subscriber.next();
      subscriber.complete();
      return undefined;
    }

    let completed = false;
    let delayedTimer: ReturnType<typeof setTimeout> | null = null;
    const fallbackTimer = setTimeout(() => completeRegistration(), fallbackMs);

    function cleanup(): void {
      window.removeEventListener('nanoflow:boot-stage', onBootStage as EventListener);
      if (delayedTimer) {
        clearTimeout(delayedTimer);
        delayedTimer = null;
      }
      clearTimeout(fallbackTimer);
    }

    function completeRegistration(): void {
      if (completed) return;
      completed = true;
      cleanup();
      subscriber.next();
      subscriber.complete();
    }

    function scheduleRegistration(): void {
      if (completed || delayedTimer) return;
      delayedTimer = setTimeout(() => completeRegistration(), delayMs);
    }

    function onBootStage(event: Event): void {
      const detail = (event as CustomEvent<{ stage?: string }>).detail;
      if (detail?.stage === 'handoff' || detail?.stage === 'ready') {
        scheduleRegistration();
      }
    }

    if (window.__NANOFLOW_BOOT_STAGE__ === 'handoff' || window.__NANOFLOW_BOOT_STAGE__ === 'ready') {
      scheduleRegistration();
    } else {
      window.addEventListener('nanoflow:boot-stage', onBootStage as EventListener);
    }

    return cleanup;
  });
}
