'use strict';

const {
  nextPeriodStartAt,
  selectRoute,
  validateStatePayload,
} = require('./policy.cjs');

const RUNTIME_STARTED_AT_PATTERN_SOURCE = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$';
const RUNTIME_STARTED_AT_PATTERN = new RegExp(RUNTIME_STARTED_AT_PATTERN_SOURCE);

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
            pattern: RUNTIME_STARTED_AT_PATTERN_SOURCE,
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
const RUNTIME_ANONYMOUS_REASON = 'outcome-persistence-failed';
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

function isEnumerableDataDescriptor(descriptor) {
  return descriptor !== undefined
    && descriptor.enumerable === true
    && Object.hasOwn(descriptor, 'value');
}

function healthStatusOf(health) {
  if (!health || typeof health !== 'object' || Array.isArray(health)) {
    throw new Error('invalid-state-health');
  }
  const prototype = Object.getPrototypeOf(health);
  const descriptors = Object.getOwnPropertyDescriptors(health);
  const keys = Reflect.ownKeys(descriptors);
  const statusDescriptor = descriptors.status;
  const reasonDescriptor = descriptors.reason;
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.length < 1
    || keys.length > 2
    || keys.some(key => typeof key !== 'string' || (key !== 'status' && key !== 'reason'))
    || !isEnumerableDataDescriptor(statusDescriptor)
    || (reasonDescriptor !== undefined && !isEnumerableDataDescriptor(reasonDescriptor))) {
    throw new Error('invalid-state-health');
  }
  const status = statusDescriptor.value;
  const reason = reasonDescriptor?.value;
  if (!HEALTH_VALUES.has(status)
    || (reasonDescriptor !== undefined && typeof reason !== 'string')) {
    throw new Error('invalid-state-health');
  }
  return status;
}

function projectPublicRuntime(runtime) {
  if (runtime === undefined || runtime === null) return null;
  if (typeof runtime !== 'object' || Array.isArray(runtime)) {
    throw new Error('invalid-public-runtime');
  }
  const prototype = Object.getPrototypeOf(runtime);
  const descriptors = Object.getOwnPropertyDescriptors(runtime);
  const keys = Reflect.ownKeys(descriptors);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.length !== RUNTIME_KEYS.length
    || keys.some(key => typeof key !== 'string' || !RUNTIME_KEYS.includes(key))
    || RUNTIME_KEYS.some(key => !isEnumerableDataDescriptor(descriptors[key]))) {
    throw new Error('invalid-public-runtime');
  }
  const instanceId_12 = descriptors.instanceId_12.value;
  const startedAt = descriptors.startedAt.value;
  const keyedDispatches = descriptors.keyedDispatches.value;
  const anonymousDispatches = descriptors.anonymousDispatches.value;
  if (typeof instanceId_12 !== 'string'
    || !RUNTIME_INSTANCE_ID.test(instanceId_12)
    || typeof startedAt !== 'string'
    || !isCanonicalIso(startedAt)
    || typeof keyedDispatches !== 'number'
    || !isPublicCounter(keyedDispatches)
    || typeof anonymousDispatches !== 'number'
    || !isPublicCounter(anonymousDispatches)) {
    throw new Error('invalid-public-runtime');
  }
  return {
    instanceId_12,
    startedAt,
    keyedDispatches,
    anonymousDispatches,
  };
}

function isCanonicalIso(value) {
  if (typeof value !== 'string' || !RUNTIME_STARTED_AT_PATTERN.test(value)) return false;
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
  const healthStatus = healthStatusOf(args.health);
  if (args.reconciliation !== undefined && !['applied', 'not-applied'].includes(args.reconciliation)) {
    throw new Error('invalid-reconciliation-state');
  }
  const now = validDate(args.now);
  const runtime = projectPublicRuntime(args.runtime);
  return { healthStatus, now, runtime };
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

function runtimeRouteProjection(route) {
  if (!route || typeof route !== 'object' || Array.isArray(route)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(route);
  const kindDescriptor = descriptors.kind;
  const reasonDescriptor = descriptors.reason;
  if (kindDescriptor?.value !== 'anonymous'
    || reasonDescriptor?.value !== RUNTIME_ANONYMOUS_REASON) return null;
  const prototype = Object.getPrototypeOf(route);
  const keys = Reflect.ownKeys(descriptors);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.length !== 2
    || keys.some(key => typeof key !== 'string' || (key !== 'kind' && key !== 'reason'))
    || !isEnumerableDataDescriptor(kindDescriptor)
    || !isEnumerableDataDescriptor(reasonDescriptor)) {
    throw new Error('invalid-active-route');
  }
  return { mode: 'anonymous', activeSlot: null, anonymousReason: RUNTIME_ANONYMOUS_REASON };
}

function routeProjection(route) {
  if (!route || typeof route !== 'object' || Array.isArray(route)) throw new Error('invalid-active-route');
  const runtimeRoute = runtimeRouteProjection(route);
  if (runtimeRoute) return runtimeRoute;
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
  const { healthStatus, now, runtime } = validateProjectionArguments(args);
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
  const reconciliationNotApplied = (args.reconciliation || 'applied') === 'not-applied';
  const projectedActiveRoute = args.activeRoute === undefined
    ? null
    : routeProjection(args.activeRoute);
  const route = reconciliationNotApplied
    && projectedActiveRoute?.anonymousReason !== RUNTIME_ANONYMOUS_REASON
    ? { mode: 'stored-unreconciled', activeSlot: null, anonymousReason: 'credentials-not-applied' }
    : (projectedActiveRoute || routeProjection(selectRoute(args.state, now)));
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
