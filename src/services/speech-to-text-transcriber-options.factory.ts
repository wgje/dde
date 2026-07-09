import type { Session } from '@supabase/supabase-js';

import { FOCUS_CONFIG } from '../config/focus.config';
import { environment } from '../environments/environment';
import { remainingQuota } from '../state/focus-stores';
import { SpeechToTextTranscriber } from './speech-to-text-transcriber';

export interface SpeechToTextTranscriberFactoryOptions {
  auth: {
    ensureRuntimeAuthReady: () => Promise<void>;
  };
  sessionManager: {
    tryRefreshSessionWithSession: (context: string) => Promise<{
      refreshed: boolean;
      reason?: string;
      session?: Session | null;
    }>;
  };
  supabaseClient: {
    clientAsync: () => Promise<{
      auth: {
        getSession: () => Promise<{
          data: { session: Session | null };
          error: { message?: string } | null;
        }>;
      };
    } | null>;
  };
  toast: {
    error: (title: string, message: string) => void;
    warning: (title: string, message: string) => void;
  };
  logger: {
    debug: (scope: string, message: string, data?: unknown) => void;
    error: (scope: string, message: string, data?: unknown) => void;
    info: (scope: string, message: string, data?: unknown) => void;
    warn: (scope: string, message: string, data?: unknown) => void;
  };
  retryableSessionRecoveryError: string;
  defaultUpstreamRetryDelayMs: number;
  maxUpstreamRetryDelayMs: number;
  getCurrentUserId: () => string | null;
  setControlledRetryDelayMs: (value: number) => void;
}

export function createSpeechToTextTranscriber(
  options: SpeechToTextTranscriberFactoryOptions,
): SpeechToTextTranscriber {
  return new SpeechToTextTranscriber({
    auth: options.auth,
    sessionManager: options.sessionManager,
    supabaseClient: options.supabaseClient,
    toast: options.toast,
    logger: options.logger,
    config: {
      edgeFunctionName: FOCUS_CONFIG.SPEECH_TO_TEXT.EDGE_FUNCTION_NAME,
      timeoutMs: FOCUS_CONFIG.BLACK_BOX.TRANSCRIBE_TIMEOUT,
    },
    supabaseUrl: environment.supabaseUrl,
    supabaseAnonKey: environment.supabaseAnonKey,
    retryableSessionRecoveryError: options.retryableSessionRecoveryError,
    accessTokenExpiryBufferSeconds: 60,
    defaultUpstreamRetryDelayMs: options.defaultUpstreamRetryDelayMs,
    maxUpstreamRetryDelayMs: options.maxUpstreamRetryDelayMs,
    getCurrentUserId: options.getCurrentUserId,
    setRemainingQuota: value => remainingQuota.set(value),
    setControlledRetryDelayMs: options.setControlledRetryDelayMs,
  });
}
