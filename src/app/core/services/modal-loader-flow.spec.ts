import { describe, expect, it } from 'vitest';
import {
  classifyModalLoadFailure,
  getModalLoadFailureToast,
} from './modal-loader-flow';

describe('modal loader flow helpers', () => {
  it('continues retrying while attempts remain for non stale-chunk failures', () => {
    expect(classifyModalLoadFailure({
      attempt: 0,
      maxRetries: 2,
      staleChunk: false,
    })).toEqual({ kind: 'retry', delayMs: 1000 });
  });

  it('stops retrying immediately for stale-chunk failures', () => {
    expect(classifyModalLoadFailure({
      attempt: 0,
      maxRetries: 2,
      staleChunk: true,
    })).toEqual({ kind: 'stale-chunk' });
  });

  it('marks the last non stale-chunk attempt as exhausted', () => {
    expect(classifyModalLoadFailure({
      attempt: 2,
      maxRetries: 2,
      staleChunk: false,
    })).toEqual({ kind: 'exhausted' });
  });

  it('uses the connectivity warning after repeated modal load failures', () => {
    expect(getModalLoadFailureToast(3)).toEqual({
      title: '网络连接不稳定',
      message: '建议稍后重试或检查网络连接',
    });
  });

  it('uses the retrying copy before repeated failures cross the threshold', () => {
    expect(getModalLoadFailureToast(2)).toEqual({
      title: '加载失败',
      message: '正在重试，请稍候...',
    });
  });
});
