import { describe, expect, it, vi } from 'vitest';
import { SpeechToTextTranscriber } from './speech-to-text-transcriber';
import { ErrorCodes, ErrorMessages } from '../utils/result';

const createTranscriber = () => {
  const auth = {
    ensureRuntimeAuthReady: vi.fn().mockResolvedValue(undefined),
    currentUserId: vi.fn(() => 'user-a'),
  };
  const sessionManager = {
    tryRefreshSessionWithSession: vi.fn(),
  };
  const supabaseClient = {
    clientAsync: vi.fn().mockResolvedValue({
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: {
            session: {
              access_token: 'valid-token',
              expires_at: Math.floor(Date.now() / 1000) + 3600,
              user: { id: 'user-a' },
            },
          },
          error: null,
        }),
      },
    }),
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
    setRemainingQuota,
    setControlledRetryDelayMs,
  });

  return {
    auth,
    logger,
    sessionManager,
    setControlledRetryDelayMs,
    setRemainingQuota,
    supabaseClient,
    toast,
    transcriber,
  };
};

describe('SpeechToTextTranscriber', () => {
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
    const { sessionManager, transcriber } = createTranscriber();
    sessionManager.tryRefreshSessionWithSession.mockResolvedValueOnce({
      refreshed: true,
      session: {
        access_token: 'refreshed-token',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: { id: 'user-a' },
      },
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

  it('rejects before fetch when the resolved session belongs to another owner', async () => {
    const { supabaseClient, transcriber } = createTranscriber();
    supabaseClient.clientAsync.mockResolvedValueOnce({
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: {
            session: {
              access_token: 'other-token',
              expires_at: Math.floor(Date.now() / 1000) + 3600,
              user: { id: 'other-user' },
            },
          },
          error: null,
        }),
      },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(transcriber.transcribe(new Blob(['audio']), 'user-a'))
      .rejects.toThrow('SESSION_TEMPORARILY_UNAVAILABLE');
    expect(fetchSpy).not.toHaveBeenCalled();
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
});
