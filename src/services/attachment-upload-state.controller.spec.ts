import { afterEach, describe, expect, it, vi } from 'vitest';

import { AttachmentUploadStateController } from './attachment-upload-state.controller';

describe('AttachmentUploadStateController', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tracks active uploads and initial progress when an upload begins', () => {
    const state = new AttachmentUploadStateController();
    const abortController = new AbortController();

    state.beginUpload('report.pdf', abortController);

    expect(state.isUploading()).toBe(true);
    expect(state.isFileUploading('report.pdf')).toBe(true);
    expect(state.getActiveUploadCount()).toBe(1);
    expect(state.uploadProgress()).toEqual([
      { fileName: 'report.pdf', progress: 0, status: 'uploading', error: undefined },
    ]);
  });

  it('keeps uploading true until the last active upload finishes', () => {
    const state = new AttachmentUploadStateController();

    state.beginUpload('a.txt', new AbortController());
    state.beginUpload('b.txt', new AbortController());

    state.finishUpload('a.txt');

    expect(state.isUploading()).toBe(true);
    expect(state.getActiveUploadCount()).toBe(1);

    state.finishUpload('b.txt');

    expect(state.isUploading()).toBe(false);
    expect(state.getActiveUploadCount()).toBe(0);
  });

  it('cancels one active upload and records cancelled progress', () => {
    const state = new AttachmentUploadStateController();
    const abortController = new AbortController();
    const abort = vi.spyOn(abortController, 'abort');

    state.beginUpload('cancel-me.txt', abortController);

    expect(state.cancelUpload('cancel-me.txt')).toBe(true);

    expect(abort).toHaveBeenCalledTimes(1);
    expect(abortController.signal.aborted).toBe(true);
    expect(state.isFileUploading('cancel-me.txt')).toBe(false);
    expect(state.isUploading()).toBe(false);
    expect(state.uploadProgress()).toEqual([
      { fileName: 'cancel-me.txt', progress: 0, status: 'cancelled', error: undefined },
    ]);
  });

  it('returns false when cancelling a file that is not active', () => {
    const state = new AttachmentUploadStateController();

    expect(state.cancelUpload('missing.txt')).toBe(false);
    expect(state.isUploading()).toBe(false);
  });

  it('cancels every active upload and clears active state', () => {
    const state = new AttachmentUploadStateController();
    const firstController = new AbortController();
    const secondController = new AbortController();

    state.beginUpload('first.txt', firstController);
    state.beginUpload('second.txt', secondController);
    state.cancelAllUploads();

    expect(firstController.signal.aborted).toBe(true);
    expect(secondController.signal.aborted).toBe(true);
    expect(state.getActiveUploadCount()).toBe(0);
    expect(state.isUploading()).toBe(false);
    expect(state.uploadProgress()).toEqual([
      { fileName: 'first.txt', progress: 0, status: 'cancelled', error: undefined },
      { fileName: 'second.txt', progress: 0, status: 'cancelled', error: undefined },
    ]);
  });

  it('updates existing progress rows instead of duplicating them', () => {
    const state = new AttachmentUploadStateController();

    state.updateProgress('same.txt', 0, 'uploading');
    state.updateProgress('same.txt', 50, 'uploading');
    state.updateProgress('same.txt', 0, 'error', 'network failed');

    expect(state.uploadProgress()).toEqual([
      { fileName: 'same.txt', progress: 0, status: 'error', error: 'network failed' },
    ]);
  });

  it('auto-clears completed and error progress after the retention delay', async () => {
    vi.useFakeTimers();
    const state = new AttachmentUploadStateController();

    state.updateProgress('done.txt', 100, 'completed');
    state.updateProgress('failed.txt', 0, 'error', 'failed');
    state.updateProgress('cancelled.txt', 0, 'cancelled');

    await vi.advanceTimersByTimeAsync(2999);
    expect(state.uploadProgress()).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(1);

    expect(state.uploadProgress()).toEqual([
      { fileName: 'cancelled.txt', progress: 0, status: 'cancelled', error: undefined },
    ]);
  });

  it('clears progress on demand', () => {
    const state = new AttachmentUploadStateController();

    state.updateProgress('uploading.txt', 20, 'uploading');
    state.clearProgress();

    expect(state.uploadProgress()).toEqual([]);
  });
});
