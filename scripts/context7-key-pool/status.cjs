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
};

const HEALTH_VALUES = new Set(['uninitialized', 'healthy', 'recovered-replica', 'fail-closed']);
const ANONYMOUS_REASONS = new Set([
  'all-keyed-slots-unavailable',
  'state-unavailable-fail-closed',
]);

function validDate(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('invalid-status-now');
  }
  return new Date(value.getTime());
}

function validateProjectionArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('invalid-status-arguments');
  }
  const allowed = new Set(['state', 'health', 'activeRoute', 'now', 'reconciliation', 'runtime']);
  if (Object.keys(args).some(key => !allowed.has(key))) throw new Error('invalid-status-arguments');
  if (!HEALTH_VALUES.has(args.health)) throw new Error('invalid-state-health');
  if (args.reconciliation !== undefined && !['applied', 'not-applied'].includes(args.reconciliation)) {
    throw new Error('invalid-reconciliation-state');
  }
  if (args.runtime !== undefined && args.runtime !== null
    && (typeof args.runtime !== 'object' || Array.isArray(args.runtime))) {
    throw new Error('invalid-public-runtime');
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
  const runtime = args.runtime === undefined ? null : args.runtime;
  if (args.state === null || args.state === undefined) {
    const failClosed = args.health === 'fail-closed';
    return {
      schemaVersion: 1,
      mode: failClosed ? 'anonymous' : 'uninitialized',
      activeSlot: null,
      anonymousReason: failClosed ? 'state-unavailable-fail-closed' : null,
      stateHealth: args.health,
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
    stateHealth: args.health,
    slots: publicSlots(args.state),
    runtime,
    updatedAt: args.state.updatedAt,
  };
}

module.exports = { STATUS_TOOL, projectPublicStatus };
