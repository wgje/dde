import { afterEach, describe, expect, it, vi } from 'vitest';

import { ErrorCodes } from '../utils/result';
import { createSpeechToTextTranscriber } from './speech-to-text-transcriber-options.factory';

function createOptions() {
  const session = {
    access_token: 'factory-token',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: 'user-1' },
  };
  const client = {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
    },
  };
  return {
    auth: {
      ensureRuntimeAuthReady: vi.fn().mockResolvedValue(undefined),
    },
    sessionManager: {
      tryRefreshSessionWithSession: vi.fn(),
    },
    supabaseClient: {
      client: vi.fn(() => client),
      clientAsync: vi.fn(async () => client),
      getStorageKey: vi.fn(() => 'sb-project-auth-token'),
    },
    toast: {
      error: vi.fn(),
      warning: vi.fn(),
    },
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    retryableSessionRecoveryError: 'SESSION_TEMPORARILY_UNAVAILABLE',
    defaultUpstreamRetryDelayMs: 30_000,
    maxUpstreamRetryDelayMs: 15_000,
    getCurrentUserId: vi.fn(() => 'user-1'),
    setControlledRetryDelayMs: vi.fn(),
  };
}

describe('createSpeechToTextTranscriber', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, '__NANOFLOW_AUTH_CANONICAL_STORAGE__');
    vi.restoreAllMocks();
  });

  it('creates a transcriber with the service feedback dependencies', async () => {
    const options = createOptions();
    const transcriber = createSpeechToTextTranscriber(options);

    await expect(transcriber.transcribe(new Blob(['audio']), null))
      .rejects.toThrow(ErrorCodes.SYNC_AUTH_EXPIRED);

    expect(options.logger.error).toHaveBeenCalledWith(
      'SpeechToText',
      'Transcription aborted: user not authenticated',
    );
    expect(options.toast.error).toHaveBeenCalledWith(
      '认证失败',
      '请先登录后再使用语音转写功能',
    );
  });

  it('wires the current public client and exact canonical bundle into transcription', async () => {
    const options = createOptions();
    const session = {
      access_token: 'factory-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'user-1' },
    };
    const peekBundle = vi.fn(() => ({
      session: JSON.stringify(session),
      codeVerifier: 'factory-verifier',
      user: JSON.stringify(session.user),
    }));
    Object.defineProperty(globalThis, '__NANOFLOW_AUTH_CANONICAL_STORAGE__', {
      configurable: true,
      value: {
        compareAndSwap: vi.fn(),
        createGeneration: vi.fn(),
        peekBundle,
        readBundle: vi.fn(),
        startSessionPrewarm: vi.fn(),
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ text: 'factory result' }), { status: 200 }),
    );

    const result = await createSpeechToTextTranscriber(options)
      .transcribe(new Blob(['audio']), 'user-1');

    expect(result).toBe('factory result');
    expect(options.supabaseClient.client).toHaveBeenCalled();
    expect(options.supabaseClient.getStorageKey).toHaveBeenCalled();
    expect(peekBundle).toHaveBeenCalledWith('sb-project-auth-token');
  });
});
