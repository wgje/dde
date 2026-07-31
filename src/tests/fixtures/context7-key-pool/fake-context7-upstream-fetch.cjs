'use strict';

const path = require('node:path');

const NativeResponse = globalThis.Response;
const mode = process.env.NANOFLOW_CONTEXT7_TEST_FETCH || 'official';
const exactPaths = new Set(['/api/v2/libs/search', '/api/v2/context']);

function response(status, body = 'upstream-body-sentinel', headers = {}) {
  if (status === 204 || status === 205) return new NativeResponse(null, { status, headers });
  return new NativeResponse(body, { status, headers });
}

function faultResponse(kind) {
  const base = {
    status: 401,
    ok: false,
    headers: new Headers({ 'retry-after': '9', 'x-upstream-sentinel': 'raw-header-sentinel' }),
    body: { cancel: async () => undefined },
  };
  if (kind === 'body-cancel-fault') base.body.cancel = async () => { throw new Error('cancel fault'); };
  if (kind === 'header-fault') base.headers = { get() { throw new Error('header fault'); } };
  if (kind === 'normalization-fault') Object.defineProperty(base, 'status', { get() { throw new Error('status fault'); } });
  return base;
}

globalThis.fetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const exact = url.origin === 'https://context7.com' && exactPaths.has(url.pathname);
  if (!exact) return response(401);

  if (mode === 'transport-throw') throw new Error('transport sentinel');
  if (['body-cancel-fault', 'header-fault', 'normalization-fault'].includes(mode)) return faultResponse(mode);
  if (mode === 'response-construction-fault') return faultResponse('header-fault');
  if (mode === 'marker-like-json') {
    return response(200, JSON.stringify({ message: 'nanoflow-context7-failure-v1:not-current' }), { 'content-type': 'application/json' });
  }
  if (mode.startsWith('status:')) {
    const parts = mode.split(';');
    const status = Number(parts[0].slice('status:'.length));
    const retry = parts.find((part) => part.startsWith('retry='))?.slice('retry='.length);
    if (status === 304) {
      return {
        status: 304,
        ok: false,
        headers: new Headers({ 'x-upstream-sentinel': 'raw-header-sentinel' }),
        body: { cancel: async () => undefined },
      };
    }
    return response(status, 'upstream-body-sentinel', {
      ...(retry === undefined ? {} : { 'retry-after': retry }),
      'x-upstream-sentinel': 'raw-header-sentinel',
    });
  }
  if (url.pathname === '/api/v2/libs/search') return response(401, 'upstream-body-sentinel');
  return response(429, 'upstream-body-sentinel', { 'retry-after': '17' });
};

if (mode === 'response-construction-fault') {
  globalThis.Response = class BrokenResponse {
    constructor() { throw new Error('response construction fault'); }
  };
}

require(path.resolve(__dirname, '../../../../scripts/context7-key-pool/context7-fetch-observer.cjs'));
