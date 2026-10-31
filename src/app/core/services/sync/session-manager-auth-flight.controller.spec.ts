import { describe, expect, it, vi } from 'vitest';

import type { CanonicalAuthBundle } from '../../../../services/supabase-auth-client-lifecycle.controller';
import { SessionManagerAuthFlightController } from './session-manager-auth-flight.controller';

function sessionBundle(
  userId: string,
  accessToken: string,
  refreshToken = `refresh-${accessToken}`,
): CanonicalAuthBundle {
  return {
    session: JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
      user: { id: userId },
    }),
    codeVerifier: 'verifier',
    user: JSON.stringify({ id: userId }),
  };
}

describe('SessionManagerAuthFlightController', () => {
  it('invalidates a captured fence on any canonical triplet or event epoch change', () => {
    let bundle = sessionBundle('user-a', 'token-a');
    const client = {};
    const controller = new SessionManagerAuthFlightController({
      getStorageKey: () => 'canonical-key',
      peekBundle: () => ({ ...bundle }),
      getCurrentClient: () => client,
    });
    const fence = controller.capture();

    expect(fence && controller.isCurrent(fence)).toBe(true);
    bundle = { ...bundle, codeVerifier: 'new-verifier' };
    expect(fence && controller.isCurrent(fence)).toBe(false);

    bundle = sessionBundle('user-a', 'token-a');
    const nextFence = controller.capture();
    controller.advanceEventEpoch();
    expect(nextFence && controller.isCurrent(nextFence)).toBe(false);
  });

  it('binds a client by public object identity and rejects replacement clients', () => {
    const clientA = {};
    const clientB = {};
    let currentClient = clientA;
    const controller = new SessionManagerAuthFlightController({
      getStorageKey: () => 'canonical-key',
      peekBundle: () => sessionBundle('user-a', 'token-a'),
      getCurrentClient: () => currentClient,
    });
    const fence = controller.capture();
    const bound = fence && controller.bindClient(fence, clientA);

    expect(bound && controller.isCurrent(bound)).toBe(true);
    currentClient = clientB;
    expect(bound && controller.isCurrent(bound)).toBe(false);
    expect(fence && controller.bindClient(fence, clientB)).toBeNull();
  });

  it('accepts only the exact persisted refresh result and returns a fresh fence', () => {
    const client = {};
    let bundle = sessionBundle('user-a', 'token-a');
    const controller = new SessionManagerAuthFlightController({
      getStorageKey: () => 'canonical-key',
      peekBundle: () => ({ ...bundle }),
      getCurrentClient: () => client,
    });
    const fence = controller.capture();
    expect(fence).not.toBeNull();

    bundle = sessionBundle('user-a', 'token-b', 'refresh-token-b');
    const accepted = controller.acceptSession(fence!, client, {
      access_token: 'token-b',
      refresh_token: 'refresh-token-b',
      user: { id: 'user-a' },
    });

    expect(accepted && controller.isCurrent(accepted, 'user-a')).toBe(true);
    expect(controller.acceptSession(fence!, client, {
      access_token: 'token-a',
      refresh_token: 'refresh-token-a',
      user: { id: 'user-a' },
    })).toBeNull();
  });

  it('reads snapshots only while fence, owner and age remain current', () => {
    let now = 100;
    let bundle = sessionBundle('user-a', 'token-a');
    const client = {};
    const controller = new SessionManagerAuthFlightController({
      getStorageKey: () => 'canonical-key',
      peekBundle: () => ({ ...bundle }),
      getCurrentClient: () => client,
      now: () => now,
    });
    const fence = controller.capture()!;

    expect(controller.writeSnapshot(fence, true, 'user-a')).toBe(true);
    expect(controller.readSnapshot(50)).toEqual({ valid: true, userId: 'user-a', at: 100 });
    now = 151;
    expect(controller.readSnapshot(50)).toBeNull();
    now = 120;
    bundle = sessionBundle('user-b', 'token-b');
    expect(controller.readSnapshot(50)).toBeNull();
  });

  it('keys single-flight by the exact fence and old finally cannot clear a newer flight', async () => {
    let bundle = sessionBundle('user-a', 'token-a');
    const client = {};
    const controller = new SessionManagerAuthFlightController({
      getStorageKey: () => 'canonical-key',
      peekBundle: () => ({ ...bundle }),
      getCurrentClient: () => client,
    });
    const resolveA = vi.fn<(value: string) => void>();
    const pendingA = new Promise<string>(resolve => resolveA.mockImplementation(resolve));
    const fenceA = controller.capture()!;
    const flightA = controller.runSingleFlight('resume', fenceA, () => pendingA);
    expect(controller.runSingleFlight('resume', fenceA, () => Promise.resolve('duplicate')))
      .toBe(flightA);

    bundle = sessionBundle('user-b', 'token-b');
    const fenceB = controller.capture()!;
    const flightB = controller.runSingleFlight('resume', fenceB, () => Promise.resolve('b'));
    expect(flightB).not.toBe(flightA);
    await expect(flightB).resolves.toBe('b');
    resolveA('a');
    await expect(flightA).resolves.toBe('a');

    const nextB = controller.runSingleFlight('resume', fenceB, () => Promise.resolve('next-b'));
    expect(nextB).not.toBe(flightB);
    await expect(nextB).resolves.toBe('next-b');
  });
});
