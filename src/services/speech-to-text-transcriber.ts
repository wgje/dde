import type { Session } from '@supabase/supabase-js';
import { ErrorCodes, ErrorMessages } from '../utils/result';
import type {
  CanonicalAuthBundle,
  CanonicalAuthStorageAuthority,
} from './supabase-auth-client-lifecycle.controller';
import {
  getAudioFileExtension,
  isAccessTokenExpiringSoon,
  isRetryableTranscribeCode,
  parseRetryAfterMs,
} from './speech-to-text.helpers';

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

type TranscribeSessionLookup = {
  fence: TranscribeAuthorityFence;
  session: Session | null;
  sessionError: { message?: string } | null;
};
type TranscribeAuthClient = {
  auth: {
    getSession: () => Promise<{
      data: { session: Session | null };
      error: { message?: string } | null;
    }>;
  };
};
type TranscribeAuthorityFence = {
  accessToken: string;
  authority: CanonicalAuthStorageAuthority;
  bundle: CanonicalAuthBundle;
  client: TranscribeAuthClient;
  ownerUserId: string;
  storageKey: string;
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
    client: () => TranscribeAuthClient;
    clientAsync: () => Promise<TranscribeAuthClient | null>;
    getStorageKey: () => string | null;
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
  getCanonicalAuthStorageAuthority: () => CanonicalAuthStorageAuthority | null;
  setRemainingQuota: (value: number) => void;
  setControlledRetryDelayMs: (value: number) => void;
};

export class SpeechToTextStaleAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpeechToTextStaleAuthorityError';
  }
}

export function isSpeechToTextStaleAuthorityError(error: unknown): boolean {
  return error instanceof Error && error.name === 'SpeechToTextStaleAuthorityError';
}

export class SpeechToTextTranscriber {
  constructor(private readonly options: SpeechToTextTranscriberOptions) {}

  async transcribe(audioBlob: Blob, expectedOwnerUserId: string | null): Promise<string> {
    const userId = expectedOwnerUserId;
    if (!userId) {
      this.options.logger.error('SpeechToText', 'Transcription aborted: user not authenticated');
      this.options.toast.error('认证失败', '请先登录后再使用语音转写功能');
      throw new Error(ErrorCodes.SYNC_AUTH_EXPIRED);
    }
    this.assertRecordingOwnerActive(userId);
    const functionUrl = `${this.options.supabaseUrl}/functions/v1/${this.options.config.edgeFunctionName}`;
    let fence = await this.resolveAccessToken('SpeechToText.transcribe', userId);
    this.assertFenceCurrent(fence);
    this.options.logger.info('SpeechToText', `Starting transcription: size=${audioBlob.size}, type=${audioBlob.type}, userId=[REDACTED]`);
    this.options.logger.debug('SpeechToText', `Invoking Edge Function: ${this.options.config.edgeFunctionName}`);
    this.options.logger.debug('SpeechToText', `Calling: ${functionUrl}`);
    const invocation = await this.invokeTranscribeWithAuthRetry(functionUrl, audioBlob, fence);
    const response = invocation.response;
    fence = invocation.fence;
    this.assertFenceCurrent(fence);
    let responseText: string;
    try {
      responseText = await response.text();
    } catch (error) {
      this.assertFenceCurrent(fence);
      throw error;
    }
    this.assertFenceCurrent(fence);
    if (!response.ok) {
      this.handleFailedTranscribeResponse(response, responseText, fence);
    }
    let data: { ok?: boolean; text?: string; duration?: number; error?: string; code?: string; retryable?: boolean };
    try {
      data = JSON.parse(responseText);
    } catch {
      this.assertFenceCurrent(fence);
      this.options.logger.error('SpeechToText', '响应非 JSON 格式', { responseText: responseText.slice(0, 200) });
      throw new Error('服务响应格式错误');
    }
    if (data.ok === false || data.code) {
      if (isRetryableTranscribeCode(data.code) || data.retryable === true) {
        this.assertFenceCurrent(fence);
        this.options.setControlledRetryDelayMs(this.parseRetryAfterMs(response.headers.get('Retry-After')));
        throw new Error(ErrorCodes.FOCUS_NETWORK_ERROR);
      }
      throw new Error(data.error || data.code || ErrorCodes.FOCUS_TRANSCRIBE_FAILED);
    }
    this.assertFenceCurrent(fence);
    this.options.logger.info('SpeechToText', `Transcription successful: ${data.text?.length || 0} chars, duration=${data.duration}s`);
    return data.text ?? '';
  }

  private async invokeTranscribeWithAuthRetry(
    functionUrl: string,
    audioBlob: Blob,
    fence: TranscribeAuthorityFence,
  ): Promise<{ response: Response; fence: TranscribeAuthorityFence }> {
    const response = await this.invokeTranscribe(functionUrl, audioBlob, fence);
    if (response.status !== 401) {
      return { response, fence };
    }
    const refreshed = await this.refreshSessionForTranscribe('SpeechToText.transcribe.retry401', fence);
    return {
      response: await this.invokeTranscribe(functionUrl, audioBlob, refreshed),
      fence: refreshed,
    };
  }

  private handleFailedTranscribeResponse(
    response: Response, responseText: string, fence: TranscribeAuthorityFence,
  ): never {
    this.assertFenceCurrent(fence);
    this.options.logger.error('SpeechToText', 'Transcription failed', JSON.stringify({
      status: response.status,
      statusText: response.statusText,
      body: responseText,
    }));
    const errorData = this.parseTranscribeErrorData(responseText, fence);
    if (errorData.code === 'QUOTA_EXCEEDED' || responseText.includes('QUOTA_EXCEEDED')) {
      this.assertFenceCurrent(fence);
      this.options.toast.warning('配额已用完', ErrorMessages[ErrorCodes.FOCUS_QUOTA_EXCEEDED]);
      this.options.setRemainingQuota(0);
      throw new Error(ErrorCodes.FOCUS_QUOTA_EXCEEDED);
    }
    if (response.status === 401 || errorData.code === 'AUTH_INVALID') {
      this.assertFenceCurrent(fence);
      this.options.toast.error('认证失败', '请重新登录后再试');
      throw new Error(ErrorCodes.SYNC_AUTH_EXPIRED);
    }
    if (isRetryableTranscribeCode(errorData.code)) {
      this.assertFenceCurrent(fence);
      this.options.setControlledRetryDelayMs(this.parseRetryAfterMs(response.headers.get('Retry-After')));
      throw new Error(ErrorCodes.FOCUS_NETWORK_ERROR);
    }
    if (errorData.code === 'SERVICE_NOT_CONFIGURED') {
      this.assertFenceCurrent(fence);
      this.options.toast.error('服务未配置', '语音转写服务未正确配置，请联系管理员');
      throw new Error(ErrorCodes.FOCUS_SERVICE_UNAVAILABLE);
    }
    throw new Error(errorData.error || errorData.message || `HTTP ${response.status}: ${response.statusText}`);
  }

  private parseTranscribeErrorData(
    responseText: string, fence: TranscribeAuthorityFence,
  ): { error?: string; code?: string; message?: string } {
    try {
      return JSON.parse(responseText);
    } catch (error) {
      this.assertFenceCurrent(fence);
      this.options.logger.debug('transcribe', '响应非 JSON 格式', { error, responseText });
      return {};
    }
  }

  private async resolveAccessToken(
    context: string,
    expectedOwnerUserId: string,
  ): Promise<TranscribeAuthorityFence> {
    try {
      await this.options.auth.ensureRuntimeAuthReady();
    } catch (error) {
      this.assertRecordingOwnerActive(expectedOwnerUserId);
      throw error;
    }
    this.assertRecordingOwnerActive(expectedOwnerUserId);
    const lookup = await this.resolveInitialTranscribeSession(expectedOwnerUserId);
    let fence = lookup.fence;
    const { session, sessionError } = lookup;
    if (this.shouldRefreshTranscribeSession(session, sessionError)) {
      fence = await this.refreshSessionForTranscribe(`${context}.getSession`, fence);
    }
    this.assertFenceCurrent(fence);
    return fence;
  }

  private assertRecordingOwnerActive(expectedOwnerUserId: string): void {
    if (this.options.getCurrentUserId() !== expectedOwnerUserId) this.throwStaleAuthority();
  }
  private async resolveInitialTranscribeSession(
    expectedOwnerUserId: string,
  ): Promise<TranscribeSessionLookup> {
    let client: TranscribeAuthClient | null;
    try {
      client = await this.options.supabaseClient.clientAsync();
    } catch (error) {
      this.assertRecordingOwnerActive(expectedOwnerUserId);
      throw error;
    }
    if (!client) {
      throw new Error(this.options.retryableSessionRecoveryError);
    }
    const fence = this.captureFence(client, expectedOwnerUserId, null);
    let sessionResult: Awaited<ReturnType<TranscribeAuthClient['auth']['getSession']>>;
    try {
      sessionResult = await client.auth.getSession();
    } catch (error) {
      this.assertFenceCurrent(fence);
      throw error;
    }
    this.assertFenceCurrent(fence);
    const session = sessionResult.data.session;
    if (session && (session.access_token !== fence.accessToken || session.user?.id !== fence.ownerUserId)) this.throwStaleAuthority();
    return {
      fence,
      session,
      sessionError: sessionResult.error,
    };
  }
  private captureFence(
    client: TranscribeAuthClient,
    expectedOwnerUserId: string,
    session: Session | null,
    previous?: TranscribeAuthorityFence,
  ): TranscribeAuthorityFence {
    this.assertClientScopeCurrent(client, expectedOwnerUserId);
    const storageKey = this.options.supabaseClient.getStorageKey();
    const authority = this.options.getCanonicalAuthStorageAuthority();
    if (!storageKey || !authority) this.throwStaleAuthority();
    if (previous && (
      previous.authority !== authority
      || previous.client !== client
      || previous.ownerUserId !== expectedOwnerUserId
      || previous.storageKey !== storageKey
    )) {
      this.throwStaleAuthority();
    }
    const bundle = this.readCanonicalBundle(authority, storageKey);
    const canonicalSession = this.parseCanonicalSession(bundle.session);
    const candidate = session ?? canonicalSession;
    if (
      !candidate.access_token
      || candidate.user?.id !== expectedOwnerUserId
      || canonicalSession.access_token !== candidate.access_token
      || canonicalSession.user?.id !== candidate.user.id
    ) this.throwStaleAuthority();
    return Object.freeze({
      accessToken: candidate.access_token,
      authority,
      bundle: Object.freeze({ ...bundle }),
      client,
      ownerUserId: expectedOwnerUserId,
      storageKey,
    });
  }

  private shouldRefreshTranscribeSession(
    session: Session | null,
    sessionError: { message?: string } | null,
  ): boolean {
    return !!sessionError
      || !session?.access_token
      || !session.user?.id
      || isAccessTokenExpiringSoon(session.expires_at, this.options.accessTokenExpiryBufferSeconds);
  }
  private async refreshSessionForTranscribe(
    context: string,
    fence: TranscribeAuthorityFence,
  ): Promise<TranscribeAuthorityFence> {
    this.assertFenceCurrent(fence);
    let result: Awaited<ReturnType<SpeechToTextTranscriberOptions['sessionManager']['tryRefreshSessionWithSession']>>;
    try {
      result = await this.options.sessionManager.tryRefreshSessionWithSession(context);
    } catch (error) {
      this.assertFenceCurrent(fence);
      throw error;
    }
    if (result.refreshed && result.session?.access_token && result.session.user?.id) {
      return this.captureFence(fence.client, fence.ownerUserId, result.session, fence);
    }
    this.assertFenceCurrent(fence);
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

  private async invokeTranscribe(
    functionUrl: string,
    audioBlob: Blob,
    fence: TranscribeAuthorityFence,
  ): Promise<Response> {
    const abortCtrl = new AbortController();
    const timeoutId = setTimeout(() => abortCtrl.abort(), this.options.config.timeoutMs);
    try {
      this.assertFenceCurrent(fence);
      const response = await fetch(functionUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${fence.accessToken}`,
          'apikey': this.options.supabaseAnonKey,
        },
        body: this.createAudioFormData(audioBlob),
        signal: abortCtrl.signal,
      });
      this.assertFenceCurrent(fence);
      return response;
    } catch (fetchErr) {
      this.assertFenceCurrent(fence);
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

  private assertClientScopeCurrent(client: TranscribeAuthClient, expectedOwnerUserId: string): void {
    this.assertRecordingOwnerActive(expectedOwnerUserId);
    try {
      if (this.options.supabaseClient.client() !== client || !this.options.supabaseClient.getStorageKey()) {
        this.throwStaleAuthority();
      }
    } catch {
      this.throwStaleAuthority();
    }
  }
  private assertFenceCurrent(fence: TranscribeAuthorityFence): void {
    this.assertClientScopeCurrent(fence.client, fence.ownerUserId);
    const storageKey = this.options.supabaseClient.getStorageKey();
    const authority = this.options.getCanonicalAuthStorageAuthority();
    if (storageKey !== fence.storageKey || authority !== fence.authority) this.throwStaleAuthority();
    const bundle = this.readCanonicalBundle(fence.authority, fence.storageKey);
    if (
      bundle.session !== fence.bundle.session
      || bundle.codeVerifier !== fence.bundle.codeVerifier
      || bundle.user !== fence.bundle.user
      || this.parseCanonicalSession(bundle.session).access_token !== fence.accessToken
    ) this.throwStaleAuthority();
  }

  private readCanonicalBundle(
    authority: CanonicalAuthStorageAuthority,
    storageKey: string,
  ): CanonicalAuthBundle & { session: string } {
    try {
      const bundle = authority.peekBundle(storageKey);
      if (
        !bundle
        || typeof bundle.session !== 'string'
        || !isNullableString(bundle.codeVerifier) || !isNullableString(bundle.user)
      ) this.throwStaleAuthority();
      return bundle as CanonicalAuthBundle & { session: string };
    } catch (error) {
      if (isSpeechToTextStaleAuthorityError(error)) throw error;
      this.throwStaleAuthority();
    }
  }
  private parseCanonicalSession(value: string): Session {
    try {
      const session = JSON.parse(value) as Session;
      if (!session?.access_token || !session.user?.id) this.throwStaleAuthority();
      return session;
    } catch (error) {
      if (isSpeechToTextStaleAuthorityError(error)) throw error;
      this.throwStaleAuthority();
    }
  }
  private throwStaleAuthority(): never {
    throw new SpeechToTextStaleAuthorityError(this.options.retryableSessionRecoveryError);
  }
  private createAudioFormData(audioBlob: Blob): FormData {
    const formData = new FormData();
    const ext = getAudioFileExtension(audioBlob.type);
    formData.append('file', audioBlob, `recording.${ext}`);
    return formData;
  }
  private parseRetryAfterMs(value: string | null): number {
    return parseRetryAfterMs(value, this.options.defaultUpstreamRetryDelayMs, this.options.maxUpstreamRetryDelayMs);
  }
}
