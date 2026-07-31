'use strict';

const FAILURE_PREFIX = 'nanoflow-context7-failure-v1';
const MARKER_RE = /^[a-f0-9]{64}$/;
const TERMINAL_EXIT_CODE = 86;
const ENDPOINTS = new Set([
  'https://context7.com/api/v2/libs/search',
  'https://context7.com/api/v2/context',
]);

const marker = process.env.NANOFLOW_CONTEXT7_FAILURE_MARKER;
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;

if (!MARKER_RE.test(marker || '') || typeof nativeFetch !== 'function' || typeof NativeResponse !== 'function') {
  process.exit(TERMINAL_EXIT_CODE);
}

function endpointFor(input) {
  const candidate = input instanceof Request ? input.url : input;
  const url = candidate instanceof URL ? candidate : new URL(String(candidate));
  return `${url.origin}${url.pathname}`;
}

function envelope(kind, status, retryAfter) {
  return `${FAILURE_PREFIX}:${marker}:kind=${kind};status=${status};retry-after=${retryAfter}`;
}

function responseFor(message, status) {
  return new NativeResponse(JSON.stringify({ message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function terminalFallback() {
  process.exit(TERMINAL_EXIT_CODE);
}

function internalResponse() {
  try {
    return responseFor(envelope('observer-internal', 'none', 'none'), 599);
  } catch {
    return terminalFallback();
  }
}

async function observedFetch(input, init) {
  let endpoint;
  try {
    endpoint = endpointFor(input);
  } catch {
    return internalResponse();
  }
  if (!ENDPOINTS.has(endpoint)) return nativeFetch(input, init);

  let upstream;
  try {
    upstream = await nativeFetch(input, init);
  } catch {
    try {
      return responseFor(envelope('transport', 'none', 'none'), 599);
    } catch {
      return terminalFallback();
    }
  }

  try {
    const status = Number(upstream.status);
    if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error('status-invalid');
    if (status >= 200 && status <= 299) return upstream;

    const rawRetryAfter = upstream.headers.get('retry-after');
    let retryAfter = 'none';
    if (typeof rawRetryAfter === 'string' && /^[1-9][0-9]*$/.test(rawRetryAfter)) {
      const seconds = Number(rawRetryAfter);
      if (Number.isInteger(seconds) && seconds >= 1 && seconds <= 86400) retryAfter = String(seconds);
    }
    if (upstream.body && typeof upstream.body.cancel === 'function') await upstream.body.cancel();
    const carrierStatus = status === 304 ? 599 : status;
    return responseFor(envelope('http', String(status), retryAfter), carrierStatus);
  } catch {
    return internalResponse();
  }
}

globalThis.fetch = observedFetch;
if (globalThis.fetch !== observedFetch) process.exit(TERMINAL_EXIT_CODE);
