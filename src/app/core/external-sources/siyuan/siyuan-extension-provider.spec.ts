import { describe, expect, it, vi } from 'vitest';
import { SiyuanExtensionProvider } from './siyuan-extension-provider';
import { SiyuanProviderError } from './siyuan-provider.interface';

type ProviderPrivateApi = {
  isTrustedWindowMessage: (event: MessageEvent<unknown>) => boolean;
  pingExtension: () => Promise<boolean>;
  postRequest: (blockId: string, signal: AbortSignal | undefined, ownerUserId: string) => Promise<unknown>;
  postRelayRequest: (args: unknown) => Promise<unknown>;
};

const OWNER_A = 'owner-a';

describe('siyuan-extension-provider', () => {
  it('returns extension-unavailable when ping cannot reach relay', async () => {
    const provider = new SiyuanExtensionProvider();

    const result = await provider.diagnoseConnection(OWNER_A);

    expect(result).toEqual({ ok: false, errorCode: 'extension-unavailable' });
  });

  it('maps relay test-connection error codes for diagnostics', async () => {
    const provider = new SiyuanExtensionProvider();
    const privateProvider = provider as unknown as ProviderPrivateApi;
    vi.spyOn(privateProvider, 'isTrustedWindowMessage').mockReturnValue(true);
    const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation((message: unknown, _options?: WindowPostMessageOptions) => {
      if (typeof message !== 'object' || message === null) return;
      const payload = message as { type?: string; requestId?: string };
      if (payload.type === 'nanoflow.siyuan.ping') {
        queueMicrotask(() => {
          window.dispatchEvent(new MessageEvent('message', {
            origin: window.location.origin,
            data: { type: 'nanoflow.siyuan.pong', requestId: payload.requestId, ok: true },
          }));
        });
      }
      if (payload.type === 'nanoflow.siyuan.test-connection') {
        queueMicrotask(() => {
          window.dispatchEvent(new MessageEvent('message', {
            origin: window.location.origin,
            data: {
              type: 'nanoflow.siyuan.test-connection-result',
              requestId: payload.requestId,
              ownerUserId: OWNER_A,
              ok: false,
              errorCode: 'token-invalid',
            },
          }));
        });
      }
    });

    const result = await provider.diagnoseConnection(OWNER_A);

    expect(result).toEqual({ ok: false, errorCode: 'token-invalid' });
    postMessageSpy.mockRestore();
  });

  it('pushConfig forwards baseUrl and token to the extension and only includes whitelisted fields', async () => {
    const provider = new SiyuanExtensionProvider();
    const privateProvider = provider as unknown as ProviderPrivateApi;
    vi.spyOn(privateProvider, 'pingExtension').mockResolvedValue(true);
    const postRelay = vi.spyOn(
      privateProvider,
      'postRelayRequest',
    ).mockResolvedValue({ type: 'nanoflow.siyuan.set-config-result', ok: true });

    const result = await provider.pushConfig(
      { baseUrl: 'http://127.0.0.1:6806', token: 'secret-token' },
      OWNER_A,
      100,
    );

    expect(result).toEqual({ ok: true });
    expect(postRelay).toHaveBeenCalledTimes(1);
    const call = postRelay.mock.calls[0][0] as {
      requestType: string;
      ownerUserId: string;
      configIssuedAt: number;
      payload: Record<string, unknown>;
    };
    expect(call.requestType).toBe('nanoflow.siyuan.set-config');
    expect(call.ownerUserId).toBe(OWNER_A);
    expect(call.configIssuedAt).toBe(100);
    // payload 只能包含 baseUrl/token，杜绝把额外字段透传到 content-script。
    expect(Object.keys(call.payload).sort()).toEqual(['baseUrl', 'token']);
  });

  it('pushConfig maps token-invalid response', async () => {
    const provider = new SiyuanExtensionProvider();
    const privateProvider = provider as unknown as ProviderPrivateApi;
    vi.spyOn(privateProvider, 'pingExtension').mockResolvedValue(true);
    vi.spyOn(
      privateProvider,
      'postRelayRequest',
    ).mockResolvedValue({ type: 'nanoflow.siyuan.set-config-result', ok: false, errorCode: 'token-invalid' });

    const result = await provider.pushConfig(
      { baseUrl: 'http://127.0.0.1:6806', token: 'x' },
      OWNER_A,
      101,
    );

    expect(result).toEqual({ ok: false, errorCode: 'token-invalid' });
  });

  it('pushConfig returns extension-unavailable when ping fails', async () => {
    const provider = new SiyuanExtensionProvider();
    const privateProvider = provider as unknown as ProviderPrivateApi;
    vi.spyOn(privateProvider, 'pingExtension').mockResolvedValue(false);

    const result = await provider.pushConfig(
      { baseUrl: 'http://127.0.0.1:6806', token: 'x' },
      OWNER_A,
      102,
    );

    expect(result).toEqual({ ok: false, errorCode: 'extension-unavailable' });
  });

  it('pushConfig omits the token field entirely when caller did not provide one', async () => {
    const provider = new SiyuanExtensionProvider();
    const privateProvider = provider as unknown as ProviderPrivateApi;
    vi.spyOn(privateProvider, 'pingExtension').mockResolvedValue(true);
    const postRelay = vi.spyOn(
      privateProvider,
      'postRelayRequest',
    ).mockResolvedValue({ type: 'nanoflow.siyuan.set-config-result', ok: true });

    await provider.pushConfig({ baseUrl: 'http://127.0.0.1:6806' }, OWNER_A, 103);

    const payload = (postRelay.mock.calls[0][0] as { payload: Record<string, unknown> }).payload;
    expect(payload).toEqual({ baseUrl: 'http://127.0.0.1:6806' });
    expect(Object.prototype.hasOwnProperty.call(payload, 'token')).toBe(false);
  });

  it('postRelayRequest uses Web Crypto fallback when crypto.randomUUID is unavailable', async () => {
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        getRandomValues: (array: Uint8Array) => {
          array.fill(1);
          return array;
        },
      },
    });

    try {
      const provider = new SiyuanExtensionProvider();
      const privateProvider = provider as unknown as ProviderPrivateApi;
      vi.spyOn(privateProvider, 'isTrustedWindowMessage').mockReturnValue(true);
      const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation((message: unknown) => {
        if (typeof message !== 'object' || message === null) return;
        const payload = message as { type?: string; requestId?: string };
        if (payload.type !== 'nanoflow.siyuan.get-config-status') return;
        queueMicrotask(() => {
          window.dispatchEvent(new MessageEvent('message', {
            origin: window.location.origin,
            data: {
              type: 'nanoflow.siyuan.config-status-result',
              requestId: payload.requestId,
              ownerUserId: OWNER_A,
              ok: true,
              data: { baseUrl: 'http://127.0.0.1:6806', hasToken: false },
            },
          }));
        });
      });

      const response = await privateProvider.postRelayRequest({
        requestType: 'nanoflow.siyuan.get-config-status',
        responseType: 'nanoflow.siyuan.config-status-result',
        ownerUserId: OWNER_A,
      });

      expect(postMessageSpy).toHaveBeenCalledWith(
        {
          type: 'nanoflow.siyuan.get-config-status',
          requestId: '01010101-0101-4101-8101-010101010101',
          ownerUserId: OWNER_A,
        },
        window.location.origin,
      );
      expect(response).toEqual(expect.objectContaining({ ok: true }));
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: originalCrypto,
      });
    }
  });

  it('getConfigStatus returns null when the extension does not respond (legacy version)', async () => {
    const provider = new SiyuanExtensionProvider();
    const privateProvider = provider as unknown as ProviderPrivateApi;
    vi.spyOn(privateProvider, 'pingExtension').mockResolvedValue(true);
    // 旧扩展不识别消息 → postRelayRequest 超时抛 extension-unavailable
    vi.spyOn(
      privateProvider,
      'postRelayRequest',
    ).mockRejectedValue(new SiyuanProviderError('extension-unavailable'));

    const status = await provider.getConfigStatus(OWNER_A);

    expect(status).toBeNull();
  });

  it('ignores an ownerless legacy response until the matching owner response arrives', async () => {
    const provider = new SiyuanExtensionProvider();
    const privateProvider = provider as unknown as ProviderPrivateApi;
    vi.spyOn(privateProvider, 'isTrustedWindowMessage').mockReturnValue(true);
    vi.spyOn(window, 'postMessage').mockImplementation((message: unknown) => {
      if (typeof message !== 'object' || message === null) return;
      const request = message as { type?: string; requestId?: string };
      if (request.type !== 'nanoflow.siyuan.get-config-status') return;
      queueMicrotask(() => {
        window.dispatchEvent(new MessageEvent('message', {
          origin: window.location.origin,
          data: {
            type: 'nanoflow.siyuan.config-status-result',
            requestId: request.requestId,
            ok: true,
            data: { hasToken: true },
          },
        }));
        queueMicrotask(() => {
          window.dispatchEvent(new MessageEvent('message', {
            origin: window.location.origin,
            data: {
              type: 'nanoflow.siyuan.config-status-result',
              requestId: request.requestId,
              ownerUserId: OWNER_A,
              ok: true,
              data: { hasToken: false },
            },
          }));
        });
      });
    });

    const response = await privateProvider.postRelayRequest({
      requestType: 'nanoflow.siyuan.get-config-status',
      responseType: 'nanoflow.siyuan.config-status-result',
      ownerUserId: OWNER_A,
    }) as { ownerUserId?: string; data?: { hasToken?: boolean } };

    expect(response.ownerUserId).toBe(OWNER_A);
    expect(response.data?.hasToken).toBe(false);
  });

  it('probeConfigStatus marks a timed-out config-status request as unsupported after ping succeeds', async () => {
    const provider = new SiyuanExtensionProvider();
    const privateProvider = provider as unknown as ProviderPrivateApi;
    vi.spyOn(privateProvider, 'pingExtension').mockResolvedValue(true);
    vi.spyOn(
      privateProvider,
      'postRelayRequest',
    ).mockRejectedValue(new SiyuanProviderError('extension-unavailable'));

    const result = await provider.probeConfigStatus(OWNER_A);

    expect(result).toEqual({ kind: 'unsupported' });
  });

  it('probeConfigStatus preserves non-timeout error codes for the caller', async () => {
    const provider = new SiyuanExtensionProvider();
    const privateProvider = provider as unknown as ProviderPrivateApi;
    vi.spyOn(privateProvider, 'pingExtension').mockResolvedValue(true);
    vi.spyOn(
      privateProvider,
      'postRelayRequest',
    ).mockResolvedValue({
      type: 'nanoflow.siyuan.config-status-result',
      ok: false,
      errorCode: 'runtime-not-supported',
    });

    const result = await provider.probeConfigStatus(OWNER_A);

    expect(result).toEqual({ kind: 'error', errorCode: 'runtime-not-supported' });
  });

  it('getConfigStatus returns baseUrl and hasToken without leaking token', async () => {
    const provider = new SiyuanExtensionProvider();
    const privateProvider = provider as unknown as ProviderPrivateApi;
    vi.spyOn(privateProvider, 'pingExtension').mockResolvedValue(true);
    vi.spyOn(
      privateProvider,
      'postRelayRequest',
    ).mockResolvedValue({
      type: 'nanoflow.siyuan.config-status-result',
      ok: true,
      data: { baseUrl: 'http://127.0.0.1:6806', hasToken: true },
    });

    const status = await provider.getConfigStatus(OWNER_A);

    expect(status).toEqual({ baseUrl: 'http://127.0.0.1:6806', hasToken: true });
    // 类型层面已经禁止 token 字段返回，但运行时也回归一次。
    expect(status && Object.prototype.hasOwnProperty.call(status, 'token')).toBeFalsy();
  });

  it('getConfigStatus returns null when extension ping fails (uninstalled)', async () => {
    const provider = new SiyuanExtensionProvider();
    const privateProvider = provider as unknown as ProviderPrivateApi;
    vi.spyOn(privateProvider, 'pingExtension').mockResolvedValue(false);

    const status = await provider.getConfigStatus(OWNER_A);

    expect(status).toBeNull();
  });

  it('maps relay preview title and path into the normalized preview payload', async () => {
    const provider = new SiyuanExtensionProvider();
    const privateProvider = provider as unknown as ProviderPrivateApi;
    vi.spyOn(privateProvider, 'postRequest').mockResolvedValue({
      ok: true,
      data: {
        blockId: '20260426123456-abc1234',
        title: '细菌能量来源',
        hpath: '/生物/微生物/细菌能量来源',
        plainText: '摘要',
        childBlocks: [],
        truncated: false,
      },
    });

    const preview = await provider.getBlockPreview('20260426123456-abc1234', undefined, OWNER_A);

    expect(preview.title).toBe('细菌能量来源');
    expect(preview.hpath).toBe('/生物/微生物/细菌能量来源');
    expect(preview.excerpt).toBe('摘要');
  });

  it('does not propagate extension error text that could contain credential material', async () => {
    const provider = new SiyuanExtensionProvider();
    const privateProvider = provider as unknown as ProviderPrivateApi;
    vi.spyOn(privateProvider, 'postRequest').mockResolvedValue({
      ok: false,
      errorCode: 'token-invalid',
      errorMessage: 'Token secret-token rejected',
    });

    await expect(provider.getBlockPreview(
      '20260426123456-abc1234',
      undefined,
      OWNER_A,
    )).rejects.toMatchObject({
      code: 'token-invalid',
      message: 'token-invalid',
    });
  });

  it('cleans up ping listener and timeout when postMessage throws', async () => {
    vi.useFakeTimers();
    const provider = new SiyuanExtensionProvider();
    const privateProvider = provider as unknown as ProviderPrivateApi;
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    vi.spyOn(window, 'postMessage').mockImplementation(() => {
      throw new Error('postMessage failed');
    });

    try {
      const result = await privateProvider.pingExtension();

      expect(result).toBe(false);
      expect(addEventListenerSpy).toHaveBeenCalledWith('message', expect.any(Function));
      expect(removeEventListenerSpy).toHaveBeenCalledWith('message', expect.any(Function));
      expect(clearTimeoutSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up relay listener, timeout and abort listener when postMessage throws', async () => {
    vi.useFakeTimers();
    const provider = new SiyuanExtensionProvider();
    const privateProvider = provider as unknown as ProviderPrivateApi;
    const abortController = new AbortController();
    const removeAbortListenerSpy = vi.spyOn(abortController.signal, 'removeEventListener');
    const removeWindowListenerSpy = vi.spyOn(window, 'removeEventListener');
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    vi.spyOn(window, 'postMessage').mockImplementation(() => {
      throw new Error('postMessage failed');
    });

    try {
      await expect(privateProvider.postRelayRequest({
        requestType: 'nanoflow.siyuan.get-config-status',
        responseType: 'nanoflow.siyuan.config-status-result',
        ownerUserId: OWNER_A,
        signal: abortController.signal,
      })).rejects.toThrow('postMessage failed');

      expect(removeWindowListenerSpy).toHaveBeenCalledWith('message', expect.any(Function));
      expect(removeAbortListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(clearTimeoutSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
