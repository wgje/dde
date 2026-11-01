import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpeechToTextTranscriber } from './speech-to-text-transcriber';
import { ErrorCodes, ErrorMessages } from '../utils/result';
import type { CanonicalAuthBundle } from './supabase-auth-client-lifecycle.controller';
type TestSession = {
  access_token: string;
  expires_at: number;
  user: { id: string };
};

const createSession = (accessToken = 'valid-token', userId = 'user-a'): TestSession => ({
  access_token: accessToken,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: userId },
});

const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
};
const createTranscriber = () => {
  let currentUserId: string | null = 'user-a';
  let storageKey: string | null = 'sb-project-auth-token';
  let canonicalBundle: CanonicalAuthBundle = {
    session: JSON.stringify(createSession()),
    codeVerifier: 'verifier-a',
    user: JSON.stringify({ id: 'user-a' }),
  };
  const auth = {
    ensureRuntimeAuthReady: vi.fn().mockResolvedValue(undefined),
    currentUserId: vi.fn(() => currentUserId),
  };
  const sessionManager = {
    tryRefreshSessionWithSession: vi.fn(),
  };
  const client = {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: createSession() },
        error: null,
      }),
    },
  };
  let currentClient = client;
  const supabaseClient = {
    client: vi.fn(() => currentClient),
    clientAsync: vi.fn(async () => currentClient),
    getStorageKey: vi.fn(() => storageKey),
  };
  const authority = {
    createGeneration: vi.fn(),
    peekBundle: vi.fn(() => canonicalBundle),
    readBundle: vi.fn(),
    compareAndSwap: vi.fn(),
    startSessionPrewarm: vi.fn(),
  };
  const toast = {
    error: vi.fn(),
    warning: vi.fn(),
  };
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const setRemainingQuota = vi.fn();
  const setControlledRetryDelayMs = vi.fn();
  const transcriber = new SpeechToTextTranscriber({
    auth,
    sessionManager,
    supabaseClient,
    toast,
    logger,
    config: {
      edgeFunctionName: 'transcribe',
      timeoutMs: 10_000,
    },
    supabaseUrl: 'https://example.supabase.co',
    supabaseAnonKey: 'anon-key',
    retryableSessionRecoveryError: 'SESSION_TEMPORARILY_UNAVAILABLE',
    accessTokenExpiryBufferSeconds: 60,
    defaultUpstreamRetryDelayMs: 30_000,
    maxUpstreamRetryDelayMs: 15_000,
    getCurrentUserId: auth.currentUserId,
    getCanonicalAuthStorageAuthority: () => authority,
    setRemainingQuota,
    setControlledRetryDelayMs,
  });
  return {
    auth,
    authority,
    client,
    logger,
    sessionManager,
    setCanonicalBundle: (bundle: typeof canonicalBundle) => {
      canonicalBundle = bundle;
    },
    setCanonicalSession: (
      session: TestSession | null,
      codeVerifier: string | null = canonicalBundle.codeVerifier,
      user: string | null = session ? JSON.stringify(session.user) : null,
    ) => {
      canonicalBundle = {
        session: session ? JSON.stringify(session) : null,
        codeVerifier,
        user,
      };
    },
    setControlledRetryDelayMs,
    setCurrentClient: (nextClient: typeof client) => {
      currentClient = nextClient;
    },
    setCurrentUserId: (userId: string | null) => {
      currentUserId = userId;
    },
    setRemainingQuota,
    setStorageKey: (nextStorageKey: string | null) => {
      storageKey = nextStorageKey;
    },
    supabaseClient,
    toast,
    transcriber,
  };
};
describe('SpeechToTextTranscriber', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends audio to the Edge Function with the resolved access token', async () => {
    const { transcriber } = createTranscriber();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ text: 'hello', duration: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const result = await transcriber.transcribe(new Blob(['audio'], { type: 'audio/webm' }), 'user-a');
    expect(result).toBe('hello');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.supabase.co/functions/v1/transcribe',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer valid-token',
          apikey: 'anon-key',
        }),
      })
    );
  });

  it('refreshes the session once after a 401 Edge Function response', async () => {
    const { sessionManager, setCanonicalSession, transcriber } = createTranscriber();
    const refreshedSession = createSession('refreshed-token');
    sessionManager.tryRefreshSessionWithSession.mockImplementationOnce(async () => {
      setCanonicalSession(refreshedSession);
      return { refreshed: true, session: refreshedSession };
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'AUTH_INVALID' }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: 'after refresh', duration: 1 }), { status: 200 }));
    const result = await transcriber.transcribe(new Blob(['audio'], { type: 'audio/webm' }), 'user-a');
    expect(result).toBe('after refresh');
    expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: 'Bearer refreshed-token',
      }),
    });
  });

  it('maps quota exhaustion to quota state and user feedback', async () => {
    const { setRemainingQuota, toast, transcriber } = createTranscriber();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 'QUOTA_EXCEEDED' }), { status: 429 })
    );
    await expect(transcriber.transcribe(new Blob(['audio']), 'user-a'))
      .rejects.toThrow(ErrorCodes.FOCUS_QUOTA_EXCEEDED);
    expect(setRemainingQuota).toHaveBeenCalledWith(0);
    expect(toast.warning).toHaveBeenCalledWith('配额已用完', ErrorMessages[ErrorCodes.FOCUS_QUOTA_EXCEEDED]);
  });

  it('stores retry delay for retryable upstream errors', async () => {
    const { setControlledRetryDelayMs, transcriber } = createTranscriber();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 'GROQ_TIMEOUT' }), {
        status: 503,
        headers: { 'Retry-After': '5' },
      })
    );
    await expect(transcriber.transcribe(new Blob(['audio']), 'user-a'))
      .rejects.toThrow(ErrorCodes.FOCUS_NETWORK_ERROR);
    expect(setControlledRetryDelayMs).toHaveBeenCalledWith(5_000);
  });

  it.each([
    {
      name: 'different owner',
      transition: (context: ReturnType<typeof createTranscriber>) => {
        context.setCurrentUserId('user-b');
        context.setCanonicalSession(createSession('token-b', 'user-b'));
      },
    },
    {
      name: 'logout',
      transition: (context: ReturnType<typeof createTranscriber>) => {
        context.setCurrentUserId(null);
        context.setCanonicalSession(null, null, null);
      },
    },
    {
      name: 'same-owner token rotation',
      transition: (context: ReturnType<typeof createTranscriber>) => {
        context.setCanonicalSession(createSession('newer-token'));
      },
    },
    {
      name: 'same-owner B returned by delayed lookup',
      transition: (context: ReturnType<typeof createTranscriber>) => {
        const session = createSession('newer-token');
        context.setCanonicalSession(session);
        return session;
      },
    },
    {
      name: 'client replacement',
      transition: (context: ReturnType<typeof createTranscriber>) => {
        context.setCurrentClient({
          auth: {
            getSession: vi.fn(),
          },
        });
      },
    },
  ])('rejects a delayed A session after $name without stale effects', async ({ transition }) => {
    const context = createTranscriber();
    const sessionLookup = createDeferred<{
      data: { session: TestSession };
      error: null;
    }>();
    context.client.auth.getSession.mockReturnValueOnce(sessionLookup.promise);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const pending = context.transcriber.transcribe(new Blob(['audio']), 'user-a');
    await vi.waitFor(() => expect(context.client.auth.getSession).toHaveBeenCalledTimes(1));
    const resolvedSession = transition(context) ?? createSession();
    sessionLookup.resolve({ data: { session: resolvedSession }, error: null });
    await expect(pending).rejects.toMatchObject({
      name: 'SpeechToTextStaleAuthorityError',
      message: 'SESSION_TEMPORARILY_UNAVAILABLE',
    });
    for (const effect of [
      fetchSpy, context.logger.debug, context.logger.info, context.logger.warn, context.logger.error,
      context.toast.warning, context.toast.error, context.setControlledRetryDelayMs,
      context.setRemainingQuota, context.sessionManager.tryRefreshSessionWithSession,
    ]) expect(effect).not.toHaveBeenCalled();
  });

  it('does not retry a 401 when authority changes while refresh is pending', async () => {
    const context = createTranscriber();
    const refresh = createDeferred<{
      refreshed: true;
      session: TestSession;
    }>();
    context.sessionManager.tryRefreshSessionWithSession.mockReturnValueOnce(refresh.promise);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 'AUTH_INVALID' }), { status: 401 }),
    );
    const pending = context.transcriber.transcribe(new Blob(['audio']), 'user-a');
    await vi.waitFor(() => expect(context.sessionManager.tryRefreshSessionWithSession).toHaveBeenCalledTimes(1));
    context.setCanonicalSession(createSession('newer-token'));
    refresh.resolve({ refreshed: true, session: createSession('refreshed-a') });
    await expect(pending).rejects.toMatchObject({ name: 'SpeechToTextStaleAuthorityError' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(context.logger.warn).not.toHaveBeenCalled();
  });

  it.each(['session', 'codeVerifier', 'user'] as const)(
    'suppresses a delayed response after canonical %s drift',
    async field => {
      const context = createTranscriber();
      const response = createDeferred<Response>();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(response.promise);
      const pending = context.transcriber.transcribe(new Blob(['audio']), 'user-a');
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      const nextBundle = { ...context.authority.peekBundle() };
      nextBundle[field] = field === 'session'
        ? JSON.stringify(createSession('newer-token'))
        : `${field}-newer`;
      context.setCanonicalBundle(nextBundle);
      response.resolve(new Response(JSON.stringify({ text: 'stale text' }), { status: 200 }));
      await expect(pending).rejects.toMatchObject({ name: 'SpeechToTextStaleAuthorityError' });
      expect(context.logger.info).not.toHaveBeenCalledWith(
        'SpeechToText',
        expect.stringContaining('Transcription successful'),
      );
    },
  );

  it('checks authority again after response body resolution before quota and retry actions', async () => {
    const context = createTranscriber();
    const body = createDeferred<string>();
    const response = {
      headers: new Headers({ 'Retry-After': '5' }),
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      text: vi.fn(() => body.promise),
    } as unknown as Response;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);
    const pending = context.transcriber.transcribe(new Blob(['audio']), 'user-a');
    await vi.waitFor(() => expect(response.text).toHaveBeenCalledTimes(1));
    context.setCurrentUserId('user-b');
    context.setCanonicalSession(createSession('token-b', 'user-b'));
    body.resolve(JSON.stringify({ code: 'QUOTA_EXCEEDED' }));
    await expect(pending).rejects.toMatchObject({ name: 'SpeechToTextStaleAuthorityError' });
    expect(context.setRemainingQuota).not.toHaveBeenCalled();
    expect(context.setControlledRetryDelayMs).not.toHaveBeenCalled();
    expect(context.toast.warning).not.toHaveBeenCalled();
  });

  it('checks stale authority before publishing a delayed fetch timeout', async () => {
    const context = createTranscriber();
    const response = createDeferred<Response>();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(response.promise);
    const pending = context.transcriber.transcribe(new Blob(['audio']), 'user-a');
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    context.setCurrentUserId(null);
    context.setCanonicalSession(null, null, null);
    response.reject(new DOMException('timed out', 'AbortError'));

    await expect(pending).rejects.toMatchObject({ name: 'SpeechToTextStaleAuthorityError' });
    expect(context.logger.error).not.toHaveBeenCalled();
    expect(context.toast.error).not.toHaveBeenCalled();
  });

  it('fails closed before fetch when canonical authority is malformed', async () => {
    const context = createTranscriber();
    context.setCanonicalBundle({
      session: '{malformed',
      codeVerifier: 'verifier-a',
      user: JSON.stringify({ id: 'user-a' }),
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const error = await context.transcriber.transcribe(new Blob(['audio']), 'user-a')
      .catch(value => value as Error);

    expect(error).toMatchObject({
      name: 'SpeechToTextStaleAuthorityError',
      message: 'SESSION_TEMPORARILY_UNAVAILABLE',
    });
    expect(error).not.toHaveProperty('cause');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
