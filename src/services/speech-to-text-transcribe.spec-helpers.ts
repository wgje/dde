import { describe, expect, it, vi } from 'vitest';
import type { WritableSignal } from '@angular/core';

import { remainingQuota } from '../state/focus-stores';
import type { SpeechToTextService } from './speech-to-text.service';

type MockFn = ReturnType<typeof vi.fn>;

export interface SpeechToTextTranscribeSpecContext {
  service(): SpeechToTextService;
  mockAuthService(): {
    currentUserId: WritableSignal<string | null>;
  };
  mockAuthApi(): {
    getSession: MockFn;
  };
  mockSessionManager(): {
    tryRefreshSessionWithSession: MockFn;
  };
  mockToastService(): {
    warning: MockFn;
  };
}

export function registerSpeechToTextTranscribeSpecs(context: SpeechToTextTranscribeSpecContext): void {
  describe('transcribeBlob', () => {
    it('应在 access token 临近过期时先刷新再请求', async () => {
      const service = context.service();
      const mockAuthService = context.mockAuthService();
      const mockAuthApi = context.mockAuthApi();
      const mockSessionManager = context.mockSessionManager();

      mockAuthService.currentUserId.set('cloud-user');
      mockAuthApi.getSession
        .mockResolvedValueOnce({
          data: {
            session: {
              access_token: 'stale-token',
              expires_at: Math.floor(Date.now() / 1000) + 5,
              user: { id: 'cloud-user' }
            }
          },
          error: null,
        });
      mockSessionManager.tryRefreshSessionWithSession.mockResolvedValueOnce({
        refreshed: true,
        session: {
          access_token: 'fresh-token',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: { id: 'cloud-user' }
        }
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ text: '转写成功', duration: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      );

      const result = await (service as unknown as { transcribeBlob: (blob: Blob) => Promise<string> })
        .transcribeBlob(new Blob(['audio'], { type: 'audio/webm' }));

      expect(result).toBe('转写成功');
      expect(mockSessionManager.tryRefreshSessionWithSession).toHaveBeenCalledWith('SpeechToText.transcribe.getSession');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
        headers: expect.objectContaining({
          Authorization: 'Bearer fresh-token'
        })
      });
    });

    it('首次收到 401 时应刷新会话并仅重试一次', async () => {
      const service = context.service();
      const mockAuthService = context.mockAuthService();
      const mockAuthApi = context.mockAuthApi();
      const mockSessionManager = context.mockSessionManager();

      mockAuthService.currentUserId.set('cloud-user');
      mockAuthApi.getSession.mockResolvedValueOnce({
        data: {
          session: {
            access_token: 'first-token',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            user: { id: 'cloud-user' }
          }
        },
        error: null,
      });
      mockSessionManager.tryRefreshSessionWithSession.mockResolvedValueOnce({
        refreshed: true,
        session: {
          access_token: 'second-token',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: { id: 'cloud-user' }
        }
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({ code: 401, message: 'Invalid JWT' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ text: '重试成功', duration: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }));

      const result = await (service as unknown as { transcribeBlob: (blob: Blob) => Promise<string> })
        .transcribeBlob(new Blob(['audio'], { type: 'audio/webm' }));

      expect(result).toBe('重试成功');
      expect(mockSessionManager.tryRefreshSessionWithSession).toHaveBeenCalledWith('SpeechToText.transcribe.retry401');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
        headers: expect.objectContaining({
          Authorization: 'Bearer first-token'
        })
      });
      expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({
        headers: expect.objectContaining({
          Authorization: 'Bearer second-token'
        })
      });
    });

    it('401 重试时应直接使用 refresh 返回的新 session，避免再次读到旧 token', async () => {
      const service = context.service();
      const mockAuthService = context.mockAuthService();
      const mockAuthApi = context.mockAuthApi();
      const mockSessionManager = context.mockSessionManager();

      mockAuthService.currentUserId.set('cloud-user');
      mockAuthApi.getSession.mockResolvedValue({
        data: {
          session: {
            access_token: 'stale-token',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            user: { id: 'cloud-user' }
          }
        },
        error: null,
      });
      mockSessionManager.tryRefreshSessionWithSession.mockResolvedValueOnce({
        refreshed: true,
        session: {
          access_token: 'refreshed-token',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: { id: 'cloud-user' }
        }
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({ code: 401, message: 'Invalid JWT' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ text: '刷新后成功', duration: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }));

      const result = await (service as unknown as { transcribeBlob: (blob: Blob) => Promise<string> })
        .transcribeBlob(new Blob(['audio'], { type: 'audio/webm' }));

      expect(result).toBe('刷新后成功');
      expect(mockAuthApi.getSession).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({
        headers: expect.objectContaining({
          Authorization: 'Bearer refreshed-token'
        })
      });
    });

    it('读取到其他 owner 的 session 时应作为可重试会话恢复错误', async () => {
      const service = context.service();
      const mockAuthService = context.mockAuthService();
      const mockAuthApi = context.mockAuthApi();

      mockAuthService.currentUserId.set('cloud-user');
      mockAuthApi.getSession.mockResolvedValueOnce({
        data: {
          session: {
            access_token: 'other-token',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            user: { id: 'other-user' }
          }
        },
        error: null,
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      await expect((service as unknown as { transcribeBlob: (blob: Blob) => Promise<string> })
        .transcribeBlob(new Blob(['audio'], { type: 'audio/webm' })))
        .rejects.toThrow('SESSION_TEMPORARILY_UNAVAILABLE');

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('上游转写超时时应作为可重试错误交给外层缓存链路', async () => {
      const service = context.service();
      const mockAuthService = context.mockAuthService();
      const mockAuthApi = context.mockAuthApi();
      const mockToastService = context.mockToastService();

      mockAuthService.currentUserId.set('cloud-user');
      mockAuthApi.getSession.mockResolvedValueOnce({
        data: {
          session: {
            access_token: 'valid-token',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            user: { id: 'cloud-user' }
          }
        },
        error: null,
      });
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          ok: false,
          code: 'GROQ_TIMEOUT',
          error: '转写服务响应超时，请稍后重试',
          retryable: true,
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        })
      );

      await expect(
        (service as unknown as { transcribeBlob: (blob: Blob) => Promise<string> })
          .transcribeBlob(new Blob(['audio'], { type: 'audio/webm' }))
      ).rejects.toThrow('FOCUS_NETWORK_ERROR');
      expect(mockToastService.warning).not.toHaveBeenCalled();
    });

    it('刷新失败且原因是 no-session 时应抛出 SYNC_AUTH_EXPIRED', async () => {
      const service = context.service();
      const mockAuthService = context.mockAuthService();
      const mockAuthApi = context.mockAuthApi();
      const mockSessionManager = context.mockSessionManager();

      mockAuthService.currentUserId.set('cloud-user');
      mockAuthApi.getSession.mockResolvedValueOnce({
        data: { session: null },
        error: null,
      });
      mockSessionManager.tryRefreshSessionWithSession.mockResolvedValueOnce({
        refreshed: false,
        reason: 'no-session'
      });

      await expect(
        (service as unknown as { transcribeBlob: (blob: Blob) => Promise<string> })
          .transcribeBlob(new Blob(['audio'], { type: 'audio/webm' }))
      ).rejects.toThrow('SYNC_AUTH_EXPIRED');
    });

    it('配额耗尽响应应清零剩余额度并提示用户', async () => {
      const service = context.service();
      const mockAuthService = context.mockAuthService();
      const mockAuthApi = context.mockAuthApi();
      const mockToastService = context.mockToastService();

      mockAuthService.currentUserId.set('cloud-user');
      mockAuthApi.getSession.mockResolvedValueOnce({
        data: {
          session: {
            access_token: 'valid-token',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            user: { id: 'cloud-user' }
          }
        },
        error: null,
      });
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'QUOTA_EXCEEDED' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' }
        })
      );

      await expect(
        (service as unknown as { transcribeBlob: (blob: Blob) => Promise<string> })
          .transcribeBlob(new Blob(['audio'], { type: 'audio/webm' }))
      ).rejects.toThrow('FOCUS_QUOTA_EXCEEDED');
      expect(remainingQuota()).toBe(0);
      expect(mockToastService.warning).toHaveBeenCalledWith('配额已用完', expect.any(String));
    });
  });
}
