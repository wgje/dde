import { describe, expect, it, vi } from 'vitest';

import {
  AuthOwnerTransitionController,
  bindAuthOwnerTransition,
  getAuthOwnerTransition,
} from './auth-owner-transition.controller';

function createHarness(initialOwner: string | null = 'owner-a') {
  let generation = 0;
  let currentOwnerUserId = initialOwner;
  let pendingOwnerUserId: string | null = null;
  const publishedOwners: Array<string | null> = [];
  const controller = new AuthOwnerTransitionController({
    generation: () => generation,
    currentOwnerUserId: () => currentOwnerUserId,
    pendingOwnerUserId: () => pendingOwnerUserId,
    advanceGeneration: () => { generation += 1; },
    publishTargetOwner: ownerUserId => {
      publishedOwners.push(ownerUserId);
      currentOwnerUserId = ownerUserId;
    },
  });

  return {
    controller,
    generation: () => generation,
    currentOwner: () => currentOwnerUserId,
    pendingOwner: () => pendingOwnerUserId,
    publishedOwners,
    setCurrentOwner: (ownerUserId: string | null) => { currentOwnerUserId = ownerUserId; },
    setPendingOwner: (ownerUserId: string | null) => { pendingOwnerUserId = ownerUserId; },
  };
}

describe('AuthOwnerTransitionController', () => {
  it('binds one internal controller to an owner without changing the owner API', () => {
    const owner = {};
    const harness = createHarness();

    bindAuthOwnerTransition(owner, harness.controller);

    expect(getAuthOwnerTransition(owner)).toBe(harness.controller);
    expect(Object.keys(owner)).toEqual([]);
  });

  it('fails closed when no internal owner transition is bound', () => {
    expect(() => getAuthOwnerTransition({}))
      .toThrow('Auth owner transition controller is not bound');
  });

  it('captures an immutable owner and generation ticket without advancing', () => {
    const harness = createHarness();
    harness.setPendingOwner('owner-pending');

    const ticket = harness.controller.capture('owner-b');

    expect(ticket).toEqual({
      ticketId: 1,
      capturedGeneration: 0,
      currentOwnerUserId: 'owner-a',
      pendingOwnerUserId: 'owner-pending',
      targetOwnerUserId: 'owner-b',
    });
    expect(Object.isFrozen(ticket)).toBe(true);
    expect(harness.generation()).toBe(0);
  });

  it('allows only one competing ticket to commit', () => {
    const harness = createHarness();
    const first = harness.controller.capture('owner-b');
    const second = harness.controller.capture('owner-c');

    expect(harness.controller.commit(first, () => undefined)).toEqual({
      status: 'committed', generation: 1,
    });
    expect(harness.controller.commit(second, () => undefined)).toEqual({
      status: 'stale', reason: 'ticket-consumed',
    });
    expect(harness.publishedOwners).toEqual(['owner-b']);
  });

  it('rejects an outer publication when cleanup captures a newer usable ticket', () => {
    const harness = createHarness();
    const outer = harness.controller.capture('owner-b');
    let newer: ReturnType<typeof harness.controller.capture> | undefined;

    expect(harness.controller.commit(outer, () => {
      newer = harness.controller.capture('owner-c');
    })).toEqual({ status: 'stale', reason: 'reentrant-change' });
    expect(harness.publishedOwners).toEqual([]);
    expect(newer).toBeDefined();
    expect(harness.controller.commit(newer!, () => undefined)).toEqual({
      status: 'committed', generation: 2,
    });
    expect(harness.publishedOwners).toEqual(['owner-c']);
  });

  it('discards only the exact ticket without advancing generation', () => {
    const harness = createHarness();
    const discarded = harness.controller.capture('owner-b');
    const competitor = harness.controller.capture('owner-c');

    harness.controller.discard(discarded);
    harness.controller.discard(discarded);

    expect(harness.generation()).toBe(0);
    expect(harness.controller.commit(discarded, () => undefined)).toEqual({
      status: 'stale', reason: 'ticket-consumed',
    });
    expect(harness.controller.commit(competitor, () => undefined)).toEqual({
      status: 'committed', generation: 1,
    });
    expect(harness.publishedOwners).toEqual(['owner-c']);
  });

  it('rejects an A to B to A ticket after generation advancement', () => {
    const harness = createHarness();
    const ticket = harness.controller.capture('owner-c');
    harness.setCurrentOwner('owner-b');
    harness.controller.advanceGeneration();
    harness.setCurrentOwner('owner-a');
    harness.controller.advanceGeneration();

    expect(harness.controller.commit(ticket, () => undefined)).toEqual({
      status: 'stale', reason: 'ticket-consumed',
    });
    expect(harness.publishedOwners).toEqual([]);
  });

  it('advances generation and publishes a same-owner commit once', () => {
    const harness = createHarness();
    const ticket = harness.controller.capture('owner-a');

    expect(harness.controller.commit(ticket, () => undefined)).toEqual({
      status: 'committed', generation: 1,
    });
    expect(harness.currentOwner()).toBe('owner-a');
    expect(harness.publishedOwners).toEqual(['owner-a']);
    expect(harness.generation()).toBe(1);
  });

  it.each([
    ['current-owner-changed', (harness: ReturnType<typeof createHarness>) => harness.setCurrentOwner('owner-z')],
    ['pending-owner-changed', (harness: ReturnType<typeof createHarness>) => harness.setPendingOwner('owner-pending')],
  ] as const)('rejects %s drift before cleanup', (reason, mutate) => {
    const harness = createHarness();
    const cleanup = vi.fn();
    const ticket = harness.controller.capture('owner-b');
    mutate(harness);

    expect(harness.controller.commit(ticket, cleanup)).toEqual({ status: 'stale', reason });
    expect(cleanup).not.toHaveBeenCalled();
    expect(harness.publishedOwners).toEqual([]);
  });

  it('reset advances once, consumes tickets, and remains reusable', () => {
    const harness = createHarness();
    const stale = harness.controller.capture('owner-b');

    harness.controller.reset();

    expect(harness.generation()).toBe(1);
    expect(harness.controller.commit(stale, () => undefined)).toEqual({
      status: 'stale', reason: 'ticket-consumed',
    });
    const current = harness.controller.capture('owner-c');
    expect(harness.controller.commit(current, () => undefined).status).toBe('committed');
  });

  it('destroy advances once, consumes tickets, and permanently rejects capture', () => {
    const harness = createHarness();
    const stale = harness.controller.capture('owner-b');

    harness.controller.destroy();
    harness.controller.destroy();
    harness.controller.advanceGeneration();

    expect(harness.generation()).toBe(1);
    expect(harness.controller.commit(stale, () => undefined)).toEqual({
      status: 'stale', reason: 'destroyed',
    });
    expect(() => harness.controller.capture('owner-c')).toThrow('Auth owner transition controller is destroyed');
  });

  it('terminally consumes a ticket and publishes nothing when cleanup throws', () => {
    const harness = createHarness();
    const failure = new Error('cleanup failed');
    const ticket = harness.controller.capture('owner-b');

    expect(() => harness.controller.commit(ticket, () => { throw failure; })).toThrow(failure);
    expect(harness.generation()).toBe(1);
    expect(harness.publishedOwners).toEqual([]);
    expect(harness.controller.commit(ticket, () => undefined)).toEqual({
      status: 'stale', reason: 'ticket-consumed',
    });
  });

  it('rejects declared async cleanup before invocation and terminally consumes the ticket', () => {
    const harness = createHarness();
    let invoked = false;
    const cleanup = async () => { invoked = true; };
    const ticket = harness.controller.capture('owner-b');

    expect(() => harness.controller.commit(ticket, cleanup as unknown as () => void))
      .toThrow('Auth owner transition cleanup must be synchronous');
    expect(invoked).toBe(false);
    expect(harness.generation()).toBe(1);
    expect(harness.publishedOwners).toEqual([]);
  });

  it('rejects a returned thenable without publishing the target', () => {
    const harness = createHarness();
    const ticket = harness.controller.capture('owner-b');

    expect(() => harness.controller.commit(
      ticket,
      (() => Promise.resolve()) as unknown as () => void,
    )).toThrow('Auth owner transition cleanup returned a thenable');
    expect(harness.generation()).toBe(1);
    expect(harness.publishedOwners).toEqual([]);
  });

  it('rejects publication after reentrant generation advancement', () => {
    const harness = createHarness();
    const ticket = harness.controller.capture('owner-b');

    expect(harness.controller.commit(ticket, () => {
      harness.controller.advanceGeneration();
    })).toEqual({ status: 'stale', reason: 'reentrant-change' });
    expect(harness.generation()).toBe(2);
    expect(harness.publishedOwners).toEqual([]);
  });

  it('rejects publication after reentrant owner or pending-owner mutation', () => {
    const harness = createHarness();
    const currentTicket = harness.controller.capture('owner-b');
    expect(harness.controller.commit(currentTicket, () => {
      harness.setCurrentOwner('owner-z');
    })).toEqual({ status: 'stale', reason: 'reentrant-change' });

    const pendingTicket = harness.controller.capture('owner-c');
    expect(harness.controller.commit(pendingTicket, () => {
      harness.setPendingOwner('owner-pending');
    })).toEqual({ status: 'stale', reason: 'reentrant-change' });
    expect(harness.publishedOwners).toEqual([]);
  });

  it('rejects reuse of a committed ticket without invoking cleanup again', () => {
    const harness = createHarness();
    const ticket = harness.controller.capture('owner-b');
    expect(harness.controller.commit(ticket, () => undefined).status).toBe('committed');
    const cleanup = vi.fn();

    expect(harness.controller.commit(ticket, cleanup)).toEqual({
      status: 'stale', reason: 'ticket-consumed',
    });
    expect(cleanup).not.toHaveBeenCalled();
    expect(harness.publishedOwners).toEqual(['owner-b']);
  });
});
