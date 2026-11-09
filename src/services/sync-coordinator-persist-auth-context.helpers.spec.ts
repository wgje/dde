import { describe, expect, it } from 'vitest';

import { PersistAuthContextTracker } from './sync-coordinator-persist-auth-context.helpers';

describe('PersistAuthContextTracker', () => {
  it('captures the initial user generation', () => {
    const tracker = new PersistAuthContextTracker();

    const context = tracker.capture('user-a', 'user-a');

    expect(context).toEqual({ userId: 'user-a', generation: 1 });
    expect(tracker.isCurrent(context, 'user-a')).toBe(true);
  });

  it('invalidates captured contexts after the current user changes', () => {
    const tracker = new PersistAuthContextTracker();
    const context = tracker.capture('user-a', 'user-a');

    expect(tracker.isCurrent(context, 'user-b')).toBe(false);

    const nextContext = tracker.capture('user-b', 'user-b');
    expect(nextContext.generation).toBe(2);
    expect(tracker.isCurrent(nextContext, 'user-b')).toBe(true);
  });
});
