'use strict';

const {
  nextPeriodStartAt,
  selectRoute,
  validateStatePayload,
} = require('./policy.cjs');

const STATUS_TOOL = {
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
};

const HEALTH_VALUES = new Set(['uninitialized', 'healthy', 'recovered-replica', 'fail-closed']);
const ANONYMOUS_REASONS = new Set([
  'all-keyed-slots-unavailable',
  'state-unavailable-fail-closed',
]);
const RUNTIME_KEYS = [
  'instanceId_12',
  'startedAt',
  'keyedDispatches',
  'anonymousDispatches',
];
const RUNTIME_INSTANCE_ID = /^[0-9a-f]{12}$/;

function validDate(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('invalid-status-now');
  }
  return new Date(value.getTime());
}

function healthStatusOf(health) {
  if (!health || typeof health !== 'object' || Array.isArray(health)) {
    throw new Error('invalid-state-health');
  }
  const prototype = Object.getPrototypeOf(health);
  const keys = Object.keys(health);
  if ((prototype !== Object.prototype && prototype !== null)
    || !Object.hasOwn(health, 'status')
    || keys.some(key => key !== 'status' && key !== 'reason')
    || !HEALTH_VALUES.has(health.status)
    || (Object.hasOwn(health, 'reason') && typeof health.reason !== 'string')) {
    throw new Error('invalid-state-health');
  }
  return health.status;
}

function projectPublicRuntime(runtime) {
  if (runtime === undefined || runtime === null) return null;
  if (typeof runtime !== 'object' || Array.isArray(runtime)) {
    throw new Error('invalid-public-runtime');
  }
  const prototype = Object.getPrototypeOf(runtime);
  const keys = Object.keys(runtime).sort();
  const expectedKeys = [...RUNTIME_KEYS].sort();
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error('invalid-public-runtime');
  }
  if (!RUNTIME_INSTANCE_ID.test(runtime.instanceId_12)
    || !isCanonicalIso(runtime.startedAt)
    || !isPublicCounter(runtime.keyedDispatches)
    || !isPublicCounter(runtime.anonymousDispatches)) {
    throw new Error('invalid-public-runtime');
  }
  return {
    instanceId_12: runtime.instanceId_12,
    startedAt: runtime.startedAt,
    keyedDispatches: runtime.keyedDispatches,
    anonymousDispatches: runtime.anonymousDispatches,
  };
}

function isCanonicalIso(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isPublicCounter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateProjectionArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('invalid-status-arguments');
  }
  const allowed = new Set(['state', 'health', 'activeRoute', 'now', 'reconciliation', 'runtime']);
  if (Object.keys(args).some(key => !allowed.has(key))) throw new Error('invalid-status-arguments');
  healthStatusOf(args.health);
  if (args.reconciliation !== undefined && !['applied', 'not-applied'].includes(args.reconciliation)) {
    throw new Error('invalid-reconciliation-state');
  }
}

function publicSlots(state) {
  return [...state.activeSlots]
    .sort((left, right) => left.slot - right.slot)
    .map(identity => {
      const record = state.records[identity.fingerprintSha256];
      return {
        slot: identity.slot,
        fingerprintSha256_12: identity.fingerprintSha256.slice(0, 12),
        attemptedCalls: record.attemptedCalls,
        successfulCalls: record.successfulCalls,
        status: record.status,
        cooldownUntil: record.cooldownUntil,
        lastErrorClass: record.lastErrorClass,
      };
    });
}

function routeProjection(route) {
  if (!route || typeof route !== 'object' || Array.isArray(route)) throw new Error('invalid-active-route');
  if (route.kind === 'keyed') {
    if (!Number.isInteger(route.slot) || route.slot < 1 || route.slot > 4) {
      throw new Error('invalid-active-route');
    }
    return { mode: 'keyed', activeSlot: route.slot, anonymousReason: null };
  }
  if (route.kind === 'anonymous' && ANONYMOUS_REASONS.has(route.reason)) {
    return { mode: 'anonymous', activeSlot: null, anonymousReason: route.reason };
  }
  throw new Error('invalid-active-route');
}

function projectPublicStatus(args) {
  validateProjectionArguments(args);
  const now = validDate(args.now);
  const healthStatus = healthStatusOf(args.health);
  const runtime = projectPublicRuntime(args.runtime);
  if (args.state === null || args.state === undefined) {
    const failClosed = healthStatus === 'fail-closed';
    return {
      schemaVersion: 1,
      mode: failClosed ? 'anonymous' : 'uninitialized',
      activeSlot: null,
      anonymousReason: failClosed ? 'state-unavailable-fail-closed' : null,
      stateHealth: healthStatus,
      slots: [],
      runtime,
      updatedAt: now.toISOString(),
    };
  }
  validateStatePayload(args.state);
  const route = (args.reconciliation || 'applied') === 'not-applied'
    ? { mode: 'stored-unreconciled', activeSlot: null, anonymousReason: 'credentials-not-applied' }
    : routeProjection(args.activeRoute === undefined
      ? selectRoute(args.state, now)
      : args.activeRoute);
  return {
    schemaVersion: 1,
    periodId: args.state.periodId,
    timeZone: args.state.timeZone,
    nextResetAt: nextPeriodStartAt(args.state.periodId, args.state.timeZone).toISOString(),
    mode: route.mode,
    activeSlot: route.activeSlot,
    anonymousReason: route.anonymousReason,
    stateHealth: healthStatus,
    slots: publicSlots(args.state),
    runtime,
    updatedAt: args.state.updatedAt,
  };
}

module.exports = { STATUS_TOOL, projectPublicStatus };
