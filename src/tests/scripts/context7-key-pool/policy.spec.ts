import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const policyPath = path.join(process.cwd(), 'scripts', 'context7-key-pool', 'policy.cjs');

type Identity = { slot: number; fingerprintSha256: string };
type Route =
  | { kind: 'keyed'; periodId: string; slot: number; fingerprintSha256: string }
  | { kind: 'anonymous'; reason: string };
type Reservation = {
  kind: 'keyed';
  periodId: string;
  slot: number;
  fingerprintSha256: string;
  attemptOrdinal: number;
};
type Outcome =
  | { kind: 'success' }
  | { kind: 'auth-invalid' }
  | { kind: 'quota-exhausted' }
  | { kind: 'rate-limit'; retryAfterMs: number }
  | { kind: 'transient' }
  | { kind: 'terminal-non-success'; statusCode: number }
  | { kind: 'input-invalid' };
type PoolState = {
  periodId: string;
  timeZone: string;
  records: Record<string, {
    fingerprintSha256: string;
    attemptedCalls: number;
    successfulCalls: number;
    status: 'healthy' | 'soft-exhausted' | 'quota-exhausted' | 'auth-invalid' | 'cooldown';
    cooldownUntil: string | null;
    lastErrorClass: string | null;
    lastErrorAt: string | null;
    settledAttempts: Array<{ periodId: string; attemptOrdinal: number }>;
  }>;
  activeSlots: Identity[];
  anonymousMode: { active: boolean; reason: string | null; since: string | null };
  updatedAt: string;
};

const policy = require(policyPath) as {
  SOFT_LIMIT: number;
  periodIdAt(now: Date, timeZone: string): string;
  nextPeriodStartAt(periodId: string, timeZone: string): Date;
  validateStatePayload(state: unknown): true;
  reconcileState(args: {
    state: PoolState | null;
    identities: Identity[];
    timeZone: string;
    now: Date;
  }): PoolState;
  selectRoute(state: PoolState, now: Date, options?: { excludeFingerprints?: string[] }): Route;
  reserveRoute(args: { state: PoolState; route: Route; now: Date }): {
    state: PoolState;
    reservation: Reservation;
  };
  applyOutcome(args: {
    state: PoolState;
    token: Reservation;
    outcome: Outcome;
    now: Date;
  }): PoolState;
  markAnonymous(args: { state: PoolState; reason: string; now: Date }): PoolState;
  clearAnonymous(args: { state: PoolState; now: Date }): PoolState;
  createFailClosedState(args: { identities: Identity[]; timeZone: string; now: Date }): PoolState;
};

const FP = ['a', 'b', 'c', 'd', 'e'].map(character => character.repeat(64));
const JULY = new Date('2026-07-15T00:00:00.000Z');
const AUGUST = new Date('2026-08-01T00:00:00.000Z');

function identities(fingerprints = FP.slice(0, 4)): Identity[] {
  return fingerprints.map((fingerprintSha256, index) => ({ slot: index + 1, fingerprintSha256 }));
}

function freshState(now = JULY, timeZone = 'UTC', activeIdentities = identities()): PoolState {
  return policy.reconcileState({ state: null, identities: activeIdentities, timeZone, now });
}

function cloneState(state: PoolState): PoolState {
  return structuredClone(state);
}

function reserve(state: PoolState, now = JULY): { state: PoolState; reservation: Reservation } {
  const route = policy.selectRoute(state, now);
  expect(route.kind).toBe('keyed');
  return policy.reserveRoute({ state, route, now });
}

function previousPeriodFixture(): { state: PoolState; token: Reservation } {
  const first = reserve(freshState(), JULY);
  return {
    state: policy.reconcileState({ state: first.state, identities: identities(), timeZone: 'UTC', now: AUGUST }),
    token: first.reservation,
  };
}

describe('Context7 key pool policy', () => {
  it('exports only the fixed public policy surface', () => {
    expect(Object.keys(policy).sort()).toEqual([
      'SOFT_LIMIT',
      'applyOutcome',
      'clearAnonymous',
      'createFailClosedState',
      'markAnonymous',
      'nextPeriodStartAt',
      'periodIdAt',
      'reconcileState',
      'reserveRoute',
      'selectRoute',
      'validateStatePayload',
    ].sort());
    expect(policy.SOFT_LIMIT).toBe(950);
  });

  it('computes local periods and exact next-month boundaries in required IANA zones', () => {
    expect(policy.periodIdAt(new Date('2026-07-31T23:30:00.000Z'), 'UTC')).toBe('2026-07');
    expect(policy.periodIdAt(new Date('2026-07-31T23:30:00.000Z'), 'Asia/Shanghai')).toBe('2026-08');
    expect(policy.nextPeriodStartAt('2026-07', 'UTC').toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(policy.nextPeriodStartAt('2026-07', 'America/New_York').toISOString()).toBe('2026-08-01T04:00:00.000Z');
    expect(policy.nextPeriodStartAt('2026-07', 'Asia/Shanghai').toISOString()).toBe('2026-07-31T16:00:00.000Z');
    expect(() => policy.periodIdAt(JULY, 'Not/A_Zone')).toThrow('invalid-time-zone');
    expect(() => policy.nextPeriodStartAt('2026-13', 'UTC')).toThrow('invalid-period-id');
  });

  it('reserves ordinals 1 through 950 on slot 1, rejects a stale 951st reservation, then routes to slot 2', () => {
    const original = freshState();
    let state = original;
    let staleRoute: Route | null = null;
    for (let ordinal = 1; ordinal <= 950; ordinal += 1) {
      const route = policy.selectRoute(state, JULY);
      expect(route).toEqual({ kind: 'keyed', periodId: '2026-07', slot: 1, fingerprintSha256: FP[0] });
      staleRoute = route;
      const result = policy.reserveRoute({ state, route, now: JULY });
      expect(result.reservation).toEqual({
        kind: 'keyed', periodId: '2026-07', slot: 1, fingerprintSha256: FP[0], attemptOrdinal: ordinal,
      });
      state = result.state;
    }
    expect(original.records[FP[0]].attemptedCalls).toBe(0);
    expect(state.records[FP[0]]).toEqual(expect.objectContaining({ attemptedCalls: 950, status: 'soft-exhausted' }));
    expect(() => policy.reserveRoute({ state, route: staleRoute as Route, now: JULY })).toThrow('route-not-eligible');
    expect(policy.selectRoute(state, JULY)).toEqual({
      kind: 'keyed', periodId: '2026-07', slot: 2, fingerprintSha256: FP[1],
    });
  });

  it('temporarily excludes fingerprints without changing their health or counters', () => {
    const state = freshState();
    const before = cloneState(state);
    expect(policy.selectRoute(state, JULY, { excludeFingerprints: [FP[0]] })).toEqual({
      kind: 'keyed', periodId: '2026-07', slot: 2, fingerprintSha256: FP[1],
    });
    expect(state).toEqual(before);
  });

  it('skips a live cooldown and returns to the lowest slot after it expires', () => {
    const state = freshState();
    state.records[FP[0]].status = 'cooldown';
    state.records[FP[0]].cooldownUntil = '2026-07-15T00:01:00.000Z';
    state.records[FP[0]].lastErrorClass = 'rate-limit';
    state.records[FP[0]].lastErrorAt = JULY.toISOString();
    expect(policy.selectRoute(state, JULY)).toEqual(expect.objectContaining({ kind: 'keyed', slot: 2 }));
    expect(policy.selectRoute(state, new Date('2026-07-15T00:01:00.001Z'))).toEqual(
      expect.objectContaining({ kind: 'keyed', slot: 1 }),
    );
  });

  it('skips auth-invalid, quota and soft exhaustion, then returns a fixed anonymous reason', () => {
    const state = freshState();
    state.records[FP[0]].status = 'auth-invalid';
    state.records[FP[0]].lastErrorClass = 'auth-invalid';
    state.records[FP[0]].lastErrorAt = JULY.toISOString();
    state.records[FP[1]].status = 'quota-exhausted';
    state.records[FP[1]].lastErrorClass = 'quota-exhausted';
    state.records[FP[1]].lastErrorAt = JULY.toISOString();
    state.records[FP[2]].status = 'soft-exhausted';
    state.records[FP[2]].attemptedCalls = 950;
    state.records[FP[3]].status = 'cooldown';
    state.records[FP[3]].cooldownUntil = '2026-07-16T00:00:00.000Z';
    state.records[FP[3]].lastErrorClass = 'rate-limit';
    state.records[FP[3]].lastErrorAt = JULY.toISOString();
    expect(policy.selectRoute(state, JULY)).toEqual({ kind: 'anonymous', reason: 'all-keyed-slots-unavailable' });
  });

  it('persists anonymous reason/since without a token and clears it on the next keyed reservation', () => {
    const state = freshState();
    const marked = policy.markAnonymous({ state, reason: 'all-keyed-slots-unavailable', now: JULY });
    expect(marked.anonymousMode).toEqual({
      active: true, reason: 'all-keyed-slots-unavailable', since: JULY.toISOString(),
    });
    expect(marked).not.toHaveProperty('reservation');
    const repeated = policy.markAnonymous({
      state: marked, reason: 'all-keyed-slots-unavailable', now: new Date('2026-07-15T00:05:00.000Z'),
    });
    expect(repeated.anonymousMode.since).toBe(JULY.toISOString());
    const result = reserve(repeated, new Date('2026-07-15T00:05:00.000Z'));
    expect(result.state.anonymousMode).toEqual({ active: false, reason: null, since: null });
    expect(policy.clearAnonymous({ state: marked, now: JULY }).anonymousMode).toEqual({
      active: false, reason: null, since: null,
    });
    expect(state.anonymousMode).toEqual({ active: false, reason: null, since: null });
  });

  it('preserves fingerprint-ledger counters across slot swaps and remove/re-add while initializing a new fingerprint at zero', () => {
    let state = freshState();
    for (let index = 0; index < 3; index += 1) state = reserve(state).state;
    const swapped = policy.reconcileState({
      state,
      identities: [
        { slot: 1, fingerprintSha256: FP[1] },
        { slot: 2, fingerprintSha256: FP[0] },
        { slot: 3, fingerprintSha256: FP[2] },
        { slot: 4, fingerprintSha256: FP[4] },
      ],
      timeZone: 'UTC',
      now: JULY,
    });
    expect(swapped.records[FP[0]].attemptedCalls).toBe(3);
    expect(swapped.records[FP[4]].attemptedCalls).toBe(0);
    expect(swapped.records).toHaveProperty(FP[3]);
    const removed = policy.reconcileState({
      state: swapped,
      identities: identities([FP[1], FP[2], FP[3]]),
      timeZone: 'UTC',
      now: JULY,
    });
    expect(removed.records[FP[0]].attemptedCalls).toBe(3);
    const readded = policy.reconcileState({
      state: removed,
      identities: identities([FP[0], FP[1], FP[2], FP[3]]),
      timeZone: 'UTC',
      now: JULY,
    });
    expect(readded.records[FP[0]].attemptedCalls).toBe(3);
  });

  it('resets monthly counts and quota/soft status while retaining auth-invalid and future cooldown', () => {
    const state = freshState();
    Object.assign(state.records[FP[0]], {
      attemptedCalls: 100, successfulCalls: 90, status: 'quota-exhausted',
      lastErrorClass: 'quota-exhausted', lastErrorAt: JULY.toISOString(),
      settledAttempts: [{ periodId: '2026-06', attemptOrdinal: 1 }, { periodId: '2026-07', attemptOrdinal: 2 }],
    });
    Object.assign(state.records[FP[1]], {
      attemptedCalls: 2, successfulCalls: 1, status: 'auth-invalid',
      lastErrorClass: 'auth-invalid', lastErrorAt: JULY.toISOString(),
    });
    Object.assign(state.records[FP[2]], {
      attemptedCalls: 3, status: 'cooldown', cooldownUntil: '2026-08-10T00:00:00.000Z',
      lastErrorClass: 'rate-limit', lastErrorAt: JULY.toISOString(),
    });
    Object.assign(state.records[FP[3]], { attemptedCalls: 950, status: 'soft-exhausted' });
    const next = policy.reconcileState({ state, identities: identities(), timeZone: 'UTC', now: AUGUST });
    expect(next.periodId).toBe('2026-08');
    expect(next.records[FP[0]]).toEqual(expect.objectContaining({ attemptedCalls: 0, successfulCalls: 0, status: 'healthy' }));
    expect(next.records[FP[0]].settledAttempts).toEqual([{ periodId: '2026-07', attemptOrdinal: 2 }]);
    expect(next.records[FP[1]]).toEqual(expect.objectContaining({ attemptedCalls: 0, successfulCalls: 0, status: 'auth-invalid' }));
    expect(next.records[FP[2]]).toEqual(expect.objectContaining({ attemptedCalls: 0, status: 'cooldown', cooldownUntil: '2026-08-10T00:00:00.000Z' }));
    expect(next.records[FP[3]]).toEqual(expect.objectContaining({ attemptedCalls: 0, status: 'healthy' }));
    expect(state.periodId).toBe('2026-07');
  });

  it('recovers expired cooldowns and never rolls a retained period backward', () => {
    const state = freshState(new Date('2026-07-31T12:00:00.000Z'));
    state.records[FP[0]].status = 'cooldown';
    state.records[FP[0]].cooldownUntil = '2026-05-20T00:00:00.000Z';
    state.records[FP[0]].lastErrorClass = 'rate-limit';
    state.records[FP[0]].lastErrorAt = '2026-05-19T00:00:00.000Z';
    const rolledBack = policy.reconcileState({
      state, identities: identities(), timeZone: 'Asia/Shanghai', now: new Date('2026-06-01T00:00:00.000Z'),
    });
    expect(rolledBack.periodId).toBe('2026-07');
    expect(rolledBack.timeZone).toBe('UTC');
    expect(rolledBack.records[FP[0]]).toEqual(expect.objectContaining({ status: 'healthy', cooldownUntil: null }));
    const equalPeriod = policy.reconcileState({
      state: rolledBack, identities: identities(), timeZone: 'Asia/Shanghai', now: new Date('2026-07-20T00:00:00.000Z'),
    });
    expect(equalPeriod.periodId).toBe('2026-07');
    expect(equalPeriod.timeZone).toBe('Asia/Shanghai');
  });

  it('rejects malformed counts, duplicate slots/fingerprints, and invalid status/date/timezone payloads', () => {
    const valid = freshState();
    expect(policy.validateStatePayload(valid)).toBe(true);
    const invalidStates: PoolState[] = [];
    for (const attemptedCalls of [-1, 1.5, 951]) {
      const state = cloneState(valid);
      state.records[FP[0]].attemptedCalls = attemptedCalls;
      invalidStates.push(state);
    }
    const successOverflow = cloneState(valid);
    successOverflow.records[FP[0]].successfulCalls = 1;
    invalidStates.push(successOverflow);
    const duplicateSlot = cloneState(valid);
    duplicateSlot.activeSlots[1].slot = 1;
    invalidStates.push(duplicateSlot);
    const duplicateFingerprint = cloneState(valid);
    duplicateFingerprint.activeSlots[1].fingerprintSha256 = FP[0];
    invalidStates.push(duplicateFingerprint);
    const badStatus = cloneState(valid);
    badStatus.records[FP[0]].status = 'broken' as PoolState['records'][string]['status'];
    invalidStates.push(badStatus);
    const badDate = cloneState(valid);
    badDate.updatedAt = 'not-a-date';
    invalidStates.push(badDate);
    const badCooldownDate = cloneState(valid);
    badCooldownDate.records[FP[0]].cooldownUntil = 'tomorrow';
    invalidStates.push(badCooldownDate);
    const badZone = cloneState(valid);
    badZone.timeZone = 'Not/A_Zone';
    invalidStates.push(badZone);
    const badPeriod = cloneState(valid);
    badPeriod.periodId = '2026-13';
    invalidStates.push(badPeriod);
    const staleSettlement = cloneState(valid);
    staleSettlement.records[FP[0]].settledAttempts = [{ periodId: '2026-05', attemptOrdinal: 1 }];
    invalidStates.push(staleSettlement);
    for (const state of invalidStates) expect(() => policy.validateStatePayload(state)).toThrow();
  });

  it('settles outcomes once by fingerprint + period/ordinal and permits ordinal reuse in a new month', () => {
    const first = reserve(freshState());
    const snapshot = cloneState(first.state);
    const task3Token = { ...first.reservation, stateRevision: { opaque: 'task-3-owned' } } as Reservation;
    const settled = policy.applyOutcome({ state: first.state, token: task3Token, outcome: { kind: 'success' }, now: JULY });
    expect(settled.records[FP[0]].successfulCalls).toBe(1);
    expect(settled.records[FP[0]].settledAttempts).toEqual([{ periodId: '2026-07', attemptOrdinal: 1 }]);
    expect(JSON.stringify(settled)).not.toContain('stateRevision');
    expect(first.state).toEqual(snapshot);
    const duplicate = policy.applyOutcome({
      state: settled, token: first.reservation, outcome: { kind: 'auth-invalid' }, now: JULY,
    });
    expect(duplicate).toBe(settled);
    const august = policy.reconcileState({ state: settled, identities: identities(), timeZone: 'UTC', now: AUGUST });
    const next = reserve(august, AUGUST);
    expect(next.reservation.attemptOrdinal).toBe(1);
    const nextSettled = policy.applyOutcome({
      state: next.state, token: next.reservation, outcome: { kind: 'success' }, now: AUGUST,
    });
    expect(nextSettled.records[FP[0]].settledAttempts).toEqual([
      { periodId: '2026-07', attemptOrdinal: 1 },
      { periodId: '2026-08', attemptOrdinal: 1 },
    ]);
  });

  it('settles terminal/input/transient outcomes without adding success or changing routing health', () => {
    let state = freshState();
    const tokens: Reservation[] = [];
    for (let index = 0; index < 3; index += 1) {
      const result = reserve(state);
      state = result.state;
      tokens.push(result.reservation);
    }
    const cases: Outcome[] = [
      { kind: 'terminal-non-success', statusCode: 404 },
      { kind: 'input-invalid' },
      { kind: 'transient' },
    ];
    for (let index = 0; index < cases.length; index += 1) {
      state = policy.applyOutcome({ state, token: tokens[index], outcome: cases[index], now: JULY });
      expect(state.records[FP[0]].status).toBe('healthy');
      expect(state.records[FP[0]].successfulCalls).toBe(0);
    }
    expect(state.records[FP[0]].lastErrorClass).toBe('transient');
    expect(state.records[FP[0]].settledAttempts).toHaveLength(3);
  });

  it('rejects all unrecognized outcome/token shapes and forbidden terminal status codes', () => {
    const first = reserve(freshState());
    const invalidOutcomes: unknown[] = [
      { kind: 'success', result: 'secret' },
      { kind: 'unknown' },
      { kind: 'rate-limit' },
      { kind: 'rate-limit', retryAfterMs: -1 },
      { kind: 'rate-limit', retryAfterMs: 1.5 },
      { kind: 'terminal-non-success', statusCode: 299 },
      { kind: 'terminal-non-success', statusCode: 500 },
      { kind: 'terminal-non-success', statusCode: 401 },
      { kind: 'terminal-non-success', statusCode: 403 },
      { kind: 'terminal-non-success', statusCode: 429 },
      { kind: 'input-invalid', marker: 'x' },
    ];
    for (const outcome of invalidOutcomes) {
      expect(() => policy.applyOutcome({
        state: first.state, token: first.reservation, outcome: outcome as Outcome, now: JULY,
      })).toThrow('invalid-outcome');
    }
    expect(() => policy.applyOutcome({
      state: first.state,
      token: { ...first.reservation, marker: 'x' } as Reservation,
      outcome: { kind: 'success' },
      now: JULY,
    })).toThrow('invalid-reservation-token');
  });

  it('does not let late success clear auth-invalid, soft exhaustion, or quota exhaustion', () => {
    let authState = freshState();
    const authTokens: Reservation[] = [];
    for (let index = 0; index < 2; index += 1) {
      const result = reserve(authState);
      authState = result.state;
      authTokens.push(result.reservation);
    }
    authState = policy.applyOutcome({ state: authState, token: authTokens[1], outcome: { kind: 'auth-invalid' }, now: JULY });
    authState = policy.applyOutcome({ state: authState, token: authTokens[0], outcome: { kind: 'success' }, now: JULY });
    expect(authState.records[FP[0]]).toEqual(expect.objectContaining({ status: 'auth-invalid', successfulCalls: 1 }));

    let quotaState = freshState();
    const quotaTokens: Reservation[] = [];
    for (let index = 0; index < 2; index += 1) {
      const result = reserve(quotaState);
      quotaState = result.state;
      quotaTokens.push(result.reservation);
    }
    quotaState = policy.applyOutcome({ state: quotaState, token: quotaTokens[1], outcome: { kind: 'quota-exhausted' }, now: JULY });
    quotaState = policy.applyOutcome({ state: quotaState, token: quotaTokens[0], outcome: { kind: 'success' }, now: JULY });
    expect(quotaState.records[FP[0]]).toEqual(expect.objectContaining({ status: 'quota-exhausted', successfulCalls: 1 }));

    const softBase = freshState();
    softBase.records[FP[0]].attemptedCalls = 948;
    let softState = softBase;
    const beforeLimit = reserve(softState);
    softState = beforeLimit.state;
    const atLimit = reserve(softState);
    softState = policy.applyOutcome({ state: atLimit.state, token: beforeLimit.reservation, outcome: { kind: 'success' }, now: JULY });
    expect(softState.records[FP[0]]).toEqual(expect.objectContaining({ status: 'soft-exhausted', successfulCalls: 1 }));
  });

  it('keeps auth-invalid as highest priority and only extends cooldown deadlines', () => {
    let state = freshState();
    const tokens: Reservation[] = [];
    for (let index = 0; index < 6; index += 1) {
      const result = reserve(state);
      state = result.state;
      tokens.push(result.reservation);
    }
    state = policy.applyOutcome({ state, token: tokens[5], outcome: { kind: 'rate-limit', retryAfterMs: 60_000 }, now: JULY });
    expect(state.records[FP[0]].cooldownUntil).toBe('2026-07-15T00:01:00.000Z');
    state = policy.applyOutcome({
      state, token: tokens[4], outcome: { kind: 'rate-limit', retryAfterMs: 30_000 },
      now: new Date('2026-07-15T00:00:10.000Z'),
    });
    expect(state.records[FP[0]].cooldownUntil).toBe('2026-07-15T00:01:00.000Z');
    state = policy.applyOutcome({
      state, token: tokens[3], outcome: { kind: 'rate-limit', retryAfterMs: 120_000 },
      now: new Date('2026-07-15T00:00:20.000Z'),
    });
    expect(state.records[FP[0]].cooldownUntil).toBe('2026-07-15T00:02:20.000Z');
    state = policy.applyOutcome({ state, token: tokens[2], outcome: { kind: 'auth-invalid' }, now: JULY });
    state = policy.applyOutcome({ state, token: tokens[1], outcome: { kind: 'quota-exhausted' }, now: JULY });
    state = policy.applyOutcome({
      state, token: tokens[0], outcome: { kind: 'rate-limit', retryAfterMs: 600_000 }, now: JULY,
    });
    expect(state.records[FP[0]]).toEqual(expect.objectContaining({ status: 'auth-invalid', lastErrorClass: 'auth-invalid' }));
    expect(state.records[FP[0]].cooldownUntil).toBe('2026-07-15T00:10:00.000Z');
  });

  it.each<Outcome>([
    { kind: 'success' },
    { kind: 'transient' },
    { kind: 'input-invalid' },
    { kind: 'terminal-non-success', statusCode: 404 },
    { kind: 'quota-exhausted' },
  ])('settles previous-period $kind without changing current counts/status/errors', outcome => {
    const fixture = previousPeriodFixture();
    const settled = policy.applyOutcome({ state: fixture.state, token: fixture.token, outcome, now: AUGUST });
    expect(settled.records[FP[0]]).toEqual(expect.objectContaining({
      attemptedCalls: 0,
      successfulCalls: 0,
      status: 'healthy',
      lastErrorClass: null,
      lastErrorAt: null,
    }));
    expect(settled.records[FP[0]].settledAttempts).toEqual([{ periodId: '2026-07', attemptOrdinal: 1 }]);
  });

  it('applies previous-period auth invalidation and a trustworthy future rate-limit extension exactly once', () => {
    const authFixture = previousPeriodFixture();
    const reordered = policy.reconcileState({
      state: authFixture.state,
      identities: [
        { slot: 1, fingerprintSha256: FP[1] },
        { slot: 2, fingerprintSha256: FP[2] },
        { slot: 3, fingerprintSha256: FP[3] },
        { slot: 4, fingerprintSha256: FP[0] },
      ],
      timeZone: 'UTC',
      now: AUGUST,
    });
    const invalid = policy.applyOutcome({
      state: reordered, token: authFixture.token, outcome: { kind: 'auth-invalid' }, now: AUGUST,
    });
    expect(invalid.records[FP[0]].status).toBe('auth-invalid');
    expect(invalid.records[FP[1]].status).toBe('healthy');

    const rateFixture = previousPeriodFixture();
    const cooled = policy.applyOutcome({
      state: rateFixture.state,
      token: rateFixture.token,
      outcome: { kind: 'rate-limit', retryAfterMs: 60_000 },
      now: AUGUST,
    });
    expect(cooled.records[FP[0]]).toEqual(expect.objectContaining({
      status: 'cooldown', cooldownUntil: '2026-08-01T00:01:00.000Z',
    }));
    const duplicate = policy.applyOutcome({
      state: cooled,
      token: rateFixture.token,
      outcome: { kind: 'rate-limit', retryAfterMs: 120_000 },
      now: AUGUST,
    });
    expect(duplicate).toBe(cooled);

    const zeroFixture = previousPeriodFixture();
    const zeroRetry = policy.applyOutcome({
      state: zeroFixture.state,
      token: zeroFixture.token,
      outcome: { kind: 'rate-limit', retryAfterMs: 0 },
      now: AUGUST,
    });
    expect(zeroRetry.records[FP[0]]).toEqual(expect.objectContaining({
      status: 'healthy', cooldownUntil: null, lastErrorClass: null,
    }));
    expect(zeroRetry.records[FP[0]].settledAttempts).toEqual([{ periodId: '2026-07', attemptOrdinal: 1 }]);
  });

  it('fully ignores tokens older than the adjacent previous period without recording settlement', () => {
    const state = freshState(AUGUST);
    const olderToken: Reservation = {
      kind: 'keyed', periodId: '2026-06', slot: 1, fingerprintSha256: FP[0], attemptOrdinal: 1,
    };
    const result = policy.applyOutcome({ state, token: olderToken, outcome: { kind: 'auth-invalid' }, now: AUGUST });
    expect(result).toBe(state);
    expect(result.records[FP[0]].settledAttempts).toEqual([]);
  });

  it('creates a valid fail-closed state whose route is anonymous for the fixed fail-closed reason', () => {
    const state = policy.createFailClosedState({ identities: identities(), timeZone: 'UTC', now: JULY });
    expect(policy.validateStatePayload(state)).toBe(true);
    expect(policy.selectRoute(state, JULY)).toEqual({
      kind: 'anonymous', reason: 'state-unavailable-fail-closed',
    });
    expect(JSON.stringify(state)).not.toMatch(/CONTEXT7_API_KEY|fixture-secret|query|stderr|path/i);
  });
});
