import { describe, expect, it, vi, type Mock } from 'vitest';
import { replayOfflineAudioItems } from './speech-to-text-offline-replay';
import { SpeechToTextOfflineReplayController } from './speech-to-text-offline-replay.controller';
import type { OfflineAudioCacheEntry } from '../models/focus';

type TranscribeBlobMock = Mock<(blob: Blob, expectedOwnerUserId: string | null) => Promise<string>>;
type QuarantineMock = Mock<(id: string) => Promise<boolean>>;

const createEntry = (id: string, ownerUserId: string | null): OfflineAudioCacheEntry => ({
  id,
  ownerUserId,
  blob: new Blob([id], { type: 'audio/webm' }),
  createdAt: '2026-06-08T00:00:00.000Z',
  mimeType: 'audio/webm',
});

describe('replayOfflineAudioItems', () => {
  it('skips quarantined and foreign-owner cached audio', async () => {
    const transcribe = vi.fn();

    const result = await replayOfflineAudioItems({
      items: [
        createEntry('unknown', '__legacy_unknown_owner__'),
        createEntry('foreign', 'user-b'),
      ],
      replayOwnerUserId: 'user-a',
      unknownOwnerUserId: '__legacy_unknown_owner__',
      batchSize: 2,
      isReplayOwnerActive: () => true,
      transcribe,
      persist: vi.fn().mockResolvedValue(true),
      deleteFromCache: vi.fn(),
      onQuarantinedSkip: vi.fn(),
      onForeignOwnerSkip: vi.fn(),
      onOwnerChangedBeforeItem: vi.fn(),
      onOwnerChangedBeforePersistence: vi.fn(),
      onPersistenceFailure: vi.fn(),
      onProcessed: vi.fn(),
      onError: vi.fn(() => 'continue' as const),
    });

    expect(result).toEqual({ results: [], stoppedByBudget: false });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('stops before processing when the replay owner is no longer active', async () => {
    const onOwnerChangedBeforeItem = vi.fn();

    const result = await replayOfflineAudioItems({
      items: [createEntry('audio-1', 'user-a')],
      replayOwnerUserId: 'user-a',
      unknownOwnerUserId: '__legacy_unknown_owner__',
      batchSize: 2,
      isReplayOwnerActive: () => false,
      transcribe: vi.fn(),
      persist: vi.fn().mockResolvedValue(true),
      deleteFromCache: vi.fn(),
      onQuarantinedSkip: vi.fn(),
      onForeignOwnerSkip: vi.fn(),
      onOwnerChangedBeforeItem,
      onOwnerChangedBeforePersistence: vi.fn(),
      onPersistenceFailure: vi.fn(),
      onProcessed: vi.fn(),
      onError: vi.fn(() => 'continue' as const),
    });

    expect(result).toEqual({ results: [], stoppedByBudget: false });
    expect(onOwnerChangedBeforeItem).toHaveBeenCalledWith('user-a');
  });

  it('processes only up to the owned batch budget', async () => {
    const deleteFromCache = vi.fn();

    const result = await replayOfflineAudioItems({
      items: [
        createEntry('audio-1', 'user-a'),
        createEntry('audio-2', 'user-a'),
      ],
      replayOwnerUserId: 'user-a',
      unknownOwnerUserId: '__legacy_unknown_owner__',
      batchSize: 1,
      isReplayOwnerActive: () => true,
      transcribe: vi.fn().mockResolvedValue('transcribed'),
      persist: vi.fn().mockResolvedValue(true),
      deleteFromCache,
      onQuarantinedSkip: vi.fn(),
      onForeignOwnerSkip: vi.fn(),
      onOwnerChangedBeforeItem: vi.fn(),
      onOwnerChangedBeforePersistence: vi.fn(),
      onPersistenceFailure: vi.fn(),
      onProcessed: vi.fn(),
      onError: vi.fn(() => 'continue' as const),
    });

    expect(result).toEqual({
      results: [{ id: 'audio-1', text: 'transcribed' }],
      stoppedByBudget: true,
    });
    expect(deleteFromCache).toHaveBeenCalledWith('audio-1');
  });

  it('keeps the cache entry and stops the batch when persistence fails', async () => {
    const deleteFromCache = vi.fn();
    const transcribe = vi.fn().mockResolvedValue('transcribed');

    const result = await replayOfflineAudioItems({
      items: [createEntry('audio-1', 'user-a'), createEntry('audio-2', 'user-a')],
      replayOwnerUserId: 'user-a',
      unknownOwnerUserId: '__legacy_unknown_owner__',
      batchSize: 2,
      isReplayOwnerActive: () => true,
      transcribe,
      persist: vi.fn().mockResolvedValue(false),
      deleteFromCache,
      onQuarantinedSkip: vi.fn(),
      onForeignOwnerSkip: vi.fn(),
      onOwnerChangedBeforeItem: vi.fn(),
      onOwnerChangedBeforePersistence: vi.fn(),
      onPersistenceFailure: vi.fn(),
      onProcessed: vi.fn(),
      onError: vi.fn(() => 'continue' as const),
    });

    expect(result).toEqual({ results: [], stoppedByBudget: false });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(deleteFromCache).not.toHaveBeenCalled();
  });

  it('does not report an item as processed when cache deletion fails after persistence', async () => {
    const onError = vi.fn(() => 'stop' as const);
    const onProcessed = vi.fn();

    const result = await replayOfflineAudioItems({
      items: [createEntry('audio-delete-fail', 'user-a'), createEntry('audio-next', 'user-a')],
      replayOwnerUserId: 'user-a',
      unknownOwnerUserId: '__legacy_unknown_owner__',
      batchSize: 2,
      isReplayOwnerActive: () => true,
      transcribe: vi.fn().mockResolvedValue('transcribed'),
      persist: vi.fn().mockResolvedValue(true),
      deleteFromCache: vi.fn().mockRejectedValue(new Error('delete failed')),
      onQuarantinedSkip: vi.fn(),
      onForeignOwnerSkip: vi.fn(),
      onOwnerChangedBeforeItem: vi.fn(),
      onOwnerChangedBeforePersistence: vi.fn(),
      onPersistenceFailure: vi.fn(),
      onProcessed,
      onError,
    });

    expect(result).toEqual({ results: [], stoppedByBudget: false });
    expect(onProcessed).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'audio-delete-fail');
  });

  it('delegates item errors and stops when requested', async () => {
    const onError = vi.fn(() => 'stop' as const);

    const result = await replayOfflineAudioItems({
      items: [createEntry('audio-1', 'user-a'), createEntry('audio-2', 'user-a')],
      replayOwnerUserId: 'user-a',
      unknownOwnerUserId: '__legacy_unknown_owner__',
      batchSize: 2,
      isReplayOwnerActive: () => true,
      transcribe: vi.fn().mockRejectedValue(new Error('temporary')),
      persist: vi.fn().mockResolvedValue(true),
      deleteFromCache: vi.fn(),
      onQuarantinedSkip: vi.fn(),
      onForeignOwnerSkip: vi.fn(),
      onOwnerChangedBeforeItem: vi.fn(),
      onOwnerChangedBeforePersistence: vi.fn(),
      onPersistenceFailure: vi.fn(),
      onProcessed: vi.fn(),
      onError,
    });

    expect(result).toEqual({ results: [], stoppedByBudget: false });
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'audio-1');
  });

  it('continues past a failing item when the error handler resolves continue asynchronously', async () => {
    const onError = vi.fn(async () => 'continue' as const);
    const transcribe = vi.fn()
      .mockRejectedValueOnce(new Error('permanent rejection'))
      .mockResolvedValueOnce('transcribed ok');

    const result = await replayOfflineAudioItems({
      items: [createEntry('audio-poison', 'user-a'), createEntry('audio-good', 'user-a')],
      replayOwnerUserId: 'user-a',
      unknownOwnerUserId: '__legacy_unknown_owner__',
      batchSize: 2,
      isReplayOwnerActive: () => true,
      transcribe,
      persist: vi.fn().mockResolvedValue(true),
      deleteFromCache: vi.fn(),
      onQuarantinedSkip: vi.fn(),
      onForeignOwnerSkip: vi.fn(),
      onOwnerChangedBeforeItem: vi.fn(),
      onOwnerChangedBeforePersistence: vi.fn(),
      onPersistenceFailure: vi.fn(),
      onProcessed: vi.fn(),
      onError,
    });

    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'audio-poison');
    expect(result).toEqual({
      results: [{ id: 'audio-good', text: 'transcribed ok' }],
      stoppedByBudget: false,
    });
  });
});

describe('SpeechToTextOfflineReplayController 永久失败隔离', () => {
  function createControllerHarness(options: {
    transcribeBlob: TranscribeBlobMock;
    isRetryableTranscribeError?: (error: unknown) => boolean;
    quarantine?: QuarantineMock;
  }) {
    const quarantine = options.quarantine ?? vi.fn<(id: string) => Promise<boolean>>().mockResolvedValue(true);
    const toastWarning = vi.fn();
    const scheduleRetryableTranscribeReplay = vi.fn();
    const items = [
      createEntry('audio-poison', 'user-a'),
      createEntry('audio-good', 'user-a'),
    ];
    const controller = new SpeechToTextOfflineReplayController({
      batchSize: 2,
      cacheStore: {
        countOwnedBy: vi.fn().mockResolvedValue(0),
        delete: vi.fn().mockResolvedValue(undefined),
        migrateLegacyOwners: vi.fn().mockResolvedValue(0),
        quarantine,
        readAll: vi.fn().mockResolvedValue(items),
      },
      continuationDelayMs: 15000,
      createBlackBoxEntry: vi.fn().mockResolvedValue({ ok: true }),
      currentUserId: () => 'user-a',
      deleteFromCache: vi.fn().mockResolvedValue(undefined),
      ensureReady: () => undefined,
      isOnline: () => true,
      isRetryableTranscribeError: options.isRetryableTranscribeError ?? (() => false),
      logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
      runTranscribing: operation => operation(),
      scheduleContinuation: vi.fn(),
      scheduleRetryableTranscribeReplay,
      toastWarning,
      transcribeBlob: options.transcribeBlob,
      unknownOwnerUserId: '__legacy_unknown_owner__',
      updatePendingCount: vi.fn().mockResolvedValue(undefined),
    });
    return { controller, quarantine, scheduleRetryableTranscribeReplay, toastWarning };
  }

  it('永久拒绝的录音应被隔离并让批次继续处理后续录音', async () => {
    const transcribeBlob: TranscribeBlobMock = vi.fn<(blob: Blob, expectedOwnerUserId: string | null) => Promise<string>>()
      .mockRejectedValueOnce(new Error('invalid audio payload'))
      .mockResolvedValueOnce('transcribed ok');
    const { controller, quarantine, toastWarning } = createControllerHarness({ transcribeBlob });

    const results = await controller.processOfflineCache();

    expect(quarantine).toHaveBeenCalledWith('audio-poison');
    expect(toastWarning).toHaveBeenCalledWith('录音已隔离', expect.any(String));
    expect(results).toEqual([{ id: 'audio-good', text: 'transcribed ok' }]);
  });

  it('可重试错误不应隔离录音，保持原有 stop + 重试调度行为', async () => {
    const transcribeBlob: TranscribeBlobMock = vi.fn<(blob: Blob, expectedOwnerUserId: string | null) => Promise<string>>()
      .mockRejectedValue(new Error('network flake'));
    const { controller, quarantine, scheduleRetryableTranscribeReplay } = createControllerHarness({
      transcribeBlob,
      isRetryableTranscribeError: () => true,
    });

    const results = await controller.processOfflineCache();

    expect(quarantine).not.toHaveBeenCalled();
    expect(scheduleRetryableTranscribeReplay).toHaveBeenCalledWith(
      expect.any(Error),
      'offline-replay-retryable-error',
    );
    expect(results).toEqual([]);
  });

  it('隔离写入失败时应记录告警且不中断批次', async () => {
    const transcribeBlob: TranscribeBlobMock = vi.fn<(blob: Blob, expectedOwnerUserId: string | null) => Promise<string>>()
      .mockRejectedValueOnce(new Error('invalid audio payload'))
      .mockResolvedValueOnce('transcribed ok');
    const quarantine: QuarantineMock = vi.fn<(id: string) => Promise<boolean>>()
      .mockRejectedValue(new Error('idb write failed'));
    const { controller } = createControllerHarness({ transcribeBlob, quarantine });

    const results = await controller.processOfflineCache();

    expect(results).toEqual([{ id: 'audio-good', text: 'transcribed ok' }]);
  });
});
