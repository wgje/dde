import { describe, expect, it, vi } from 'vitest';
import {
  buildMediaRecorderOptions,
  getAudioFileExtension,
  hasAudioInputDevice,
  isAccessTokenExpiringSoon,
  isControlledUpstreamRetryableTranscribeError,
  isRetryableTranscribeCode,
  isRetryableTranscribeError,
  parseRetryAfterMs,
  resolveFirstSupportedAudioMimeType,
  resolveOfflineCacheRecordingFeedback,
  resolveRecordedAudioSizeFeedback,
  resolveRecordedAudioSizeIssue,
  resolveRecordingUnavailableFeedback,
  resolveRetryableStopTranscribeFeedback,
  resolveRetryableTranscribeReplayDelayMs,
  resolveStartRecordingFailureFeedback,
  shouldScheduleOfflineCacheReplay,
} from './speech-to-text.helpers';

describe('speech-to-text helpers', () => {
  it('detects retryable upstream transcribe codes', () => {
    expect(isRetryableTranscribeCode('GROQ_TIMEOUT')).toBe(true);
    expect(isRetryableTranscribeCode('GROQ_UNREACHABLE')).toBe(true);
    expect(isRetryableTranscribeCode('GROQ_RATE_LIMITED')).toBe(true);
    expect(isRetryableTranscribeCode('SERVICE_UNAVAILABLE')).toBe(true);
    expect(isRetryableTranscribeCode('AUTH_INVALID')).toBe(false);
  });

  it('parses Retry-After seconds and caps long delays', () => {
    expect(parseRetryAfterMs('5', 30_000, 15_000)).toBe(5_000);
    expect(parseRetryAfterMs('60', 30_000, 15_000)).toBe(15_000);
    expect(parseRetryAfterMs(null, 30_000, 15_000)).toBe(30_000);
  });

  it('parses future Retry-After dates relative to now', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-08T00:00:00.000Z'));

    expect(parseRetryAfterMs('2026-06-08T00:00:10.000Z', 30_000, 15_000)).toBe(10_000);

    vi.useRealTimers();
  });

  it('detects expiring access tokens with seconds or milliseconds timestamps', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-08T00:00:00.000Z'));

    const nowSec = Math.floor(Date.now() / 1000);
    expect(isAccessTokenExpiringSoon(nowSec + 30, 60)).toBe(true);
    expect(isAccessTokenExpiringSoon((nowSec + 30) * 1000, 60)).toBe(true);
    expect(isAccessTokenExpiringSoon(nowSec + 120, 60)).toBe(false);
    expect(isAccessTokenExpiringSoon(null, 60)).toBe(false);

    vi.useRealTimers();
  });

  it('maps audio MIME types to stable upload extensions', () => {
    expect(getAudioFileExtension('audio/mp4')).toBe('mp4');
    expect(getAudioFileExtension('audio/ogg')).toBe('ogg');
    expect(getAudioFileExtension('audio/wav')).toBe('wav');
    expect(getAudioFileExtension('audio/webm')).toBe('webm');
  });

  it('selects the first supported recording MIME type and falls back to browser default', () => {
    const isTypeSupported = vi.fn((type: string) => type === 'audio/mp4');

    expect(resolveFirstSupportedAudioMimeType(
      ['audio/webm', 'audio/mp4', 'audio/wav'],
      isTypeSupported
    )).toBe('audio/mp4');
    expect(resolveFirstSupportedAudioMimeType(
      ['audio/webm', 'audio/ogg'],
      isTypeSupported
    )).toBe('');
  });

  it('detects whether media devices include an audio input', () => {
    expect(hasAudioInputDevice([
      { kind: 'videoinput' },
      { kind: 'audiooutput' },
      { kind: 'audioinput' },
    ])).toBe(true);
    expect(hasAudioInputDevice([
      { kind: 'videoinput' },
      { kind: 'audiooutput' },
    ])).toBe(false);
  });

  it('builds MediaRecorder options with browser-default MIME fallback', () => {
    expect(buildMediaRecorderOptions('audio/webm', 128_000)).toEqual({
      mimeType: 'audio/webm',
      audioBitsPerSecond: 128_000,
    });
    expect(buildMediaRecorderOptions('', 128_000)).toEqual({
      mimeType: undefined,
      audioBitsPerSecond: 128_000,
    });
  });

  it('classifies recorded audio size against configured limits', () => {
    expect(resolveRecordedAudioSizeIssue(999, 1_000, 5_000)).toBe('too-short');
    expect(resolveRecordedAudioSizeIssue(1_000, 1_000, 5_000)).toBeNull();
    expect(resolveRecordedAudioSizeIssue(5_000, 1_000, 5_000)).toBeNull();
    expect(resolveRecordedAudioSizeIssue(5_001, 1_000, 5_000)).toBe('too-long');
  });

  it.each([
    {
      sizeIssue: 'too-short' as const,
      expected: {
        level: 'warning',
        title: '录音太短',
        message: '录音时间太短，请至少录制 1 秒',
        result: '',
      },
    },
    {
      sizeIssue: 'too-long' as const,
      expected: {
        level: 'warning',
        title: '录音太长',
        message: '录音文件过大，请缩短录音时间',
        result: '',
      },
    },
    {
      sizeIssue: null,
      expected: null,
    },
  ])('maps recorded audio size issue $sizeIssue to feedback', ({ sizeIssue, expected }) => {
    expect(resolveRecordedAudioSizeFeedback(
      sizeIssue,
      {
        tooShortMessage: '录音时间太短，请至少录制 1 秒',
        tooLongMessage: '录音文件过大，请缩短录音时间',
      }
    )).toEqual(expected);
  });

  it('resolves retryable transcribe replay delay by upstream control state', () => {
    expect(resolveRetryableTranscribeReplayDelayMs({
      isControlledUpstreamRetryableError: true,
      controlledDelayMs: 5_000,
      defaultUpstreamRetryDelayMs: 30_000,
      offlineReplayRetryDelayMs: 1_500,
    })).toBe(5_000);

    expect(resolveRetryableTranscribeReplayDelayMs({
      isControlledUpstreamRetryableError: true,
      controlledDelayMs: null,
      defaultUpstreamRetryDelayMs: 30_000,
      offlineReplayRetryDelayMs: 1_500,
    })).toBe(30_000);

    expect(resolveRetryableTranscribeReplayDelayMs({
      isControlledUpstreamRetryableError: false,
      controlledDelayMs: 5_000,
      defaultUpstreamRetryDelayMs: 30_000,
      offlineReplayRetryDelayMs: 1_500,
    })).toBe(1_500);
  });

  it('classifies controlled upstream retryable errors only while online', () => {
    expect(isControlledUpstreamRetryableTranscribeError(
      new Error('FOCUS_NETWORK_ERROR'),
      true,
      'FOCUS_NETWORK_ERROR'
    )).toBe(true);
    expect(isControlledUpstreamRetryableTranscribeError(
      new Error('FOCUS_NETWORK_ERROR'),
      false,
      'FOCUS_NETWORK_ERROR'
    )).toBe(false);
    expect(isControlledUpstreamRetryableTranscribeError(
      new TypeError('network failed'),
      true,
      'FOCUS_NETWORK_ERROR'
    )).toBe(false);
    expect(isControlledUpstreamRetryableTranscribeError(
      new Error('SESSION_TEMPORARILY_UNAVAILABLE'),
      true,
      'FOCUS_NETWORK_ERROR'
    )).toBe(false);
  });

  it.each([
    { error: new TypeError('network failed'), isOnline: true, expected: true },
    { error: new Error('SESSION_TEMPORARILY_UNAVAILABLE'), isOnline: true, expected: true },
    { error: new Error('FOCUS_NETWORK_ERROR'), isOnline: true, expected: true },
    { error: new Error('plain failure'), isOnline: false, expected: true },
    { error: new Error('plain failure'), isOnline: true, expected: false },
  ])('classifies retryable transcribe error by error shape and online state', ({ error, isOnline, expected }) => {
    expect(isRetryableTranscribeError({
      error,
      isOnline,
      retryableSessionRecoveryError: 'SESSION_TEMPORARILY_UNAVAILABLE',
      networkErrorCode: 'FOCUS_NETWORK_ERROR',
    })).toBe(expected);
  });

  it('allows offline cache replay scheduling only when live online and idle', () => {
    expect(shouldScheduleOfflineCacheReplay(false, true, false)).toBe(true);
    expect(shouldScheduleOfflineCacheReplay(true, true, false)).toBe(false);
    expect(shouldScheduleOfflineCacheReplay(false, false, false)).toBe(false);
    expect(shouldScheduleOfflineCacheReplay(false, true, true)).toBe(false);
  });

  it.each([
    {
      cacheState: 'quarantined' as const,
      expected: {
        level: 'warning',
        title: '录音已隔离',
        message: '当前账号未稳定，这条录音不会自动转写',
      },
    },
    {
      cacheState: 'owned' as const,
      expected: {
        level: 'info',
        title: '录音已保存',
        message: '已保存，联网后自动转写',
      },
    },
  ])('maps $cacheState offline cache state to recording feedback', ({ cacheState, expected }) => {
    expect(resolveOfflineCacheRecordingFeedback(cacheState)).toEqual(expected);
  });

  it.each([
    {
      cacheState: 'owned' as const,
      expected: {
        shouldScheduleReplay: true,
        toast: {
          level: 'warning',
          title: '转写失败',
          message: '网络错误，请检查连接后重试',
        },
        result: '[转写失败，稍后重试]',
      },
    },
    {
      cacheState: 'quarantined' as const,
      expected: {
        shouldScheduleReplay: false,
        toast: {
          level: 'warning',
          title: '录音已隔离',
          message: '当前账号未稳定，这条录音不会自动转写',
        },
        result: '[转写失败，稍后重试]',
      },
    },
  ])('maps retryable stop transcribe cache state $cacheState to replay and feedback decisions', ({ cacheState, expected }) => {
    expect(resolveRetryableStopTranscribeFeedback(
      cacheState,
      '网络错误，请检查连接后重试'
    )).toEqual(expected);
  });

  it.each([
    {
      error: new DOMException('denied', 'NotAllowedError'),
      expectedMessage: '需要麦克风权限才能录音',
    },
    {
      error: new DOMException('missing', 'NotFoundError'),
      expectedMessage: '未找到麦克风设备',
    },
    {
      error: new DOMException('hardware busy', 'NotReadableError'),
      expectedMessage: '设备错误: hardware busy',
    },
    {
      error: new Error('plain failure'),
      expectedMessage: '无法启动录音',
    },
  ])('maps start recording error to toast feedback', ({ error, expectedMessage }) => {
    expect(resolveStartRecordingFailureFeedback(
      error,
      '需要麦克风权限才能录音'
    )).toEqual({
      level: 'error',
      title: '录音失败',
      message: expectedMessage,
    });
  });

  it('maps unavailable microphone state to warning feedback', () => {
    expect(resolveRecordingUnavailableFeedback()).toEqual({
      level: 'warning',
      title: '录音不可用',
      message: '未找到麦克风设备或不支持录音功能',
    });
  });
});
