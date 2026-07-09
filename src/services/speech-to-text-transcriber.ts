import type { Session } from '@supabase/supabase-js';
import { ErrorCodes, ErrorMessages } from '../utils/result';
import {
  getAudioFileExtension,
  isAccessTokenExpiringSoon,
  isRetryableTranscribeCode,
  parseRetryAfterMs,
} from './speech-to-text.helpers';

type TranscribeSessionLookup = {
  session: Session | null;
  sessionError: { message?: string } | null;
};

type SpeechToTextTranscriberOptions = {
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
  config: {
    edgeFunctionName: string;
    timeoutMs: number;
  };
  supabaseUrl: string;
  supabaseAnonKey: string;
  retryableSessionRecoveryError: string;
  accessTokenExpiryBufferSeconds: number;
  defaultUpstreamRetryDelayMs: number;
  maxUpstreamRetryDelayMs: number;
  getCurrentUserId: () => string | null;
  setRemainingQuota: (value: number) => void;
  setControlledRetryDelayMs: (value: number) => void;
};

export class SpeechToTextTranscriber {
  constructor(private readonly options: SpeechToTextTranscriberOptions) {}

  async transcribe(audioBlob: Blob, expectedOwnerUserId: string | null): Promise<string> {
    const userId = expectedOwnerUserId;
    if (!userId) {
      this.options.logger.error('SpeechToText', 'Transcription aborted: user not authenticated');
      this.options.toast.error('认证失败', '请先登录后再使用语音转写功能');
      throw new Error(ErrorCodes.SYNC_AUTH_EXPIRED);
    }

    if (!this.isRecordingOwnerActive(userId)) {
      this.options.logger.warn('SpeechToText', 'Recording owner changed before transcription started', { expectedOwnerUserId: userId });
      throw new Error(this.options.retryableSessionRecoveryError);
    }

    this.options.logger.info('SpeechToText', `Starting transcription: size=${audioBlob.size}, type=${audioBlob.type}, userId=[REDACTED]`);
    this.options.logger.debug('SpeechToText', `Invoking Edge Function: ${this.options.config.edgeFunctionName}`);

    const functionUrl = `${this.options.supabaseUrl}/functions/v1/${this.options.config.edgeFunctionName}`;
    this.options.logger.debug('SpeechToText', `Calling: ${functionUrl}`);

    const response = await this.invokeTranscribeWithAuthRetry(functionUrl, audioBlob, userId);
    const responseText = await response.text();

    if (!response.ok) {
      this.handleFailedTranscribeResponse(response, responseText);
    }

    let data: { ok?: boolean; text?: string; duration?: number; error?: string; code?: string; retryable?: boolean };
    try {
      data = JSON.parse(responseText);
    } catch {
      this.options.logger.error('SpeechToText', '响应非 JSON 格式', { responseText: responseText.slice(0, 200) });
      throw new Error('服务响应格式错误');
    }

    if (data.ok === false || data.code) {
      if (isRetryableTranscribeCode(data.code) || data.retryable === true) {
        this.options.setControlledRetryDelayMs(this.parseRetryAfterMs(response.headers.get('Retry-After')));
        throw new Error(ErrorCodes.FOCUS_NETWORK_ERROR);
      }
      throw new Error(data.error || data.code || ErrorCodes.FOCUS_TRANSCRIBE_FAILED);
    }

    this.options.logger.info('SpeechToText', `Transcription successful: ${data.text?.length || 0} chars, duration=${data.duration}s`);
    return data.text ?? '';
  }

  private async invokeTranscribeWithAuthRetry(functionUrl: string, audioBlob: Blob, userId: string): Promise<Response> {
    const response = await this.invokeTranscribe(
      functionUrl,
      audioBlob,
      await this.resolveAccessToken('SpeechToText.transcribe', userId)
    );

    if (response.status !== 401) {
      return response;
    }

    this.options.logger.warn('SpeechToText', 'Edge Function rejected JWT, attempting one session refresh before failing');
    const refreshedSession = await this.refreshSessionForTranscribe('SpeechToText.transcribe.retry401');
    return this.invokeTranscribe(
      functionUrl,
      audioBlob,
      await this.resolveAccessToken('SpeechToText.transcribe.retry', userId, refreshedSession)
    );
  }

  private handleFailedTranscribeResponse(response: Response, responseText: string): never {
    this.options.logger.error('SpeechToText', 'Transcription failed', JSON.stringify({
      status: response.status,
      statusText: response.statusText,
      body: responseText,
    }));

    const errorData = this.parseTranscribeErrorData(responseText);
    if (errorData.code === 'QUOTA_EXCEEDED' || responseText.includes('QUOTA_EXCEEDED')) {
      this.options.toast.warning('配额已用完', ErrorMessages[ErrorCodes.FOCUS_QUOTA_EXCEEDED]);
      this.options.setRemainingQuota(0);
      throw new Error(ErrorCodes.FOCUS_QUOTA_EXCEEDED);
    }

    if (response.status === 401 || errorData.code === 'AUTH_INVALID') {
      this.options.toast.error('认证失败', '请重新登录后再试');
      throw new Error(ErrorCodes.SYNC_AUTH_EXPIRED);
    }

    if (isRetryableTranscribeCode(errorData.code)) {
      this.options.setControlledRetryDelayMs(this.parseRetryAfterMs(response.headers.get('Retry-After')));
      throw new Error(ErrorCodes.FOCUS_NETWORK_ERROR);
    }

    if (errorData.code === 'SERVICE_NOT_CONFIGURED') {
      this.options.toast.error('服务未配置', '语音转写服务未正确配置，请联系管理员');
      throw new Error(ErrorCodes.FOCUS_SERVICE_UNAVAILABLE);
    }

    throw new Error(errorData.error || errorData.message || `HTTP ${response.status}: ${response.statusText}`);
  }

  private parseTranscribeErrorData(responseText: string): { error?: string; code?: string; message?: string } {
    try {
      return JSON.parse(responseText);
    } catch (error) {
      this.options.logger.debug('transcribe', '响应非 JSON 格式', { error, responseText });
      return {};
    }
  }

  private async resolveAccessToken(
    context: string,
    expectedOwnerUserId: string,
    prefetchedSession: Session | null = null
  ): Promise<string> {
    await this.options.auth.ensureRuntimeAuthReady();
    this.assertRecordingOwnerActive(context, expectedOwnerUserId);

    let { session, sessionError } = await this.resolveInitialTranscribeSession(context, prefetchedSession);
    this.assertTranscribeSessionOwner(session, expectedOwnerUserId, context, 'Resolved session belongs to a different owner than the recording');

    if (this.shouldRefreshTranscribeSession(session, sessionError)) {
      this.logTranscribeSessionRefresh(context, session, sessionError);
      session = await this.refreshSessionForTranscribe(`${context}.getSession`);
      sessionError = null;
    }

    this.assertTranscribeSessionOwner(session, expectedOwnerUserId, context, 'Refreshed session no longer matches the recording owner');
    return this.requireTranscribeAccessToken(session, sessionError);
  }

  private assertRecordingOwnerActive(context: string, expectedOwnerUserId: string): void {
    if (this.isRecordingOwnerActive(expectedOwnerUserId)) {
      return;
    }

    this.options.logger.warn('SpeechToText', 'Recording owner changed before access token resolution completed', {
      context,
      expectedOwnerUserId,
    });
    throw new Error(this.options.retryableSessionRecoveryError);
  }

  private async resolveInitialTranscribeSession(
    context: string,
    prefetchedSession: Session | null
  ): Promise<TranscribeSessionLookup> {
    if (prefetchedSession) {
      return { session: prefetchedSession, sessionError: null };
    }

    const client = await this.options.supabaseClient.clientAsync();
    if (!client) {
      this.options.logger.warn('SpeechToText', 'Supabase client temporarily unavailable while resolving access token', { context });
      throw new Error(this.options.retryableSessionRecoveryError);
    }

    const sessionResult = await client.auth.getSession();
    return {
      session: sessionResult.data.session,
      sessionError: sessionResult.error,
    };
  }

  private assertTranscribeSessionOwner(
    session: Session | null,
    expectedOwnerUserId: string,
    context: string,
    message: string
  ): void {
    if (!session?.user?.id || session.user.id === expectedOwnerUserId) {
      return;
    }

    this.options.logger.warn('SpeechToText', message, {
      context,
      expectedOwnerUserId,
      sessionUserId: session.user.id,
    });
    throw new Error(this.options.retryableSessionRecoveryError);
  }

  private shouldRefreshTranscribeSession(session: Session | null, sessionError: { message?: string } | null): boolean {
    return !!sessionError
      || !session?.access_token
      || !session.user?.id
      || isAccessTokenExpiringSoon(session.expires_at, this.options.accessTokenExpiryBufferSeconds);
  }

  private logTranscribeSessionRefresh(
    context: string,
    session: Session | null,
    sessionError: { message?: string } | null
  ): void {
    this.options.logger.warn('SpeechToText', 'Session missing or expiring before transcribe, attempting refresh', {
      context,
      hasSession: !!session,
      hasAccessToken: !!session?.access_token,
      expiresAt: session?.expires_at ?? null,
      sessionError: sessionError?.message,
    });
  }

  private requireTranscribeAccessToken(session: Session | null, sessionError: { message?: string } | null): string {
    if (!sessionError && session?.access_token && session.user?.id) {
      return session.access_token;
    }

    this.options.logger.error('SpeechToText', 'No access token available after refresh', {
      hasAccessToken: !!session?.access_token,
      hasUserId: !!session?.user?.id,
    });
    this.options.toast.error('认证失败', '请重新登录后再试');
    throw new Error(ErrorCodes.SYNC_AUTH_EXPIRED);
  }

  private async refreshSessionForTranscribe(context: string): Promise<Session> {
    const result = await this.options.sessionManager.tryRefreshSessionWithSession(context);
    if (result.refreshed && result.session?.access_token && result.session.user?.id) {
      return result.session;
    }

    if (result.reason === 'client-unready') {
      this.options.logger.warn('SpeechToText', 'Session refresh deferred because client is temporarily unavailable', { context });
      throw new Error(this.options.retryableSessionRecoveryError);
    }

    if (result.refreshed) {
      this.options.logger.error('SpeechToText', 'Session refresh reported success but returned no usable session', { context });
    }

    this.options.logger.error('SpeechToText', 'Failed to refresh session before transcribe', { context, reason: result.reason ?? 'unknown' });
    this.options.toast.error('认证失败', '请重新登录后再试');
    throw new Error(ErrorCodes.SYNC_AUTH_EXPIRED);
  }

  private async invokeTranscribe(functionUrl: string, audioBlob: Blob, accessToken: string): Promise<Response> {
    const abortCtrl = new AbortController();
    const timeoutId = setTimeout(() => abortCtrl.abort(), this.options.config.timeoutMs);

    try {
      return await fetch(functionUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'apikey': this.options.supabaseAnonKey,
        },
        body: this.createAudioFormData(audioBlob),
        signal: abortCtrl.signal,
      });
    } catch (fetchErr) {
      if (fetchErr instanceof DOMException && fetchErr.name === 'AbortError') {
        this.options.logger.error('SpeechToText', `Transcription timed out after ${this.options.config.timeoutMs}ms`);
        this.options.toast.error('转写超时', '服务响应超慢，请缩短录音后重试');
        throw new Error(ErrorCodes.FOCUS_TRANSCRIBE_FAILED);
      }

      throw fetchErr;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private createAudioFormData(audioBlob: Blob): FormData {
    const formData = new FormData();
    const ext = getAudioFileExtension(audioBlob.type);
    formData.append('file', audioBlob, `recording.${ext}`);
    return formData;
  }

  private isRecordingOwnerActive(ownerUserId: string | null): boolean {
    return !!ownerUserId && this.options.getCurrentUserId() === ownerUserId;
  }

  private parseRetryAfterMs(value: string | null): number {
    return parseRetryAfterMs(
      value,
      this.options.defaultUpstreamRetryDelayMs,
      this.options.maxUpstreamRetryDelayMs
    );
  }
}
