import type { OfflineAudioCacheState } from './speech-to-text-offline-cache.store';

export interface MediaDeviceKindLike {
  kind: string;
}

export interface MediaRecorderOptionLike {
  mimeType: string | undefined;
  audioBitsPerSecond: number;
}

export interface OfflineCacheRecordingFeedback {
  level: 'info' | 'warning';
  title: string;
  message: string;
}

export interface StartRecordingFailureFeedback {
  level: 'error';
  title: string;
  message: string;
}

export interface RecordingUnavailableFeedback {
  level: 'warning';
  title: string;
  message: string;
}

export type RecordedAudioSizeIssue = 'too-short' | 'too-long' | null;

export interface RecordedAudioSizeFeedbackMessages {
  tooShortMessage: string;
  tooLongMessage: string;
}

export interface RecordedAudioSizeFeedback {
  level: 'warning';
  title: string;
  message: string;
  result: string;
}

export interface RetryableStopTranscribeFeedback {
  shouldScheduleReplay: boolean;
  toast: {
    level: 'warning';
    title: string;
    message: string;
  };
  result: string;
}

export interface RetryableTranscribeErrorInput {
  error: unknown;
  isOnline: boolean;
  retryableSessionRecoveryError: string;
  networkErrorCode: string;
}

export function isRetryableTranscribeCode(code: unknown): boolean {
  return code === 'GROQ_TIMEOUT'
    || code === 'GROQ_UNREACHABLE'
    || code === 'GROQ_RATE_LIMITED'
    || code === 'SERVICE_UNAVAILABLE';
}

export function parseRetryAfterMs(
  value: string | null,
  defaultDelayMs: number,
  maxDelayMs: number
): number {
  if (!value) return defaultDelayMs;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, maxDelayMs);
  }

  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp) && timestamp > Date.now()) {
    return Math.min(timestamp - Date.now(), maxDelayMs);
  }

  return defaultDelayMs;
}

export function isAccessTokenExpiringSoon(
  expiresAt: number | null | undefined,
  bufferSeconds: number
): boolean {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    return false;
  }

  const expiresAtSec = expiresAt > 1e12 ? Math.floor(expiresAt / 1000) : expiresAt;
  const nowSec = Math.floor(Date.now() / 1000);
  return expiresAtSec <= nowSec + bufferSeconds;
}

export function getAudioFileExtension(mimeType: string): 'mp4' | 'ogg' | 'wav' | 'webm' {
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('wav')) return 'wav';
  return 'webm';
}

export function resolveFirstSupportedAudioMimeType(
  mimeTypes: readonly string[],
  isTypeSupported: (mimeType: string) => boolean
): string {
  for (const type of mimeTypes) {
    if (isTypeSupported(type)) {
      return type;
    }
  }

  return '';
}

export function hasAudioInputDevice(devices: readonly MediaDeviceKindLike[]): boolean {
  return devices.some(device => device.kind === 'audioinput');
}

export function buildMediaRecorderOptions(
  mimeType: string,
  audioBitsPerSecond: number
): MediaRecorderOptionLike {
  return {
    mimeType: mimeType || undefined,
    audioBitsPerSecond,
  };
}

export function resolveRecordedAudioSizeIssue(
  sizeBytes: number,
  minFileSizeBytes: number,
  maxFileSizeBytes: number
): RecordedAudioSizeIssue {
  if (sizeBytes < minFileSizeBytes) {
    return 'too-short';
  }

  if (sizeBytes > maxFileSizeBytes) {
    return 'too-long';
  }

  return null;
}

export function resolveRecordedAudioSizeFeedback(
  sizeIssue: RecordedAudioSizeIssue,
  messages: RecordedAudioSizeFeedbackMessages
): RecordedAudioSizeFeedback | null {
  if (sizeIssue === 'too-short') {
    return {
      level: 'warning',
      title: '录音太短',
      message: messages.tooShortMessage,
      result: '',
    };
  }

  if (sizeIssue === 'too-long') {
    return {
      level: 'warning',
      title: '录音太长',
      message: messages.tooLongMessage,
      result: '',
    };
  }

  return null;
}

export interface RetryableTranscribeReplayDelayInput {
  isControlledUpstreamRetryableError: boolean;
  controlledDelayMs: number | null;
  defaultUpstreamRetryDelayMs: number;
  offlineReplayRetryDelayMs: number;
}

export function resolveRetryableTranscribeReplayDelayMs(
  input: RetryableTranscribeReplayDelayInput
): number {
  if (!input.isControlledUpstreamRetryableError) {
    return input.offlineReplayRetryDelayMs;
  }

  return input.controlledDelayMs ?? input.defaultUpstreamRetryDelayMs;
}

export function isControlledUpstreamRetryableTranscribeError(
  error: unknown,
  isOnline: boolean,
  networkErrorCode: string
): boolean {
  return error instanceof Error
    && error.message === networkErrorCode
    && isOnline;
}

export function isRetryableTranscribeError(input: RetryableTranscribeErrorInput): boolean {
  return input.error instanceof TypeError
    || (input.error instanceof Error && input.error.message === input.retryableSessionRecoveryError)
    || (input.error instanceof Error && input.error.message === input.networkErrorCode)
    || !input.isOnline;
}

export function shouldScheduleOfflineCacheReplay(
  destroyed: boolean,
  isOnline: boolean,
  hasScheduledReplay: boolean
): boolean {
  return !destroyed && isOnline && !hasScheduledReplay;
}

export function resolveOfflineCacheRecordingFeedback(
  cacheState: OfflineAudioCacheState
): OfflineCacheRecordingFeedback {
  if (cacheState === 'quarantined') {
    return {
      level: 'warning',
      title: '录音已隔离',
      message: '当前账号未稳定，这条录音不会自动转写',
    };
  }

  return {
    level: 'info',
    title: '录音已保存',
    message: '已保存，联网后自动转写',
  };
}

export function resolveRetryableStopTranscribeFeedback(
  cacheState: OfflineAudioCacheState,
  networkErrorMessage: string
): RetryableStopTranscribeFeedback {
  if (cacheState === 'owned') {
    return {
      shouldScheduleReplay: true,
      toast: {
        level: 'warning',
        title: '转写失败',
        message: networkErrorMessage,
      },
      result: '[转写失败，稍后重试]',
    };
  }

  return {
    shouldScheduleReplay: false,
    toast: {
      level: 'warning',
      title: '录音已隔离',
      message: '当前账号未稳定，这条录音不会自动转写',
    },
    result: '[转写失败，稍后重试]',
  };
}

export function resolveRecordingUnavailableFeedback(): RecordingUnavailableFeedback {
  return {
    level: 'warning',
    title: '录音不可用',
    message: '未找到麦克风设备或不支持录音功能',
  };
}

export function resolveStartRecordingFailureFeedback(
  error: unknown,
  permissionDeniedMessage: string
): StartRecordingFailureFeedback {
  if (!(error instanceof DOMException)) {
    return {
      level: 'error',
      title: '录音失败',
      message: '无法启动录音',
    };
  }

  if (error.name === 'NotAllowedError') {
    return {
      level: 'error',
      title: '录音失败',
      message: permissionDeniedMessage,
    };
  }

  if (error.name === 'NotFoundError') {
    return {
      level: 'error',
      title: '录音失败',
      message: '未找到麦克风设备',
    };
  }

  return {
    level: 'error',
    title: '录音失败',
    message: `设备错误: ${error.message}`,
  };
}
