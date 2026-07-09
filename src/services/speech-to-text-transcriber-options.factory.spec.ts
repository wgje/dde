import { describe, expect, it, vi } from 'vitest';

import { ErrorCodes } from '../utils/result';
import { createSpeechToTextTranscriber } from './speech-to-text-transcriber-options.factory';

function createOptions() {
  return {
    auth: {
      ensureRuntimeAuthReady: vi.fn().mockResolvedValue(undefined),
    },
    sessionManager: {
      tryRefreshSessionWithSession: vi.fn(),
    },
    supabaseClient: {
      clientAsync: vi.fn(),
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
});
