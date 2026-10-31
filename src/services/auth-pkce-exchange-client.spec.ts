import fs from 'node:fs';
import path from 'node:path';
import type { AuthError, Session } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthPkceExchangeClient } from './auth-pkce-exchange-client';

vi.mock('@supabase/supabase-js', async importOriginal => await importOriginal());

afterAll(() => {
  vi.doUnmock('@supabase/supabase-js');
  vi.resetModules();
});

const SUPABASE_URL = 'https://example.supabase.co';
const ANON_KEY = 'anon-key';
const CODE = 'callback-code-a';
const VERIFIER = 'callback-verifier-a';
const STORAGE_KEY = 'auth-pkce-oracle';
let oracleSequence = 0;

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function sessionPayload(): Record<string, unknown> {
  return {
    access_token: 'access-token-a',
    refresh_token: 'refresh-token-a',
    token_type: 'bearer',
    expires_in: 3600,
    user: {
      id: 'owner-a',
      aud: 'authenticated',
      role: 'authenticated',
      email: 'owner-a@example.test',
      app_metadata: {},
      user_metadata: {},
      identities: [],
      created_at: new Date(0).toISOString(),
    },
  };
}

function responseFactory(
  body: string,
  status = 200,
  headers: Record<string, string> = { 'Content-Type': 'application/json' },
): () => Response {
  return () => new Response(body, { status, headers });
}

function summarizeError(error: AuthError | null) {
  return error && {
    name: error.name,
    message: error.message,
    status: error.status,
    code: error.code,
  };
}

async function runOracle(
  makeResponse: () => Response,
  verifier = VERIFIER,
): Promise<{ session: Session | null; redirectType: string | null; error: AuthError | null; call: CapturedCall }> {
  const { createClient } = await vi.importActual<typeof import('@supabase/supabase-js')>(
    '@supabase/supabase-js',
  );
  const calls: CapturedCall[] = [];
  const storageKey = `${STORAGE_KEY}-${++oracleSequence}`;
  const values = new Map<string, string>([[`${storageKey}-code-verifier`, JSON.stringify(verifier)]]);
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: {
      storageKey,
      storage: {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => { values.set(key, value); },
        removeItem: key => { values.delete(key); },
      },
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: 'pkce',
      skipAutoInitialize: true,
    },
    global: {
      fetch: vi.fn(async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return makeResponse();
      }),
    },
  });
  const result = await client.auth.exchangeCodeForSession(CODE);
  await client.auth.dispose();
  await client.removeAllChannels();
  const redirectType = 'redirectType' in result.data
    && typeof result.data.redirectType === 'string'
    ? result.data.redirectType
    : null;
  return {
    session: result.data.session,
    redirectType,
    error: result.error,
    call: calls[0]!,
  };
}

async function runSubject(
  makeResponse: () => Response,
  verifier = VERIFIER,
): Promise<{
  session: Session | null;
  redirectType: string | null;
  error: AuthError | null;
  calls: CapturedCall[];
}> {
  const calls: CapturedCall[] = [];
  const client = new AuthPkceExchangeClient(async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return makeResponse();
  });
  const result = await client.exchange({
    supabaseUrl: SUPABASE_URL,
    anonKey: ANON_KEY,
    code: CODE,
    verifier,
  });
  return {
    session: result.data.session,
    redirectType: result.data.redirectType,
    error: result.error,
    calls,
  };
}

describe('AuthPkceExchangeClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T00:00:00.000Z'));
    vi.stubGlobal('BroadcastChannel', class {
      addEventListener(): void {}
      close(): void {}
      postMessage(): void {}
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('pins the locked oracle runtime and sends one parity request without credential side channels', async () => {
    const authPackage = JSON.parse(fs.readFileSync(
      path.resolve('node_modules/@supabase/auth-js/package.json'),
      'utf8',
    )) as { version?: string };
    expect(authPackage.version).toBe('2.110.3');

    const body = JSON.stringify(sessionPayload());
    const oracle = await runOracle(responseFactory(body));
    const subject = await runSubject(responseFactory(body));

    expect(subject.calls).toHaveLength(1);
    const call = subject.calls[0]!;
    expect(call.url).toBe(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`);
    expect(call.url).toBe(oracle.call.url);
    expect(new Headers(call.init.headers)).toMatchObject({});
    expect(new Headers(call.init.headers).get('Content-Type')).toBe('application/json;charset=UTF-8');
    expect(new Headers(call.init.headers).get('apikey')).toBe(ANON_KEY);
    expect(new Headers(call.init.headers).get('Authorization')).toBe(`Bearer ${ANON_KEY}`);
    expect(new Headers(call.init.headers).get('X-Supabase-Api-Version')).toBe('2024-01-01');
    expect(new Headers(call.init.headers).get('X-Client-Info'))
      .toBe('nanoflow-auth-pkce/1; auth-js-parity=2.110.3');
    expect(JSON.parse(String(call.init.body))).toEqual(JSON.parse(String(oracle.call.init.body)));
    expect(subject.session).toEqual(oracle.session);
    expect(subject.session?.expires_at).toBe(Math.round(Date.now() / 1000) + 3600);
    expect(subject.error).toBeNull();

    const source = fs.readFileSync(path.resolve('src/services/auth-pkce-exchange-client.ts'), 'utf8');
    for (const forbidden of [
      'createClient(', 'BroadcastChannel', 'localStorage', 'sessionStorage',
      'onAuthStateChange', 'postMessage(', 'console.',
    ]) expect(source).not.toContain(forbidden);
  });

  it('splits the exact recovery verifier and preserves the oracle redirect type', async () => {
    const body = JSON.stringify(sessionPayload());
    const oracle = await runOracle(responseFactory(body), `${VERIFIER}/recovery`);
    const subject = await runSubject(responseFactory(body), `${VERIFIER}/recovery`);

    expect(subject.redirectType).toBe('recovery');
    expect(subject.redirectType).toBe(oracle.redirectType);
    expect(JSON.parse(String(subject.calls[0]?.init.body))).toEqual({
      auth_code: CODE,
      code_verifier: VERIFIER,
    });
  });

  it('returns the oracle invalid-token error for malformed successful payloads', async () => {
    const body = JSON.stringify({ ...sessionPayload(), user: null });
    const oracle = await runOracle(responseFactory(body));
    const subject = await runSubject(responseFactory(body));

    expect(summarizeError(subject.error)).toEqual(summarizeError(oracle.error));
    expect(subject.error?.name).toBe('AuthInvalidTokenResponseError');
  });

  it.each([
    ['legacy', {}, { error_code: 'legacy-code', msg: 'legacy failure' }],
    ['versioned', { 'X-Supabase-Api-Version': '2024-01-01' }, { code: 'versioned-code', message: 'versioned failure' }],
  ])('matches the %s 400 API error name, status, and code', async (_name, responseHeaders, payload) => {
    const makeResponse = responseFactory(JSON.stringify(payload), 400, responseHeaders);
    const oracle = await runOracle(makeResponse);
    const subject = await runSubject(makeResponse);

    expect(summarizeError(subject.error)).toEqual(summarizeError(oracle.error));
    expect(subject.error?.name).toBe('AuthApiError');
  });

  it('matches retryable 5xx and rejected-fetch errors without retrying', async () => {
    const makeResponse = responseFactory('', 503);
    const oracle = await runOracle(makeResponse);
    const subject = await runSubject(makeResponse);
    expect(summarizeError(subject.error)).toEqual(summarizeError(oracle.error));
    expect(subject.calls).toHaveLength(1);

    const rejection = new TypeError('network unavailable');
    const client = new AuthPkceExchangeClient(vi.fn().mockRejectedValue(rejection));
    const result = await client.exchange({
      supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY, code: CODE, verifier: VERIFIER,
    });
    expect(summarizeError(result.error)).toEqual({
      name: 'AuthRetryableFetchError',
      message: 'network unavailable',
      status: 0,
      code: undefined,
    });
  });

  it.each([
    [504, 'AuthRetryableFetchError', undefined],
    [505, 'AuthApiError', 'status-505'],
    [519, 'AuthApiError', 'status-519'],
    [520, 'AuthRetryableFetchError', undefined],
    [530, 'AuthRetryableFetchError', undefined],
    [531, 'AuthApiError', 'status-531'],
  ])('matches the locked retryable boundary for HTTP %s', async (status, name, code) => {
    const makeResponse = responseFactory(JSON.stringify({
      code: `status-${status}`,
      message: `failure-${status}`,
    }), status, {
      'Content-Type': 'application/json',
      'X-Supabase-Api-Version': '2024-01-01',
    });
    const oracle = await runOracle(makeResponse);
    const subject = await runSubject(makeResponse);

    expect(summarizeError(subject.error)).toEqual(summarizeError(oracle.error));
    expect(subject.error?.name).toBe(name);
    expect(subject.error?.code).toBe(code);
    expect(subject.calls).toHaveLength(1);
  });

  it('matches the oracle unknown error for an invalid JSON API response', async () => {
    const makeResponse = responseFactory('not-json', 400);
    const oracle = await runOracle(makeResponse);
    const subject = await runSubject(makeResponse);

    expect(subject.error?.name).toBe('AuthUnknownError');
    expect(summarizeError(subject.error)).toEqual(summarizeError(oracle.error));
  });
});
