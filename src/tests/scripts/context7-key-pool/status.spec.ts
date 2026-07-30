import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const policyPath = path.join(process.cwd(), 'scripts', 'context7-key-pool', 'policy.cjs');
const statusPath = path.join(process.cwd(), 'scripts', 'context7-key-pool', 'status.cjs');

const FP = ['a', 'b', 'c', 'd'].map(character => character.repeat(64));
const NOW = new Date('2026-07-15T00:00:00.000Z');
const identities = FP.map((fingerprintSha256, index) => ({ slot: index + 1, fingerprintSha256 }));

const policy = require(policyPath) as {
  reconcileState(args: {
    state: null;
    identities: Array<{ slot: number; fingerprintSha256: string }>;
    timeZone: string;
    now: Date;
  }): any;
  selectRoute(state: any, now: Date, options?: { excludeFingerprints?: string[] }): any;
  createFailClosedState(args: {
    identities: Array<{ slot: number; fingerprintSha256: string }>;
    timeZone: string;
    now: Date;
  }): any;
};
const { STATUS_TOOL, projectPublicStatus } = require(statusPath) as {
  STATUS_TOOL: unknown;
  projectPublicStatus(args: {
    state: any | null;
    health: 'uninitialized' | 'healthy' | 'recovered-replica' | 'fail-closed';
    activeRoute?: any;
    now: Date;
    reconciliation?: 'applied' | 'not-applied';
    runtime?: Record<string, unknown> | null;
  }): Record<string, unknown>;
};

function freshState(): any {
  return policy.reconcileState({ state: null, identities, timeZone: 'UTC', now: NOW });
}

describe('Context7 public status projection', () => {
  it('exports only STATUS_TOOL and projectPublicStatus with the exact descriptor', () => {
    expect(Object.keys(require(statusPath)).sort()).toEqual(['STATUS_TOOL', 'projectPublicStatus']);
    expect(STATUS_TOOL).toEqual({
      name: 'context7-pool-status',
      title: 'Context7 Pool Status',
      description: 'Returns redacted local Context7 pool status without consuming quota.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: {
        type: 'object',
        required: ['schemaVersion', 'mode', 'stateHealth', 'slots'],
        properties: {
          schemaVersion: { const: 1 },
          periodId: { type: 'string' },
          timeZone: { type: 'string' },
          nextResetAt: { type: 'string' },
          mode: { enum: ['keyed', 'anonymous', 'uninitialized', 'stored-unreconciled'] },
          activeSlot: { type: ['integer', 'null'] },
          anonymousReason: { type: ['string', 'null'] },
          stateHealth: { enum: ['uninitialized', 'healthy', 'recovered-replica', 'fail-closed'] },
          slots: { type: 'array' },
          runtime: { type: ['object', 'null'] },
          updatedAt: { type: 'string' },
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
  });

  it('projects sorted keyed slots with only 12-character fingerprints and no sensitive diagnostics', () => {
    const state = freshState();
    state.activeSlots.reverse();
    state.records[FP[0]].attemptedCalls = 9;
    state.records[FP[0]].successfulCalls = 7;
    const runtime = { childMode: 'keyed', generation: 3 };
    const output = projectPublicStatus({
      state,
      health: 'healthy',
      activeRoute: { kind: 'keyed', periodId: '2026-07', slot: 1, fingerprintSha256: FP[0] },
      now: NOW,
      runtime,
    });
    expect(output).toEqual(expect.objectContaining({
      schemaVersion: 1,
      periodId: '2026-07',
      timeZone: 'UTC',
      nextResetAt: '2026-08-01T00:00:00.000Z',
      mode: 'keyed',
      activeSlot: 1,
      anonymousReason: null,
      stateHealth: 'healthy',
      runtime,
      updatedAt: NOW.toISOString(),
    }));
    expect(output.runtime).toBe(runtime);
    expect(output.slots).toEqual([
      {
        slot: 1,
        fingerprintSha256_12: FP[0].slice(0, 12),
        attemptedCalls: 9,
        successfulCalls: 7,
        status: 'healthy',
        cooldownUntil: null,
        lastErrorClass: null,
      },
      ...[1, 2, 3].map(index => ({
        slot: index + 1,
        fingerprintSha256_12: FP[index].slice(0, 12),
        attemptedCalls: 0,
        successfulCalls: 0,
        status: 'healthy',
        cooldownUntil: null,
        lastErrorClass: null,
      })),
    ]);
    for (const slot of output.slots as Array<Record<string, unknown>>) {
      expect(Object.keys(slot).sort()).toEqual([
        'attemptedCalls', 'cooldownUntil', 'fingerprintSha256_12', 'lastErrorClass', 'slot', 'status', 'successfulCalls',
      ].sort());
    }
    const serialized = JSON.stringify(output);
    for (const fingerprint of FP) expect(serialized).not.toContain(fingerprint);
    expect(serialized).not.toMatch(/CONTEXT7_API_KEY|statePath|query|stderr|fixture-secret/i);
  });

  it('derives the active route when none is supplied and projects anonymous routing safely', () => {
    const state = freshState();
    expect(projectPublicStatus({ state, health: 'recovered-replica', now: NOW })).toEqual(
      expect.objectContaining({ mode: 'keyed', activeSlot: 1, stateHealth: 'recovered-replica' }),
    );
    const anonymous = projectPublicStatus({
      state,
      health: 'healthy',
      activeRoute: { kind: 'anonymous', reason: 'all-keyed-slots-unavailable' },
      now: NOW,
    });
    expect(anonymous).toEqual(expect.objectContaining({
      mode: 'anonymous', activeSlot: null, anonymousReason: 'all-keyed-slots-unavailable',
    }));
    expect(() => projectPublicStatus({
      state,
      health: 'healthy',
      activeRoute: { kind: 'anonymous', reason: 'query=fixture-secret' },
      now: NOW,
    })).toThrow('invalid-active-route');
  });

  it('projects uninitialized and unavailable fail-closed state without inventing slots', () => {
    expect(projectPublicStatus({ state: null, health: 'uninitialized', now: NOW })).toEqual({
      schemaVersion: 1,
      mode: 'uninitialized',
      activeSlot: null,
      anonymousReason: null,
      stateHealth: 'uninitialized',
      slots: [],
      runtime: null,
      updatedAt: NOW.toISOString(),
    });
    expect(projectPublicStatus({ state: null, health: 'fail-closed', now: NOW })).toEqual({
      schemaVersion: 1,
      mode: 'anonymous',
      activeSlot: null,
      anonymousReason: 'state-unavailable-fail-closed',
      stateHealth: 'fail-closed',
      slots: [],
      runtime: null,
      updatedAt: NOW.toISOString(),
    });
  });

  it('does not treat stored credentials as active before reconciliation is applied', () => {
    const state = freshState();
    const output = projectPublicStatus({
      state,
      health: 'healthy',
      activeRoute: policy.selectRoute(state, NOW),
      now: NOW,
      reconciliation: 'not-applied',
    });
    expect(output).toEqual(expect.objectContaining({
      mode: 'stored-unreconciled',
      activeSlot: null,
      anonymousReason: 'credentials-not-applied',
    }));
    expect(output.slots).toHaveLength(4);
  });

  it('projects an in-memory fail-closed state as anonymous with its fixed reason', () => {
    const state = policy.createFailClosedState({ identities, timeZone: 'UTC', now: NOW });
    const output = projectPublicStatus({ state, health: 'fail-closed', now: NOW });
    expect(output).toEqual(expect.objectContaining({
      mode: 'anonymous',
      activeSlot: null,
      anonymousReason: 'state-unavailable-fail-closed',
      stateHealth: 'fail-closed',
    }));
  });
});
