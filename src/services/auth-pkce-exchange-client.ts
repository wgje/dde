import {
  AuthApiError,
  AuthInvalidTokenResponseError,
  AuthRetryableFetchError,
  AuthUnknownError,
  type AuthError,
  type Session,
  type User,
} from '@supabase/supabase-js';

export interface AuthPkceExchangeInput {
  supabaseUrl: string;
  anonKey: string;
  code: string;
  verifier: string;
}

export interface AuthPkceExchangeResult {
  data: {
    session: Session | null;
    user: User | null;
    redirectType: string | null;
  };
  error: AuthError | null;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const API_VERSION = '2024-01-01';
const CLIENT_INFO = 'nanoflow-auth-pkce/1; auth-js-parity=2.110.3';

function errorMessage(value: unknown): string {
  if (value && typeof value === 'object') {
    const candidate = value as Record<string, unknown>;
    for (const key of ['msg', 'message', 'error_description', 'error']) {
      if (typeof candidate[key] === 'string') return candidate[key];
    }
  }
  return JSON.stringify(value);
}

function failed(error: AuthError): AuthPkceExchangeResult {
  return { data: { session: null, user: null, redirectType: null }, error };
}

function responseUsesVersionedCode(response: Response): boolean {
  const value = response.headers.get('X-Supabase-Api-Version');
  if (!value || !/^2\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && timestamp >= Date.parse(`${API_VERSION}T00:00:00.000Z`);
}

async function classifyResponseError(response: Response): Promise<AuthError> {
  const retryable = response.status >= 500 && response.status <= 504
    || response.status >= 520 && response.status <= 530;
  if (retryable) {
    return new AuthRetryableFetchError(errorMessage(response), response.status);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    return new AuthUnknownError(errorMessage(error), error);
  }
  const candidate = payload && typeof payload === 'object'
    ? payload as Record<string, unknown>
    : null;
  const code = candidate
    ? responseUsesVersionedCode(response) && typeof candidate['code'] === 'string'
      ? candidate['code']
      : typeof candidate['error_code'] === 'string' ? candidate['error_code'] : undefined
    : undefined;
  return new AuthApiError(errorMessage(payload), response.status || 500, code);
}

function normalizeSession(payload: unknown): Session | null {
  if (!payload || typeof payload !== 'object') return null;
  const candidate = payload as Record<string, unknown>;
  const user = candidate['user'];
  const expiresIn = candidate['expires_in'];
  if (typeof candidate['access_token'] !== 'string' || !candidate['access_token']
    || typeof candidate['refresh_token'] !== 'string' || !candidate['refresh_token']
    || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0
    || !user || typeof user !== 'object'
    || typeof (user as Record<string, unknown>)['id'] !== 'string'
    || !(user as Record<string, unknown>)['id']) {
    return null;
  }
  const session = { ...candidate } as unknown as Session;
  if (candidate['expires_at'] === undefined) {
    session.expires_at = Math.round(Date.now() / 1000) + expiresIn;
  } else if (typeof candidate['expires_at'] !== 'number'
    || !Number.isFinite(candidate['expires_at']) || candidate['expires_at'] <= 0) {
    return null;
  }
  return session;
}

export class AuthPkceExchangeClient {
  constructor(private readonly fetcher: Fetcher = (input, init) => fetch(input, init)) {}

  async exchange(input: AuthPkceExchangeInput): Promise<AuthPkceExchangeResult> {
    const [verifier, redirectType] = input.verifier.split('/');
    let response: Response;
    try {
      response = await this.fetcher(
        `${input.supabaseUrl.replace(/\/+$/, '')}/auth/v1/token?grant_type=pkce`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json;charset=UTF-8',
            apikey: input.anonKey,
            Authorization: `Bearer ${input.anonKey}`,
            'X-Supabase-Api-Version': API_VERSION,
            'X-Client-Info': CLIENT_INFO,
          },
          body: JSON.stringify({ auth_code: input.code, code_verifier: verifier }),
        },
      );
    } catch (error) {
      return failed(new AuthRetryableFetchError(errorMessage(error), 0));
    }
    if (!response.ok) return failed(await classifyResponseError(response));

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      return failed(new AuthRetryableFetchError(errorMessage(error), 0));
    }
    const session = normalizeSession(payload);
    if (!session) return failed(new AuthInvalidTokenResponseError());
    return {
      data: {
        session,
        user: session.user,
        redirectType: redirectType === 'recovery' ? 'recovery' : null,
      },
      error: null,
    };
  }
}
