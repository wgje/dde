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
    health: {
      status: 'uninitialized' | 'healthy' | 'recovered-replica' | 'fail-closed';
      reason?: string;
    };
    activeRoute?: any;
    now: Date;
    reconciliation?: 'applied' | 'not-applied';
    runtime?: {
      instanceId_12: string;
      startedAt: string;
      keyedDispatches: number;
      anonymousDispatches: number;
    } | null;
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
          runtime: {
            type: ['object', 'null'],
            properties: {
              instanceId_12: { type: 'string', pattern: '^[0-9a-f]{12}$' },
              startedAt: {
                type: 'string',
                format: 'date-time',
                pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
              },
              keyedDispatches: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
              anonymousDispatches: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            },
            required: ['instanceId_12', 'startedAt', 'keyedDispatches', 'anonymousDispatches'],
            additionalProperties: false,
          },
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
    const runtime = {
      instanceId_12: '12ab34cd56ef',
      startedAt: '2026-07-15T00:00:00.000Z',
      keyedDispatches: 3,
      anonymousDispatches: 1,
    };
    const output = projectPublicStatus({
      state,
      health: { status: 'healthy' },
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
    expect(output.runtime).toEqual(runtime);
    expect(output.runtime).not.toBe(runtime);
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
    expect(projectPublicStatus({ state, health: { status: 'recovered-replica' }, now: NOW })).toEqual(
      expect.objectContaining({ mode: 'keyed', activeSlot: 1, stateHealth: 'recovered-replica' }),
    );
    const anonymous = projectPublicStatus({
      state,
      health: { status: 'healthy' },
      activeRoute: { kind: 'anonymous', reason: 'all-keyed-slots-unavailable' },
      now: NOW,
    });
    expect(anonymous).toEqual(expect.objectContaining({
      mode: 'anonymous', activeSlot: null, anonymousReason: 'all-keyed-slots-unavailable',
    }));
    expect(() => projectPublicStatus({
      state,
      health: { status: 'healthy' },
      activeRoute: { kind: 'anonymous', reason: 'query=fixture-secret' },
      now: NOW,
    })).toThrow('invalid-active-route');
  });

  it('projects uninitialized and unavailable fail-closed state without inventing slots', () => {
    expect(projectPublicStatus({
      state: null,
      health: { status: 'uninitialized' },
      activeRoute: { kind: 'anonymous', reason: 'outcome-persistence-failed' },
      now: NOW,
    })).toEqual({
      schemaVersion: 1,
      mode: 'uninitialized',
      activeSlot: null,
      anonymousReason: null,
      stateHealth: 'uninitialized',
      slots: [],
      runtime: null,
      updatedAt: NOW.toISOString(),
    });
    expect(projectPublicStatus({
      state: null,
      health: { status: 'fail-closed', reason: 'primary-unavailable' },
      activeRoute: { kind: 'anonymous', reason: 'outcome-persistence-failed' },
      now: NOW,
    })).toEqual({
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
    for (const activeRoute of [
      undefined,
      policy.selectRoute(state, NOW),
      { kind: 'anonymous', reason: 'all-keyed-slots-unavailable' },
    ]) {
      const output = projectPublicStatus({
        state,
        health: { status: 'healthy' },
        ...(activeRoute ? { activeRoute } : {}),
        now: NOW,
        reconciliation: 'not-applied',
      });
      expect(output).toEqual(expect.objectContaining({
        mode: 'stored-unreconciled',
        activeSlot: null,
        anonymousReason: 'credentials-not-applied',
      }));
      expect(output.slots).toHaveLength(4);
    }
  });

  it('applies only an exact runtime persistence override before reconciliation', () => {
    const state = freshState();
    const output = projectPublicStatus({
      state,
      health: { status: 'healthy' },
      activeRoute: { kind: 'anonymous', reason: 'outcome-persistence-failed' },
      now: NOW,
      reconciliation: 'not-applied',
    });
    expect(output).toEqual(expect.objectContaining({
      mode: 'anonymous',
      activeSlot: null,
      anonymousReason: 'outcome-persistence-failed',
    }));

    for (const activeRoute of [
      { kind: 'anonymous', reason: 'outcome-persistence-failed', extra: 'forbidden' },
      { kind: 'anonymous', reason: 'other-internal-failure' },
    ]) {
      expect(() => projectPublicStatus({
        state,
        health: { status: 'healthy' },
        activeRoute,
        now: NOW,
        reconciliation: 'not-applied',
      })).toThrow('invalid-active-route');
    }
  });

  it('projects an in-memory fail-closed state as anonymous with its fixed reason', () => {
    const state = policy.createFailClosedState({ identities, timeZone: 'UTC', now: NOW });
    const output = projectPublicStatus({
      state,
      health: { status: 'fail-closed', reason: 'state-store-unavailable' },
      now: NOW,
    });
    expect(output).toEqual(expect.objectContaining({
      mode: 'anonymous',
      activeSlot: null,
      anonymousReason: 'state-unavailable-fail-closed',
      stateHealth: 'fail-closed',
    }));
  });

  it('accepts only store health snapshot objects and never projects their internal reason', () => {
    const state = freshState();
    const output = projectPublicStatus({
      state,
      health: { status: 'healthy', reason: 'recovered-from-private-replica' },
      now: NOW,
    });
    expect(output.stateHealth).toBe('healthy');
    expect(JSON.stringify(output)).not.toContain('recovered-from-private-replica');
    for (const health of [
      'healthy',
      [],
      {},
      { status: 'unknown' },
      { status: 'healthy', reason: 7 },
    ]) {
      expect(() => projectPublicStatus({ state, health, now: NOW } as any)).toThrow('invalid-state-health');
    }
  });

  it('rejects accessor-backed public snapshots without invoking their getters', () => {
    const state = freshState();
    let runtimeGetterCalls = 0;
    const runtime = {
      get instanceId_12(): string {
        runtimeGetterCalls += 1;
        return runtimeGetterCalls === 1 ? 'abcdef012345' : 'f'.repeat(64);
      },
      startedAt: '2026-07-15T00:00:00.000Z',
      keyedDispatches: 12,
      anonymousDispatches: 2,
    };
    expect.soft(() => projectPublicStatus({
      state,
      health: { status: 'healthy' },
      now: NOW,
      runtime,
    })).toThrow('invalid-public-runtime');
    expect.soft(runtimeGetterCalls).toBe(0);

    let healthGetterCalls = 0;
    const health = Object.defineProperty({}, 'status', {
      enumerable: true,
      configurable: true,
      get: () => {
        healthGetterCalls += 1;
        return healthGetterCalls === 1 ? 'healthy' : 'not-a-health-state';
      },
    });
    expect.soft(() => projectPublicStatus({ state, health, now: NOW } as any)).toThrow('invalid-state-health');
    expect.soft(healthGetterCalls).toBe(0);
  });

  it('projects only the exact public runtime shape into a fresh object', () => {
    const state = freshState();
    const runtime = {
      instanceId_12: 'abcdef012345',
      startedAt: '2026-07-15T00:00:00.000Z',
      keyedDispatches: 12,
      anonymousDispatches: 2,
    };
    const output = projectPublicStatus({ state, health: { status: 'healthy' }, now: NOW, runtime });
    expect(output.runtime).toEqual(runtime);
    expect(output.runtime).not.toBe(runtime);
    expect(Object.keys(output.runtime as object).sort()).toEqual(Object.keys(runtime).sort());
  });

  it('rejects coercive runtime identifiers and emits only JSON-safe descriptor values', () => {
    const state = freshState();
    const runtimeSchema = (STATUS_TOOL as {
      outputSchema: {
        properties: {
          runtime: {
            properties: {
              instanceId_12: { pattern: string };
              startedAt: { pattern: string };
              keyedDispatches: { minimum: number; maximum: number };
              anonymousDispatches: { minimum: number; maximum: number };
            };
          };
        };
      };
    }).outputSchema.properties.runtime;
    const validRuntime = {
      instanceId_12: 'abcdef012345',
      startedAt: '2026-07-15T00:00:00.000Z',
      keyedDispatches: 12,
      anonymousDispatches: 2,
    };
    const projectRuntime = (instanceId_12: unknown) => projectPublicStatus({
      state,
      health: { status: 'healthy' },
      now: NOW,
      runtime: { ...validRuntime, instanceId_12 },
    } as any);

    const validOutput = projectRuntime(validRuntime.instanceId_12);
    const serialized = JSON.stringify(validOutput);
    const projectedRuntime = validOutput.runtime as typeof validRuntime;
    expect(JSON.parse(serialized).runtime).toEqual(validRuntime);
    expect(typeof projectedRuntime.instanceId_12).toBe('string');
    expect(projectedRuntime.instanceId_12).toMatch(new RegExp(runtimeSchema.properties.instanceId_12.pattern));
    expect(typeof projectedRuntime.startedAt).toBe('string');
    expect(projectedRuntime.startedAt).toMatch(new RegExp(runtimeSchema.properties.startedAt.pattern));
    for (const counter of [projectedRuntime.keyedDispatches, projectedRuntime.anonymousDispatches]) {
      expect(typeof counter).toBe('number');
      expect(Number.isSafeInteger(counter)).toBe(true);
      expect(counter).toBeGreaterThanOrEqual(runtimeSchema.properties.keyedDispatches.minimum);
      expect(counter).toBeLessThanOrEqual(runtimeSchema.properties.keyedDispatches.maximum);
    }

    const coerciveObject = {
      syntheticPrivateField: 'synthetic-private-value',
      toString: () => validRuntime.instanceId_12,
    };
    for (const instanceId_12 of [123456789012, 123456789012n, coerciveObject]) {
      expect.soft(() => projectRuntime(instanceId_12)).toThrow('invalid-public-runtime');
    }
  });

  it('accepts runtime timestamps only when they match the descriptor pattern', () => {
    const state = freshState();
    const startedAtPatternSource = (STATUS_TOOL as {
      outputSchema: {
        properties: {
          runtime: { properties: { startedAt: { pattern: string } } };
        };
      };
    }).outputSchema.properties.runtime.properties.startedAt.pattern;
    const startedAtPattern = new RegExp(startedAtPatternSource);
    const validStartedAt = '2026-07-15T00:00:00.000Z';
    expect(validStartedAt).toMatch(startedAtPattern);

    const projectRuntime = (startedAt: string) => projectPublicStatus({
      state,
      health: { status: 'healthy' },
      now: NOW,
      runtime: {
        instanceId_12: 'abcdef012345',
        startedAt,
        keyedDispatches: 12,
        anonymousDispatches: 2,
      },
    }).runtime as { startedAt: string };

    const projectedRuntimes = [projectRuntime(validStartedAt)];
    for (const runtime of projectedRuntimes) {
      expect(runtime.startedAt).toMatch(startedAtPattern);
    }

    const extendedYear = '+010000-01-01T00:00:00.000Z';
    expect(new Date(extendedYear).toISOString()).toBe(extendedYear);
    expect(extendedYear).not.toMatch(startedAtPattern);
    expect(() => projectRuntime(extendedYear)).toThrow('invalid-public-runtime');
  });

  it('rejects non-public, malformed, cyclic, callable, and array runtime values', () => {
    const state = freshState();
    const validRuntime = {
      instanceId_12: 'abcdef012345',
      startedAt: '2026-07-15T00:00:00.000Z',
      keyedDispatches: 12,
      anonymousDispatches: 2,
    };
    const cyclic = { ...validRuntime } as Record<string, unknown>;
    cyclic.self = cyclic;
    const { anonymousDispatches: _omitted, ...missingField } = validRuntime;
    const invalidRuntimeValues: unknown[] = [
      {
        ...validRuntime,
        fullFingerprint: FP[0],
        path: 'private-state-path',
        query: 'private-query',
        stderr: 'private-stderr',
        CONTEXT7_API_KEY_1: 'synthetic-secret',
      },
      cyclic,
      () => validRuntime,
      [validRuntime],
      missingField,
      { ...validRuntime, instanceId_12: 'ABCDEF012345' },
      { ...validRuntime, instanceId_12: 'abcdef01234' },
      { ...validRuntime, startedAt: '2026-07-15T00:00:00Z' },
      { ...validRuntime, startedAt: 'not-a-date' },
      { ...validRuntime, keyedDispatches: -1 },
      { ...validRuntime, keyedDispatches: 1.5 },
      { ...validRuntime, keyedDispatches: Number.MAX_SAFE_INTEGER + 1 },
      { ...validRuntime, anonymousDispatches: '2' },
    ];
    for (const runtime of invalidRuntimeValues) {
      expect(() => projectPublicStatus({
        state,
        health: { status: 'healthy' },
        now: NOW,
        runtime,
      } as any)).toThrow('invalid-public-runtime');
    }
  });
});
