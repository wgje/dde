import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchWithRetry,
  supabaseWithRetry,
  supabaseWithTimeout,
  withTimeout,
} from './timeout';

describe('timeout — withTimeout', () => {
  it('Promise 在超时前 resolve → 正常返回值', async () => {
    const result = await withTimeout(Promise.resolve(42), { timeout: 1000 });
    expect(result).toBe(42);
  });

  it('Promise 超时时抛出带自定义消息的错误', async () => {
    const slow = new Promise<number>((resolve) => setTimeout(() => resolve(1), 50));
    await expect(
      withTimeout(slow, { timeout: 5, timeoutMessage: '自定义超时' }),
    ).rejects.toThrow('自定义超时');
  });

  it('超时时抛出包含默认毫秒数的错误消息', async () => {
    const slow = new Promise<number>((resolve) => setTimeout(() => resolve(1), 50));
    await expect(withTimeout(slow, { timeout: 5 })).rejects.toThrow(/5ms/);
  });

  it('接受字符串级别作为 timeout（TimeoutLevel）', async () => {
    const result = await withTimeout(Promise.resolve('ok'), { timeout: 'QUICK' });
    expect(result).toBe('ok');
  });

  it('外部 signal 在执行期间中止 → 中止整个等待', async () => {
    const controller = new AbortController();
    const promise = withTimeout(
      new Promise<number>((resolve) => setTimeout(() => resolve(1), 500)),
      { timeout: 1000, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toThrow();
  });

  it('underlying Promise 抛错时直接透传错误', async () => {
    const err = new Error('inner-failure');
    await expect(withTimeout(Promise.reject(err), { timeout: 1000 })).rejects.toBe(err);
  });
});

describe('timeout — supabaseWithTimeout', () => {
  it('包装 thenable 并返回结果', async () => {
    const fn = () => Promise.resolve({ data: 'ok', error: null });
    const res = await supabaseWithTimeout(fn, 'QUICK');
    expect(res.data).toBe('ok');
  });
});

describe('timeout — supabaseWithRetry', () => {
  it('首次成功时不触发重试', async () => {
    const fn = vi.fn().mockResolvedValue({ data: 1, error: null });
    const res = await supabaseWithRetry(fn);
    expect(res).toEqual({ data: 1, error: null });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('可重试错误触发重试并最终成功', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValue({ data: 'ok', error: null });
    const onRetry = vi.fn();

    const res = await supabaseWithRetry(fn, {
      maxRetries: 2,
      onRetry,
    });
    expect(res).toEqual({ data: 'ok', error: null });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
  });

  it('不可重试错误立即抛出（无重试）', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Invalid credentials'));
    await expect(supabaseWithRetry(fn, { maxRetries: 3 })).rejects.toThrow('Invalid credentials');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('达到 maxRetries 后抛出最后的错误', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fetch failed'));
    await expect(
      supabaseWithRetry(fn, { maxRetries: 2, onRetry: () => undefined }),
    ).rejects.toThrow('fetch failed');
    // 1 次初始 + 2 次重试 = 3 次调用
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('enableRetry=false 禁用重试', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('network'));
    await expect(supabaseWithRetry(fn, { enableRetry: false })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('可重试的 HTTP 状态码（503）触发重试', async () => {
    const err = Object.assign(new Error('server unavailable'), { status: 503 });
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue('ok');
    const res = await supabaseWithRetry(fn, { maxRetries: 1 });
    expect(res).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('不可重试的 HTTP 状态码（401）不触发重试', async () => {
    const err = Object.assign(new Error('unauthorized'), { status: 401 });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(supabaseWithRetry(fn, { maxRetries: 3 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('AbortError/TimeoutError 被视为可重试', async () => {
    const abortErr = Object.assign(new Error('timeout'), { name: 'AbortError' });
    const fn = vi.fn()
      .mockRejectedValueOnce(abortErr)
      .mockResolvedValue('recovered');
    const res = await supabaseWithRetry(fn, { maxRetries: 1 });
    expect(res).toBe('recovered');
  });

  it('自定义 shouldRetry 覆盖默认判断', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('custom-error'))
      .mockResolvedValue('ok');
    const shouldRetry = vi.fn().mockReturnValue(true);

    const res = await supabaseWithRetry(fn, {
      maxRetries: 1,
      shouldRetry,
    });
    expect(res).toBe('ok');
    expect(shouldRetry).toHaveBeenCalled();
  });
});

describe('timeout — fetchWithRetry', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('成功返回响应', async () => {
    const response = new Response('body', { status: 200 });
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(response);

    const res = await fetchWithRetry('https://example.com');
    expect(res).toBe(response);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('可重试错误触发重试', async () => {
    const response = new Response('ok', { status: 200 });
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValue(response);

    const res = await fetchWithRetry('https://example.com', undefined, { maxRetries: 1 });
    expect(res).toBe(response);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
