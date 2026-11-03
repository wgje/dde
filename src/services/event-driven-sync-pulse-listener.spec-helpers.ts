const pulseEventListeners = new Set<EventListener>();
const addWindowListener = window.addEventListener.bind(window);
const removeWindowListener = window.removeEventListener.bind(window);

function unregisterPulseEventListener(listener: EventListener): void {
  try {
    removeWindowListener('nanoflow:sync-pulse', listener);
  } catch {
    // Test cleanup must not fail because the platform listener API was stubbed.
  } finally {
    pulseEventListeners.delete(listener);
  }
}

export function registerPulseEventListener(listener: EventListener): () => void {
  addWindowListener('nanoflow:sync-pulse', listener);
  pulseEventListeners.add(listener);
  return () => unregisterPulseEventListener(listener);
}

export function clearPulseEventListeners(): void {
  for (const listener of Array.from(pulseEventListeners)) unregisterPulseEventListener(listener);
}
