'use strict';

const crypto = require('node:crypto');

const OFFICIAL_ARGUMENTS = Object.freeze({
  'resolve-library-id': Object.freeze(['libraryName', 'query']),
  'query-docs': Object.freeze(['libraryId', 'query']),
});
const TRANSIENT_NODE_CODES = new Set([
  'EPIPE',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'MCP_CONNECTION_CLOSED',
  'MCP_REQUEST_TIMEOUT',
]);
const TRANSIENT_ERROR_NAMES = new Set([
  'AbortError',
  'TimeoutError',
  'RequestTimeoutError',
  'ConnectionClosedError',
  'ChildProcessError',
]);
const MAX_TRANSIENT_DISPATCHES = 3;
const MAX_DISPATCHES = 9;
const MAX_FAILURE_BYTES = 4096;
const CLOSE_TIMEOUT_MS = 5000;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const PERIOD_ID = /^(\d{4})-(0[1-9]|1[0-2])$/;
const STORE_ANONYMOUS_REASONS = new Set([
  'all-keyed-slots-unavailable',
  'state-unavailable-fail-closed',
]);
const INTERNAL_ANONYMOUS_REASON = 'outcome-persistence-failed';

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function safeRedact(value, redact) {
  if (typeof redact !== 'function') return { redaction: 'unavailable' };
  let redacted;
  try {
    redacted = redact(value);
  } catch {
    redacted = { redaction: 'failed' };
  }
  try {
    const serialized = JSON.stringify(redacted);
    if (Buffer.byteLength(serialized ?? '', 'utf8') <= MAX_FAILURE_BYTES - 256) return redacted;
  } catch {
    return { redaction: 'failed' };
  }
  return { truncated: true };
}

class Context7PoolError extends Error {
  constructor(kind, details, redact) {
    super(`context7-pool-${kind}`);
    this.name = 'Context7PoolError';
    this.kind = kind;
    if (details !== undefined) this.details = safeRedact(details, redact);
  }
}

function validateOfficialToolArguments(name, args) {
  const required = OFFICIAL_ARGUMENTS[name];
  if (!required || !exactKeys(args, required)) throw new Context7PoolError('input-invalid');
  for (const field of required) {
    if (typeof args[field] !== 'string' || !args[field] || args[field] !== args[field].trim()) {
      throw new Context7PoolError('input-invalid');
    }
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function canonicalToolSignature(tools) {
  if (!Array.isArray(tools)) throw new Context7PoolError('schema-invalid');
  const complete = tools.map(canonicalize).sort((left, right) => {
    const leftName = typeof left?.name === 'string' ? left.name : '';
    const rightName = typeof right?.name === 'string' ? right.name : '';
    return leftName.localeCompare(rightName);
  });
  return JSON.stringify(complete);
}

function trustedFailureEvidence(value) {
  if (!exactKeys(value, ['kind', 'status', 'retryAfterSeconds'])) return null;
  if (value.kind === 'http') {
    if (!Number.isInteger(value.status) || value.status < 100 || value.status > 599) return null;
    if (value.retryAfterSeconds !== null
      && (!Number.isInteger(value.retryAfterSeconds)
        || value.retryAfterSeconds < 1
        || value.retryAfterSeconds > 86400)) return null;
    return value;
  }
  if ((value.kind === 'transport' || value.kind === 'observer-internal')
    && value.status === null
    && value.retryAfterSeconds === null) return value;
  return null;
}

function classifyToolResult({ result, failureEvidence }) {
  const evidence = trustedFailureEvidence(failureEvidence);
  if (evidence?.kind === 'transport' || evidence?.kind === 'observer-internal') {
    return { kind: 'transient' };
  }
  if (evidence?.kind === 'http') {
    if (evidence.status >= 200 && evidence.status <= 299) return null;
    if (evidence.status === 401 || evidence.status === 403) return { kind: 'auth-invalid' };
    if (evidence.status === 429) {
      if (evidence.retryAfterSeconds !== null) {
        return { kind: 'rate-limit', retryAfterMs: evidence.retryAfterSeconds * 1000 };
      }
      return { kind: 'quota-exhausted' };
    }
    if (evidence.status >= 500) return { kind: 'transient' };
    return { kind: 'terminal-non-success', statusCode: evidence.status };
  }
  if (isPlainObject(result) && result.isError === true) return { kind: 'transient' };
  return null;
}

function classifyThrownError(error) {
  if (isPlainObject(error) || error instanceof Error) {
    if (error.code === -32602) return { kind: 'input-invalid' };
    if (TRANSIENT_NODE_CODES.has(error.code) || TRANSIENT_ERROR_NAMES.has(error.name)) {
      return { kind: 'transient' };
    }
  }
  return { kind: 'transient' };
}

function outcomeForClassification(classification) {
  if (classification === null) return { kind: 'success' };
  switch (classification?.kind) {
    case 'auth-invalid': return { kind: 'auth-invalid' };
    case 'rate-limit': return { kind: 'rate-limit', retryAfterMs: classification.retryAfterMs };
    case 'quota-exhausted': return { kind: 'quota-exhausted' };
    case 'terminal-non-success': return { kind: 'terminal-non-success', statusCode: classification.statusCode };
    case 'transient': return { kind: 'transient' };
    case 'input-invalid': return { kind: 'input-invalid' };
    default: throw new Context7PoolError('classification-invalid');
  }
}

function fixedFailure(kind) {
  return { content: [{ type: 'text', text: `context7-pool-${kind}` }], isError: true };
}

function routeIdentity(route) {
  if (!isPlainObject(route)) throw new Context7PoolError('route-invalid');
  if (route.kind === 'keyed') return `keyed:${route.periodId}:${route.slot}:${route.fingerprintSha256}`;
  if (route.kind === 'anonymous') return `anonymous:${route.reason}`;
  throw new Context7PoolError('route-invalid');
}

function validPeriodId(value) {
  const match = typeof value === 'string' ? PERIOD_ID.exec(value) : null;
  if (!match) return false;
  const year = Number(match[1]);
  return year >= 1 && year <= 9998;
}

function validKeyedRoute(route) {
  return exactKeys(route, ['kind', 'periodId', 'slot', 'fingerprintSha256'])
    && route.kind === 'keyed'
    && validPeriodId(route.periodId)
    && Number.isSafeInteger(route.slot)
    && route.slot >= 1
    && route.slot <= 4
    && FINGERPRINT.test(route.fingerprintSha256);
}

function validKeyedReservation(reserved, prepared) {
  if (!isPlainObject(reserved)
    || reserved.kind !== 'keyed'
    || !validKeyedRoute(reserved.route)
    || !exactKeys(reserved.token, [
      'kind',
      'periodId',
      'slot',
      'fingerprintSha256',
      'attemptOrdinal',
      'stateRevision',
    ])) return false;
  const token = reserved.token;
  return token.kind === 'keyed'
    && validPeriodId(token.periodId)
    && token.periodId === reserved.route.periodId
    && token.slot === reserved.route.slot
    && token.fingerprintSha256 === reserved.route.fingerprintSha256
    && FINGERPRINT.test(token.fingerprintSha256)
    && Number.isSafeInteger(token.attemptOrdinal)
    && token.attemptOrdinal > 0
    && Number.isSafeInteger(token.stateRevision)
    && token.stateRevision >= 0
    && routeIdentity(reserved.route) === prepared.identity;
}

function validAnonymousRoute(route, allowInternal = false) {
  return exactKeys(route, ['kind', 'reason'])
    && route.kind === 'anonymous'
    && (STORE_ANONYMOUS_REASONS.has(route.reason)
      || (allowInternal && route.reason === INTERNAL_ANONYMOUS_REASON));
}

function validAnonymousReservation(reserved) {
  return isPlainObject(reserved)
    && reserved.kind === 'anonymous'
    && validAnonymousRoute(reserved.route)
    && Object.hasOwn(reserved, 'token')
    && reserved.token === null;
}

function createPoolRuntime(options) {
  if (!isPlainObject(options)) throw new Context7PoolError('options-invalid');
  const {
    credentials,
    store,
    childFactory,
    now,
    sleep,
    timeZone,
    redact,
    onEvent,
    operationTimeoutMs = 70000,
  } = options;
  if (typeof redact !== 'function') throw new Context7PoolError('configuration-invalid');
  if (!Array.isArray(credentials)
    || !store
    || typeof store.preview !== 'function'
    || typeof store.reserveExpected !== 'function'
    || typeof store.recordOutcome !== 'function'
    || typeof childFactory !== 'function'
    || typeof now !== 'function'
    || typeof sleep !== 'function'
    || typeof timeZone !== 'string'
    || !Number.isInteger(operationTimeoutMs)
    || operationTimeoutMs <= 0) {
    throw new Context7PoolError('options-invalid');
  }

  const credentialBySlot = new Map(credentials.map(credential => [credential.slot, credential]));
  const context = {
    identities: credentials.map(({ slot, fingerprintSha256 }) => ({ slot, fingerprintSha256 })),
    timeZone,
  };
  const started = now();
  if (!(started instanceof Date) || Number.isNaN(started.getTime())) throw new Context7PoolError('time-invalid');
  const publicState = {
    instanceId_12: crypto.randomBytes(6).toString('hex'),
    startedAt: started.toISOString(),
    keyedDispatches: 0,
    anonymousDispatches: 0,
  };
  let officialSignature = null;
  let active = null;
  let generationCounter = 0;
  let queueTail = Promise.resolve();
  let currentController = null;
  let closing = false;
  let closePromise = null;
  let storageFaultLatched = false;

  function emit(event, fields = {}) {
    if (typeof onEvent !== 'function') return;
    const allowlisted = { event };
    for (const key of ['slot', 'fingerprint', 'ordinal', 'attempt', 'failure']) {
      if (Object.hasOwn(fields, key)) allowlisted[key] = fields[key];
    }
    try {
      const returned = onEvent(allowlisted);
      Promise.resolve(returned).catch(() => undefined);
    } catch { /* observer isolation */ }
  }

  function throwIfAborted(operation) {
    if (operation.callerSignal?.aborted) throw operation.callerSignal.reason;
    if (operation.controller.signal.aborted) throw operation.controller.signal.reason;
    if (closing) throw new Context7PoolError('closed');
  }

  function createOperation(callerSignal) {
    const controller = new AbortController();
    const deadlineError = new Context7PoolError('deadline-exceeded');
    const timer = setTimeout(() => controller.abort(deadlineError), operationTimeoutMs);
    timer.unref?.();
    const onCallerAbort = () => controller.abort(callerSignal.reason);
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort(callerSignal.reason);
      else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
    return {
      controller,
      callerSignal,
      finish() {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', onCallerAbort);
      },
    };
  }

  function observeDetached(callback) {
    try {
      Promise.resolve().then(callback).catch(() => undefined);
    } catch { /* detached cleanup isolation */ }
  }

  async function awaitExternal(operation, callback, hooks = {}) {
    throwIfAborted(operation);
    let abandoned = false;
    let sourceSettled = false;
    let sourceFulfilled = false;
    let fulfilledValue;
    let lateFulfillmentHandled = false;

    const handleLateFulfillment = () => {
      if (lateFulfillmentHandled || !sourceFulfilled || typeof hooks.onLateFulfilled !== 'function') return;
      lateFulfillmentHandled = true;
      observeDetached(() => hooks.onLateFulfilled(fulfilledValue));
    };
    const abandon = () => {
      if (abandoned) return;
      abandoned = true;
      if (typeof hooks.onAbort === 'function') observeDetached(hooks.onAbort);
      if (sourceSettled) handleLateFulfillment();
    };

    const source = Promise.resolve().then(callback);
    const observed = source.then(
      value => {
        sourceSettled = true;
        sourceFulfilled = true;
        fulfilledValue = value;
        if (abandoned) handleLateFulfillment();
        return { kind: 'fulfilled', value };
      },
      error => {
        sourceSettled = true;
        return { kind: 'rejected', error };
      },
    );

    let removeAbort;
    const aborted = new Promise(resolve => {
      const listener = () => {
        abandon();
        resolve({ kind: 'aborted' });
      };
      removeAbort = () => operation.controller.signal.removeEventListener('abort', listener);
      operation.controller.signal.addEventListener('abort', listener, { once: true });
      if (operation.controller.signal.aborted) listener();
    });

    const outcome = await Promise.race([observed, aborted]);
    removeAbort?.();
    if (operation.controller.signal.aborted || closing) {
      abandon();
      throwIfAborted(operation);
    }
    if (outcome.kind === 'rejected') throw outcome.error;
    return outcome.value;
  }

  async function closeChild(child) {
    if (!child || typeof child.close !== 'function') return;
    let timer;
    const timeout = new Promise(resolve => {
      timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
      timer.unref?.();
    });
    await Promise.race([Promise.resolve().then(() => child.close()).catch(() => undefined), timeout]);
    clearTimeout(timer);
  }

  async function discardActive() {
    const previous = active;
    active = null;
    if (previous) await closeChild(previous.child);
  }

  function detachPrepared(prepared) {
    const ownsActive = active?.child === prepared.child && active?.generation === prepared.generation;
    if (ownsActive) active = null;
    if (!closing || ownsActive) observeDetached(() => closeChild(prepared.child));
  }

  async function prepareChild(route, operation) {
    throwIfAborted(operation);
    const identity = routeIdentity(route);
    if (active?.identity === identity) return active;
    await discardActive();
    throwIfAborted(operation);
    const credential = route.kind === 'keyed' ? credentialBySlot.get(route.slot) : null;
    if (route.kind === 'keyed'
      && (!credential || credential.fingerprintSha256 !== route.fingerprintSha256)) {
      throw new Context7PoolError('route-invalid');
    }
    const generation = ++generationCounter;
    let child;
    try {
      child = await awaitExternal(
        operation,
        () => childFactory({
          apiKey: credential?.value,
          route: clone(route),
          signal: operation.controller.signal,
        }),
        { onLateFulfilled: lateChild => closeChild(lateChild) },
      );
    } catch (error) {
      active = null;
      throwIfAborted(operation);
      const classification = classifyThrownError(error);
      throw new Context7PoolError(classification.kind, error, redact);
    }
    if (operation.controller.signal.aborted || closing) {
      await closeChild(child);
      throwIfAborted(operation);
    }
    if (!child || !Array.isArray(child.tools) || typeof child.callTool !== 'function' || typeof child.close !== 'function') {
      await closeChild(child);
      throw new Context7PoolError('schema-invalid');
    }
    let signature;
    try {
      signature = canonicalToolSignature(child.tools);
    } catch (error) {
      await closeChild(child);
      throw error;
    }
    if (officialSignature !== null && signature !== officialSignature) {
      await closeChild(child);
      throw new Context7PoolError('schema-drift');
    }
    if (officialSignature === null) officialSignature = signature;
    if (operation.controller.signal.aborted || closing) {
      await closeChild(child);
      throwIfAborted(operation);
    }
    const prepared = { child, generation, identity, route: clone(route) };
    active = prepared;
    if (typeof child.onExit === 'function') {
      child.onExit(() => {
        if (active?.child === child && active?.generation === generation) active = null;
      });
    }
    return prepared;
  }

  async function abortableSleep(ms, operation) {
    throwIfAborted(operation);
    let removeAbort;
    const aborted = new Promise((_, reject) => {
      const listener = () => reject(operation.controller.signal.reason);
      removeAbort = () => operation.controller.signal.removeEventListener('abort', listener);
      operation.controller.signal.addEventListener('abort', listener, { once: true });
    });
    try {
      await Promise.race([Promise.resolve().then(() => sleep(ms, { signal: operation.controller.signal })), aborted]);
    } finally {
      removeAbort?.();
    }
    throwIfAborted(operation);
  }

  function enqueue(callback, callerSignal) {
    const operation = createOperation(callerSignal);
    const run = async () => {
      try {
        throwIfAborted(operation);
        currentController = operation.controller;
        try {
          return await callback(operation);
        } catch (error) {
          if (operation.callerSignal?.aborted) throw operation.callerSignal.reason;
          if (operation.controller.signal.aborted) throw operation.controller.signal.reason;
          if (error instanceof Context7PoolError) throw error;
          throw new Context7PoolError(classifyThrownError(error).kind, error, redact);
        }
      } finally {
        if (currentController === operation.controller) currentController = null;
        operation.finish();
      }
    };
    const result = queueTail.then(run, run);
    queueTail = result.catch(() => undefined);
    return result;
  }

  async function listToolsOperation(operation) {
    throwIfAborted(operation);
    const preview = await awaitExternal(operation, () => store.preview(context, {}));
    throwIfAborted(operation);
    const prepared = await prepareChild(preview.route, operation);
    return clone(prepared.child.tools);
  }

  function normalizeChildResponse(value) {
    if (isPlainObject(value) && Object.hasOwn(value, 'result') && Object.hasOwn(value, 'failureEvidence')) {
      return { result: value.result, failureEvidence: value.failureEvidence };
    }
    return { result: value, failureEvidence: null };
  }

  async function persistOutcome(token, classification, operation) {
    const outcome = outcomeForClassification(classification);
    await awaitExternal(operation, () => store.recordOutcome(context, token, outcome));
    return outcome;
  }

  async function dispatchAnonymous(name, args, route, operation, dispatchState) {
    if (!validAnonymousRoute(route, true)) throw new Context7PoolError('route-invalid');
    if (dispatchState.total >= MAX_DISPATCHES) return fixedFailure('retry-exhausted');
    const prepared = await prepareChild(route, operation);
    throwIfAborted(operation);
    if (active?.child !== prepared.child || active?.generation !== prepared.generation) {
      throw new Context7PoolError('dispatch-identity-invalid');
    }
    const dispatchedChild = prepared.child;
    dispatchState.total += 1;
    publicState.anonymousDispatches += 1;
    emit('dispatch', { attempt: dispatchState.total });
    try {
      const raw = await awaitExternal(
        operation,
        () => dispatchedChild.callTool(name, args, { signal: operation.controller.signal }),
        { onAbort: () => detachPrepared(prepared) },
      );
      throwIfAborted(operation);
      const { result, failureEvidence } = normalizeChildResponse(raw);
      const classification = classifyToolResult({ result, failureEvidence });
      return classification === null ? result : fixedFailure(classification.kind);
    } catch (error) {
      if (operation.callerSignal?.aborted) throw operation.callerSignal.reason;
      if (operation.controller.signal.aborted) throw operation.controller.signal.reason;
      return fixedFailure(classifyThrownError(error).kind);
    }
  }

  async function callToolOperation(name, args, operation) {
    const dispatchState = { total: 0, transients: 0 };
    const excludedFingerprints = new Set();
    let pinnedTransientRoute = null;
    if (storageFaultLatched) {
      return dispatchAnonymous(
        name,
        args,
        { kind: 'anonymous', reason: 'outcome-persistence-failed' },
        operation,
        dispatchState,
      );
    }

    while (dispatchState.total < MAX_DISPATCHES) {
      throwIfAborted(operation);
      const routeOptions = { excludeFingerprints: [...excludedFingerprints] };
      const preview = await awaitExternal(operation, () => store.preview(context, routeOptions));
      throwIfAborted(operation);
      // Attempt two is pinned to the first transient route, but reserveExpected
      // remains the durable eligibility fence. A changed store returns retry,
      // so a stale pin can never dispatch without a fresh matching token.
      const expectedRoute = pinnedTransientRoute ?? preview.route;
      const prepared = await prepareChild(expectedRoute, operation);
      throwIfAborted(operation);
      const reserved = await awaitExternal(
        operation,
        () => store.reserveExpected(context, expectedRoute, routeOptions),
        { onAbort: () => detachPrepared(prepared) },
      );
      throwIfAborted(operation);

      if (reserved.kind === 'retry') {
        pinnedTransientRoute = null;
        await discardActive();
        continue;
      }
      if (reserved.kind === 'anonymous') {
        if (!validAnonymousReservation(reserved)) {
          throw new Context7PoolError('reservation-invalid');
        }
        if (prepared.route.kind === 'keyed') await discardActive();
        return dispatchAnonymous(name, args, reserved.route, operation, dispatchState);
      }
      if (!validKeyedReservation(reserved, prepared)) {
        throw new Context7PoolError('reservation-invalid');
      }

      if (active?.child !== prepared.child || active?.generation !== prepared.generation) {
        throw new Context7PoolError('dispatch-identity-invalid');
      }
      const dispatchedChild = prepared.child;
      const dispatchedGeneration = prepared.generation;
      const reservation = clone(reserved.token);
      dispatchState.total += 1;
      publicState.keyedDispatches += 1;
      emit('dispatch', {
        slot: reservation.slot,
        fingerprint: String(reservation.fingerprintSha256).slice(0, 12),
        ordinal: reservation.attemptOrdinal,
        attempt: dispatchState.total,
      });

      let result;
      let classification;
      try {
        const raw = await awaitExternal(
          operation,
          () => dispatchedChild.callTool(name, args, { signal: operation.controller.signal }),
          { onAbort: () => detachPrepared(prepared) },
        );
        throwIfAborted(operation);
        const normalized = normalizeChildResponse(raw);
        result = normalized.result;
        classification = classifyToolResult(normalized);
      } catch (error) {
        if (operation.callerSignal?.aborted) throw operation.callerSignal.reason;
        if (operation.controller.signal.aborted) throw operation.controller.signal.reason;
        classification = classifyThrownError(error);
      }

      if (dispatchedGeneration !== prepared.generation || dispatchedChild !== prepared.child) {
        throw new Context7PoolError('dispatch-identity-invalid');
      }
      let outcome;
      try {
        outcome = await persistOutcome(reservation, classification, operation);
      } catch (error) {
        if (operation.callerSignal?.aborted) throw operation.callerSignal.reason;
        if (closing && operation.controller.signal.aborted) throw operation.controller.signal.reason;
        storageFaultLatched = true;
        emit('outcome-persistence-failed', {
          slot: reservation.slot,
          fingerprint: String(reservation.fingerprintSha256).slice(0, 12),
          ordinal: reservation.attemptOrdinal,
          attempt: dispatchState.total,
          failure: 'outcome-persistence-failed',
        });
        return classification === null ? result : fixedFailure(classification.kind);
      }
      emit('outcome', {
        slot: reservation.slot,
        fingerprint: String(reservation.fingerprintSha256).slice(0, 12),
        ordinal: reservation.attemptOrdinal,
        attempt: dispatchState.total,
        failure: classification?.kind ?? 'success',
      });

      if (outcome.kind === 'success') return result;
      if (outcome.kind === 'terminal-non-success' || outcome.kind === 'input-invalid') {
        return fixedFailure(outcome.kind);
      }
      if (outcome.kind === 'transient') {
        dispatchState.transients += 1;
        if (dispatchState.transients >= MAX_TRANSIENT_DISPATCHES) return fixedFailure('transient');
        if (dispatchState.transients === 1) {
          pinnedTransientRoute = clone(reserved.route);
        } else {
          excludedFingerprints.add(reservation.fingerprintSha256);
          pinnedTransientRoute = null;
        }
        await abortableSleep(1, operation);
      }
    }
    return fixedFailure('retry-exhausted');
  }

  function listTools() {
    if (closing) return Promise.reject(new Context7PoolError('closed'));
    return enqueue(listToolsOperation);
  }

  function callTool(name, args, callOptions = {}) {
    try {
      validateOfficialToolArguments(name, args);
    } catch (error) {
      return Promise.reject(error);
    }
    if (closing) return Promise.reject(new Context7PoolError('closed'));
    const callerSignal = isPlainObject(callOptions) ? callOptions.signal : undefined;
    return enqueue(operation => callToolOperation(name, clone(args), operation), callerSignal);
  }

  function getPublicRuntime() {
    return { ...publicState };
  }

  function getRouteOverride() {
    return storageFaultLatched
      ? { kind: 'anonymous', reason: 'outcome-persistence-failed' }
      : null;
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    const closeError = new Context7PoolError('closed');
    const previous = active;
    active = null;
    currentController?.abort(closeError);
    closePromise = closeChild(previous?.child).then(() => {
      void queueTail.catch(() => undefined);
    });
    return closePromise;
  }

  return { listTools, callTool, getPublicRuntime, getRouteOverride, close };
}

module.exports = {
  Context7PoolError,
  canonicalToolSignature,
  classifyThrownError,
  classifyToolResult,
  createPoolRuntime,
  outcomeForClassification,
  validateOfficialToolArguments,
};
