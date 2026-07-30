'use strict';

const SOFT_LIMIT = 950;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const PERIOD_ID = /^(\d{4})-(0[1-9]|1[0-2])$/;
const SAFE_REASON = /^(?:all-keyed-slots-unavailable|state-unavailable-fail-closed)$/;
const RECORD_STATUSES = new Set([
  'healthy',
  'soft-exhausted',
  'quota-exhausted',
  'auth-invalid',
  'cooldown',
]);
const SIMPLE_ERROR_CLASSES = new Set([
  'auth-invalid',
  'quota-exhausted',
  'rate-limit',
  'transient',
  'input-invalid',
]);
const PERIOD_BOUNDARY_WINDOW_MS = 72 * 60 * 60 * 1000;
const PERIOD_BOUNDARY_SEARCH_ITERATIONS = 32;
const STATE_KEYS = [
  'periodId',
  'timeZone',
  'records',
  'activeSlots',
  'anonymousMode',
  'updatedAt',
];
const RECORD_KEYS = [
  'fingerprintSha256',
  'attemptedCalls',
  'successfulCalls',
  'status',
  'cooldownUntil',
  'lastErrorClass',
  'lastErrorAt',
  'settledAttempts',
];

function fail(code) {
  throw new Error(code);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function assertExactKeys(value, expected, code) {
  if (!hasExactKeys(value, expected)) fail(code);
}

function dateFrom(value, code = 'invalid-date') {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail(code);
  return new Date(value.getTime());
}

function isIsoDate(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function parsePeriodId(periodId) {
  const match = typeof periodId === 'string' ? PERIOD_ID.exec(periodId) : null;
  if (!match) fail('invalid-period-id');
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 1 || year > 9998) fail('invalid-period-id');
  return { year, month };
}

function assertTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) fail('invalid-time-zone');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
  } catch {
    fail('invalid-time-zone');
  }
}

function dateTimeParts(date, timeZone, includeTime) {
  const options = {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  };
  if (includeTime) {
    options.hour = '2-digit';
    options.minute = '2-digit';
    options.second = '2-digit';
    options.hourCycle = 'h23';
  }
  const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(date);
  const result = {};
  for (const part of parts) {
    if (part.type !== 'literal') result[part.type] = Number(part.value);
  }
  return result;
}

function periodIdAt(now, timeZone) {
  const date = dateFrom(now);
  assertTimeZone(timeZone);
  const parts = dateTimeParts(date, timeZone, false);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}`;
}

function utcMonthApproximation(year, month) {
  const approximation = new Date(0);
  approximation.setUTCHours(0, 0, 0, 0);
  approximation.setUTCFullYear(year, month - 1, 1);
  return approximation.getTime();
}

function firstInstantOfPeriod(previousPeriod, targetPeriod, year, month, timeZone) {
  const approximationMs = utcMonthApproximation(year, month);
  let beforeMs = approximationMs - PERIOD_BOUNDARY_WINDOW_MS;
  let atOrAfterMs = approximationMs + PERIOD_BOUNDARY_WINDOW_MS;
  if (periodIdAt(new Date(beforeMs), timeZone) >= targetPeriod
    || periodIdAt(new Date(atOrAfterMs), timeZone) < targetPeriod) {
    fail('period-boundary-search-window');
  }
  for (let iteration = 0;
    iteration < PERIOD_BOUNDARY_SEARCH_ITERATIONS && atOrAfterMs - beforeMs > 1;
    iteration += 1) {
    const midpointMs = beforeMs + Math.floor((atOrAfterMs - beforeMs) / 2);
    if (periodIdAt(new Date(midpointMs), timeZone) < targetPeriod) beforeMs = midpointMs;
    else atOrAfterMs = midpointMs;
  }
  const candidate = new Date(atOrAfterMs);
  if (atOrAfterMs - beforeMs !== 1
    || periodIdAt(candidate, timeZone) !== targetPeriod
    || periodIdAt(new Date(atOrAfterMs - 1), timeZone) !== previousPeriod) {
    fail('period-boundary-search-failed');
  }
  return candidate;
}

function nextPeriodStartAt(periodId, timeZone) {
  const { year, month } = parsePeriodId(periodId);
  assertTimeZone(timeZone);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const targetPeriod = `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}`;
  return firstInstantOfPeriod(periodId, targetPeriod, nextYear, nextMonth, timeZone);
}

function previousPeriodId(periodId) {
  const { year, month } = parsePeriodId(periodId);
  const previousYear = month === 1 ? year - 1 : year;
  const previousMonth = month === 1 ? 12 : month - 1;
  if (previousYear < 1) fail('invalid-period-id');
  return `${String(previousYear).padStart(4, '0')}-${String(previousMonth).padStart(2, '0')}`;
}

function validateIdentityList(identities) {
  if (!Array.isArray(identities) || identities.length > 4) fail('invalid-identities');
  const slots = new Set();
  const fingerprints = new Set();
  const normalized = identities.map(identity => {
    assertExactKeys(identity, ['slot', 'fingerprintSha256'], 'invalid-identity');
    if (!Number.isInteger(identity.slot) || identity.slot < 1 || identity.slot > 4) fail('invalid-identity-slot');
    if (!FINGERPRINT.test(identity.fingerprintSha256)) fail('invalid-identity-fingerprint');
    if (slots.has(identity.slot)) fail('duplicate-identity-slot');
    if (fingerprints.has(identity.fingerprintSha256)) fail('duplicate-identity-fingerprint');
    slots.add(identity.slot);
    fingerprints.add(identity.fingerprintSha256);
    return { slot: identity.slot, fingerprintSha256: identity.fingerprintSha256 };
  });
  return normalized.sort((left, right) => left.slot - right.slot);
}

function isAllowedErrorClass(value) {
  if (SIMPLE_ERROR_CLASSES.has(value)) return true;
  const match = /^upstream-http-terminal-(\d{3})$/.exec(value);
  if (!match) return false;
  const statusCode = Number(match[1]);
  return statusCode >= 300 && statusCode <= 499 && ![401, 403, 429].includes(statusCode);
}

function validateStatePayload(state) {
  assertExactKeys(state, STATE_KEYS, 'invalid-state-shape');
  parsePeriodId(state.periodId);
  assertTimeZone(state.timeZone);
  if (!isPlainObject(state.records)) fail('invalid-state-records');
  const allowedSettlementPeriods = new Set([state.periodId, previousPeriodId(state.periodId)]);
  for (const [fingerprint, record] of Object.entries(state.records)) {
    if (!FINGERPRINT.test(fingerprint)) fail('invalid-record-key');
    assertExactKeys(record, RECORD_KEYS, 'invalid-record-shape');
    if (record.fingerprintSha256 !== fingerprint) fail('record-fingerprint-mismatch');
    if (!Number.isInteger(record.attemptedCalls)
      || record.attemptedCalls < 0 || record.attemptedCalls > SOFT_LIMIT) {
      fail('invalid-attempted-calls');
    }
    if (!Number.isInteger(record.successfulCalls)
      || record.successfulCalls < 0 || record.successfulCalls > record.attemptedCalls) {
      fail('invalid-successful-calls');
    }
    if (!RECORD_STATUSES.has(record.status)) fail('invalid-record-status');
    if (record.status === 'soft-exhausted' && record.attemptedCalls !== SOFT_LIMIT) {
      fail('invalid-soft-exhausted-count');
    }
    if (record.status === 'healthy' && record.attemptedCalls === SOFT_LIMIT) {
      fail('invalid-healthy-soft-limit');
    }
    if (record.cooldownUntil !== null && !isIsoDate(record.cooldownUntil)) fail('invalid-cooldown-until');
    if (record.status === 'cooldown' && record.cooldownUntil === null) fail('missing-cooldown-until');
    if (record.lastErrorClass === null) {
      if (record.lastErrorAt !== null) fail('invalid-last-error-pair');
    } else {
      if (typeof record.lastErrorClass !== 'string' || !isAllowedErrorClass(record.lastErrorClass)) {
        fail('invalid-last-error-class');
      }
      if (!isIsoDate(record.lastErrorAt)) fail('invalid-last-error-at');
    }
    if (!Array.isArray(record.settledAttempts)) fail('invalid-settled-attempts');
    const pairs = new Set();
    for (const settlement of record.settledAttempts) {
      assertExactKeys(settlement, ['periodId', 'attemptOrdinal'], 'invalid-settlement-shape');
      parsePeriodId(settlement.periodId);
      if (!allowedSettlementPeriods.has(settlement.periodId)) fail('settlement-outside-retention-window');
      if (!Number.isInteger(settlement.attemptOrdinal)
        || settlement.attemptOrdinal < 1 || settlement.attemptOrdinal > SOFT_LIMIT) {
        fail('invalid-settlement-ordinal');
      }
      if (settlement.periodId === state.periodId && settlement.attemptOrdinal > record.attemptedCalls) {
        fail('settlement-exceeds-attempted-calls');
      }
      const pair = `${settlement.periodId}:${settlement.attemptOrdinal}`;
      if (pairs.has(pair)) fail('duplicate-settlement');
      pairs.add(pair);
    }
  }
  const activeSlots = validateIdentityList(state.activeSlots);
  for (const identity of activeSlots) {
    if (!Object.hasOwn(state.records, identity.fingerprintSha256)) fail('active-fingerprint-missing-record');
  }
  assertExactKeys(state.anonymousMode, ['active', 'reason', 'since'], 'invalid-anonymous-mode');
  if (typeof state.anonymousMode.active !== 'boolean') fail('invalid-anonymous-active');
  if (state.anonymousMode.active) {
    if (typeof state.anonymousMode.reason !== 'string' || !SAFE_REASON.test(state.anonymousMode.reason)) {
      fail('invalid-anonymous-reason');
    }
    if (!isIsoDate(state.anonymousMode.since)) fail('invalid-anonymous-since');
  } else if (state.anonymousMode.reason !== null || state.anonymousMode.since !== null) {
    fail('invalid-inactive-anonymous-mode');
  }
  if (!isIsoDate(state.updatedAt)) fail('invalid-updated-at');
  return true;
}

function newRecord(fingerprintSha256) {
  return {
    fingerprintSha256,
    attemptedCalls: 0,
    successfulCalls: 0,
    status: 'healthy',
    cooldownUntil: null,
    lastErrorClass: null,
    lastErrorAt: null,
    settledAttempts: [],
  };
}

function cloneRecord(record) {
  return {
    fingerprintSha256: record.fingerprintSha256,
    attemptedCalls: record.attemptedCalls,
    successfulCalls: record.successfulCalls,
    status: record.status,
    cooldownUntil: record.cooldownUntil,
    lastErrorClass: record.lastErrorClass,
    lastErrorAt: record.lastErrorAt,
    settledAttempts: record.settledAttempts.map(settlement => ({ ...settlement })),
  };
}

function cloneState(state) {
  const records = {};
  for (const [fingerprint, record] of Object.entries(state.records)) {
    records[fingerprint] = cloneRecord(record);
  }
  return {
    periodId: state.periodId,
    timeZone: state.timeZone,
    records,
    activeSlots: state.activeSlots.map(identity => ({ ...identity })),
    anonymousMode: { ...state.anonymousMode },
    updatedAt: state.updatedAt,
  };
}

function reconcileRecord(record, retainedPeriodId, advanced, nowMs) {
  const reconciled = cloneRecord(record);
  const previous = previousPeriodId(retainedPeriodId);
  reconciled.settledAttempts = reconciled.settledAttempts.filter(
    settlement => settlement.periodId === retainedPeriodId || settlement.periodId === previous,
  );
  const futureCooldown = reconciled.cooldownUntil !== null
    && new Date(reconciled.cooldownUntil).getTime() > nowMs;
  if (advanced) {
    reconciled.attemptedCalls = 0;
    reconciled.successfulCalls = 0;
    if (reconciled.status === 'auth-invalid') {
      if (!futureCooldown) reconciled.cooldownUntil = null;
    } else if (futureCooldown) {
      reconciled.status = 'cooldown';
    } else {
      reconciled.status = 'healthy';
      reconciled.cooldownUntil = null;
    }
  } else if (!futureCooldown && reconciled.cooldownUntil !== null) {
    reconciled.cooldownUntil = null;
    if (reconciled.status === 'cooldown') reconciled.status = 'healthy';
  }
  return reconciled;
}

function reconcileState(args) {
  assertExactKeys(args, ['state', 'identities', 'timeZone', 'now'], 'invalid-reconcile-arguments');
  const now = dateFrom(args.now);
  const activeSlots = validateIdentityList(args.identities);
  const candidatePeriodId = periodIdAt(now, args.timeZone);
  if (args.state === null) {
    const records = {};
    for (const identity of activeSlots) records[identity.fingerprintSha256] = newRecord(identity.fingerprintSha256);
    const initial = {
      periodId: candidatePeriodId,
      timeZone: args.timeZone,
      records,
      activeSlots,
      anonymousMode: { active: false, reason: null, since: null },
      updatedAt: now.toISOString(),
    };
    validateStatePayload(initial);
    return initial;
  }
  validateStatePayload(args.state);
  const advanced = candidatePeriodId > args.state.periodId;
  const rolledBack = candidatePeriodId < args.state.periodId;
  const retainedPeriodId = advanced ? candidatePeriodId : args.state.periodId;
  const timeZone = rolledBack ? args.state.timeZone : args.timeZone;
  const records = {};
  for (const [fingerprint, record] of Object.entries(args.state.records)) {
    records[fingerprint] = reconcileRecord(record, retainedPeriodId, advanced, now.getTime());
  }
  for (const identity of activeSlots) {
    if (!Object.hasOwn(records, identity.fingerprintSha256)) {
      records[identity.fingerprintSha256] = newRecord(identity.fingerprintSha256);
    }
  }
  const reconciled = {
    periodId: retainedPeriodId,
    timeZone,
    records,
    activeSlots,
    anonymousMode: { ...args.state.anonymousMode },
    updatedAt: now.toISOString(),
  };
  validateStatePayload(reconciled);
  return reconciled;
}

function recordIsEligible(record, nowMs) {
  if (record.attemptedCalls >= SOFT_LIMIT) return false;
  if (record.status === 'auth-invalid'
    || record.status === 'quota-exhausted'
    || record.status === 'soft-exhausted') return false;
  if (record.cooldownUntil !== null && new Date(record.cooldownUntil).getTime() > nowMs) return false;
  return true;
}

function selectRoute(state, nowValue, options = {}) {
  validateStatePayload(state);
  const now = dateFrom(nowValue);
  if (!isPlainObject(options)
    || Object.keys(options).some(key => key !== 'excludeFingerprints')) fail('invalid-route-options');
  const excludedValues = options.excludeFingerprints === undefined ? [] : options.excludeFingerprints;
  if (!Array.isArray(excludedValues) || excludedValues.some(value => !FINGERPRINT.test(value))) {
    fail('invalid-excluded-fingerprints');
  }
  const excluded = new Set(excludedValues);
  for (const identity of [...state.activeSlots].sort((left, right) => left.slot - right.slot)) {
    if (excluded.has(identity.fingerprintSha256)) continue;
    const record = state.records[identity.fingerprintSha256];
    if (recordIsEligible(record, now.getTime())) {
      return {
        kind: 'keyed',
        periodId: state.periodId,
        slot: identity.slot,
        fingerprintSha256: identity.fingerprintSha256,
      };
    }
  }
  const reason = state.anonymousMode.active
    ? state.anonymousMode.reason
    : 'all-keyed-slots-unavailable';
  return { kind: 'anonymous', reason };
}

function validateKeyedRoute(route) {
  assertExactKeys(route, ['kind', 'periodId', 'slot', 'fingerprintSha256'], 'invalid-keyed-route');
  if (route.kind !== 'keyed') fail('invalid-keyed-route');
  parsePeriodId(route.periodId);
  if (!Number.isInteger(route.slot) || route.slot < 1 || route.slot > 4) fail('invalid-keyed-route');
  if (!FINGERPRINT.test(route.fingerprintSha256)) fail('invalid-keyed-route');
}

function reserveRoute(args) {
  assertExactKeys(args, ['state', 'route', 'now'], 'invalid-reserve-arguments');
  validateStatePayload(args.state);
  const now = dateFrom(args.now);
  validateKeyedRoute(args.route);
  const identity = args.state.activeSlots.find(candidate => candidate.slot === args.route.slot);
  const record = args.state.records[args.route.fingerprintSha256];
  if (args.route.periodId !== args.state.periodId
    || !identity
    || identity.fingerprintSha256 !== args.route.fingerprintSha256
    || !record
    || !recordIsEligible(record, now.getTime())) {
    fail('route-not-eligible');
  }
  const state = cloneState(args.state);
  const nextRecord = state.records[args.route.fingerprintSha256];
  if (nextRecord.status === 'cooldown') {
    nextRecord.status = 'healthy';
    nextRecord.cooldownUntil = null;
  }
  nextRecord.attemptedCalls += 1;
  if (nextRecord.attemptedCalls === SOFT_LIMIT) nextRecord.status = 'soft-exhausted';
  state.anonymousMode = { active: false, reason: null, since: null };
  state.updatedAt = now.toISOString();
  const reservation = {
    kind: 'keyed',
    periodId: state.periodId,
    slot: identity.slot,
    fingerprintSha256: identity.fingerprintSha256,
    attemptOrdinal: nextRecord.attemptedCalls,
  };
  validateStatePayload(state);
  return { state, reservation };
}

function validateReservationToken(token) {
  const requiredKeys = ['kind', 'periodId', 'slot', 'fingerprintSha256', 'attemptOrdinal'];
  const allowedKeys = new Set([...requiredKeys, 'stateRevision']);
  if (!isPlainObject(token)
    || requiredKeys.some(key => !Object.hasOwn(token, key))
    || Object.keys(token).some(key => !allowedKeys.has(key))
    || token.kind !== 'keyed') fail('invalid-reservation-token');
  try {
    parsePeriodId(token.periodId);
  } catch {
    fail('invalid-reservation-token');
  }
  if (!Number.isInteger(token.slot) || token.slot < 1 || token.slot > 4
    || !FINGERPRINT.test(token.fingerprintSha256)
    || !Number.isInteger(token.attemptOrdinal)
    || token.attemptOrdinal < 1 || token.attemptOrdinal > SOFT_LIMIT) {
    fail('invalid-reservation-token');
  }
}

function validateOutcome(outcome) {
  if (!isPlainObject(outcome) || typeof outcome.kind !== 'string') fail('invalid-outcome');
  const simpleKinds = new Set(['success', 'auth-invalid', 'quota-exhausted', 'transient', 'input-invalid']);
  if (simpleKinds.has(outcome.kind)) {
    if (!hasExactKeys(outcome, ['kind'])) fail('invalid-outcome');
    return;
  }
  if (outcome.kind === 'rate-limit') {
    if (!hasExactKeys(outcome, ['kind', 'retryAfterMs'])
      || !Number.isSafeInteger(outcome.retryAfterMs) || outcome.retryAfterMs < 0) fail('invalid-outcome');
    return;
  }
  if (outcome.kind === 'terminal-non-success') {
    if (!hasExactKeys(outcome, ['kind', 'statusCode'])
      || !Number.isInteger(outcome.statusCode)
      || outcome.statusCode < 300 || outcome.statusCode > 499
      || [401, 403, 429].includes(outcome.statusCode)) fail('invalid-outcome');
    return;
  }
  fail('invalid-outcome');
}

function setError(record, errorClass, now) {
  if (record.status === 'auth-invalid' && errorClass !== 'auth-invalid') return;
  record.lastErrorClass = errorClass;
  record.lastErrorAt = now.toISOString();
}

function applyCooldown(record, retryAfterMs, now, isPreviousPeriod) {
  const candidateMs = now.getTime() + retryAfterMs;
  if (!Number.isFinite(candidateMs) || candidateMs > 8_640_000_000_000_000) fail('invalid-outcome');
  const existingMs = record.cooldownUntil === null
    ? Number.NEGATIVE_INFINITY
    : new Date(record.cooldownUntil).getTime();
  const extendsFuture = candidateMs > now.getTime() && candidateMs > existingMs;
  if (!extendsFuture) {
    if (!isPreviousPeriod) setError(record, 'rate-limit', now);
    return;
  }
  record.cooldownUntil = new Date(candidateMs).toISOString();
  if (!['auth-invalid', 'quota-exhausted', 'soft-exhausted'].includes(record.status)) {
    record.status = 'cooldown';
  }
  setError(record, 'rate-limit', now);
}

function settleCurrentOutcome(record, outcome, now) {
  if (outcome.kind === 'success') {
    if (record.successfulCalls >= record.attemptedCalls) fail('successful-calls-overflow');
    record.successfulCalls += 1;
    return;
  }
  if (outcome.kind === 'auth-invalid') {
    record.status = 'auth-invalid';
    setError(record, 'auth-invalid', now);
    return;
  }
  if (outcome.kind === 'quota-exhausted') {
    if (record.status !== 'auth-invalid') {
      record.status = 'quota-exhausted';
      setError(record, 'quota-exhausted', now);
    }
    return;
  }
  if (outcome.kind === 'rate-limit') {
    applyCooldown(record, outcome.retryAfterMs, now, false);
    return;
  }
  if (outcome.kind === 'terminal-non-success') {
    setError(record, `upstream-http-terminal-${outcome.statusCode}`, now);
    return;
  }
  setError(record, outcome.kind, now);
}

function applyOutcome(args) {
  assertExactKeys(args, ['state', 'token', 'outcome', 'now'], 'invalid-outcome-arguments');
  validateStatePayload(args.state);
  const now = dateFrom(args.now);
  validateReservationToken(args.token);
  validateOutcome(args.outcome);
  const previous = previousPeriodId(args.state.periodId);
  if (args.token.periodId < previous) return args.state;
  if (args.token.periodId > args.state.periodId || (args.token.periodId < args.state.periodId
    && args.token.periodId !== previous)) fail('token-period-not-retained');
  const currentPeriod = args.token.periodId === args.state.periodId;
  const sourceRecord = args.state.records[args.token.fingerprintSha256];
  if (!sourceRecord) fail('token-fingerprint-not-retained');
  const duplicate = sourceRecord.settledAttempts.some(
    settlement => settlement.periodId === args.token.periodId
      && settlement.attemptOrdinal === args.token.attemptOrdinal,
  );
  if (duplicate) return args.state;
  if (currentPeriod && args.token.attemptOrdinal > sourceRecord.attemptedCalls) {
    fail('token-attempt-not-reserved');
  }
  const state = cloneState(args.state);
  const record = state.records[args.token.fingerprintSha256];
  record.settledAttempts.push({
    periodId: args.token.periodId,
    attemptOrdinal: args.token.attemptOrdinal,
  });
  record.settledAttempts.sort((left, right) => (
    left.periodId.localeCompare(right.periodId) || left.attemptOrdinal - right.attemptOrdinal
  ));
  if (currentPeriod) {
    settleCurrentOutcome(record, args.outcome, now);
  } else if (args.outcome.kind === 'auth-invalid') {
    record.status = 'auth-invalid';
    setError(record, 'auth-invalid', now);
  } else if (args.outcome.kind === 'rate-limit') {
    applyCooldown(record, args.outcome.retryAfterMs, now, true);
  }
  state.updatedAt = now.toISOString();
  validateStatePayload(state);
  return state;
}

function markAnonymous(args) {
  assertExactKeys(args, ['state', 'reason', 'now'], 'invalid-mark-anonymous-arguments');
  validateStatePayload(args.state);
  const now = dateFrom(args.now);
  if (typeof args.reason !== 'string' || !SAFE_REASON.test(args.reason)) fail('invalid-anonymous-reason');
  const state = cloneState(args.state);
  const since = state.anonymousMode.active && state.anonymousMode.reason === args.reason
    ? state.anonymousMode.since
    : now.toISOString();
  state.anonymousMode = { active: true, reason: args.reason, since };
  state.updatedAt = now.toISOString();
  validateStatePayload(state);
  return state;
}

function clearAnonymous(args) {
  assertExactKeys(args, ['state', 'now'], 'invalid-clear-anonymous-arguments');
  validateStatePayload(args.state);
  const now = dateFrom(args.now);
  const state = cloneState(args.state);
  state.anonymousMode = { active: false, reason: null, since: null };
  state.updatedAt = now.toISOString();
  validateStatePayload(state);
  return state;
}

function createFailClosedState(args) {
  assertExactKeys(args, ['identities', 'timeZone', 'now'], 'invalid-fail-closed-arguments');
  const state = reconcileState({
    state: null,
    identities: args.identities,
    timeZone: args.timeZone,
    now: args.now,
  });
  for (const record of Object.values(state.records)) {
    record.status = 'cooldown';
    record.cooldownUntil = '9999-12-31T23:59:59.999Z';
  }
  state.anonymousMode = {
    active: true,
    reason: 'state-unavailable-fail-closed',
    since: dateFrom(args.now).toISOString(),
  };
  validateStatePayload(state);
  return state;
}

module.exports = {
  SOFT_LIMIT,
  periodIdAt,
  nextPeriodStartAt,
  validateStatePayload,
  reconcileState,
  selectRoute,
  reserveRoute,
  applyOutcome,
  markAnonymous,
  clearAnonymous,
  createFailClosedState,
};
