/**
 * SpeechToText 服务单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SpeechToTextService } from './speech-to-text.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SupabaseClientService } from './supabase-client.service';
import { NetworkAwarenessService } from './network-awareness.service';
import { AuthService } from './auth.service';
import { BlackBoxService } from './black-box.service';
import { signal } from '@angular/core';
import { isRecording, isTranscribing } from '../state/focus-stores';

describe('SpeechToTextService', () => {
  let service: SpeechToTextService;
  let originalMediaDevices: MediaDevices | undefined;
  let mockLoggerService: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    category: ReturnType<typeof vi.fn>;
  };
  let mockToastService: {
    success: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    warning: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
  };
  let mockSupabaseClient: {
    getClient: ReturnType<typeof vi.fn>;
  };
  let mockAuthService: {
    currentUserId: ReturnType<typeof signal<string | null>>;
    isConfigured: boolean;
  };
  let mockBlackBoxService: {
    create: ReturnType<typeof vi.fn>;
  };
  let mockNetworkAwareness: {
    isOnline: ReturnType<typeof signal<boolean>>;
    networkQuality: ReturnType<typeof signal<string>>;
  };

  const setMediaDevices = (value: MediaDevices | undefined) => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value,
      configurable: true,
      writable: true
    });
  };

  beforeEach(() => {
    vi.useRealTimers();
    originalMediaDevices = navigator.mediaDevices;

    // 重置 signals
    isRecording.set(false);
    isTranscribing.set(false);
    
    // 创建子 logger mock
    const categoryLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn()
    };

    mockLoggerService = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      category: vi.fn().mockReturnValue(categoryLogger)
    };

    mockToastService = {
      success: vi.fn(),
      error: vi.fn(),
      warning: vi.fn(),
      info: vi.fn()
    };

    mockSupabaseClient = {
      getClient: vi.fn().mockReturnValue({
        functions: {
          invoke: vi.fn()
        }
      })
    };

    mockAuthService = {
      currentUserId: signal('local-user'),
      isConfigured: false,
    };

    mockBlackBoxService = {
      create: vi.fn(),
    };

    mockNetworkAwareness = {
      isOnline: signal(true),
      networkQuality: signal('high')
    };

    TestBed.configureTestingModule({
      providers: [
        SpeechToTextService,
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: ToastService, useValue: mockToastService },
        { provide: SupabaseClientService, useValue: mockSupabaseClient },
        { provide: AuthService, useValue: mockAuthService },
        { provide: BlackBoxService, useValue: mockBlackBoxService },
        { provide: NetworkAwarenessService, useValue: mockNetworkAwareness },
      ]
    });

    service = TestBed.inject(SpeechToTextService);
  });

  afterEach(() => {
    if (typeof vi.isFakeTimers === 'function' && vi.isFakeTimers()) {
      vi.useRealTimers();
    }
    vi.restoreAllMocks();
    setMediaDevices(originalMediaDevices);
  });

  describe('isRecording', () => {
    it('初始状态应该不在录音', () => {
      expect(service.isRecording()).toBe(false);
    });
  });

  describe('isTranscribing', () => {
    it('初始状态应该不在转录', () => {
      expect(service.isTranscribing()).toBe(false);
    });
  });

  describe('getRecordingDuration', () => {
    it('未录音时应该返回 0', () => {
      expect(service.getRecordingDuration()).toBe(0);
    });
  });

  describe('isSupported', () => {
    it('应该检测浏览器是否支持录音', () => {
      const result = service.isSupported();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('getFallbackMessage', () => {
    it('应该返回提示消息', () => {
      const message = service.getFallbackMessage();
      expect(typeof message).toBe('string');
    });
  });

  describe('checkMicrophoneAvailability', () => {
    it('当没有音频输入设备时应该返回 false', async () => {
      const mockEnumerateDevices = vi.fn().mockResolvedValue([
        { kind: 'videoinput', deviceId: 'test1' }
      ]);
      
      setMediaDevices({
        enumerateDevices: mockEnumerateDevices,
        getUserMedia: vi.fn()
      } as MediaDevices);

      const result = await service.checkMicrophoneAvailability();
      expect(result).toBe(false);
    });

    it('当有音频输入设备时应该返回 true', async () => {
      const mockEnumerateDevices = vi.fn().mockResolvedValue([
        { kind: 'audioinput', deviceId: 'test1' },
        { kind: 'videoinput', deviceId: 'test2' }
      ]);
      
      setMediaDevices({
        enumerateDevices: mockEnumerateDevices,
        getUserMedia: vi.fn()
      } as MediaDevices);

      const result = await service.checkMicrophoneAvailability();
      expect(result).toBe(true);
    });

    it('当 mediaDevices API 不可用时应该返回 false', async () => {
      setMediaDevices(undefined);

      const result = await service.checkMicrophoneAvailability();
      expect(result).toBe(false);
    });
  });

  describe('startRecording', () => {
    it('设备不可用时应该优雅返回而不抛出错误', async () => {
      // Mock checkMicrophoneAvailability 返回 false
      vi.spyOn(service, 'checkMicrophoneAvailability').mockResolvedValue(false);

      // 不应该抛出错误
      await expect(service.startRecording()).resolves.toBeUndefined();
    });

    it('浏览器不支持时应该优雅返回', async () => {
      setMediaDevices(undefined);

      // 不应该抛出错误
      await expect(service.startRecording()).resolves.toBeUndefined();
    });
  });

  describe('stopRecording', () => {
    it('未录音时调用不应该抛出错误', () => {
      expect(() => service.stopRecording()).not.toThrow();
    });
  });

  describe('stopAndTranscribe', () => {
    it('未录音时应该 reject', async () => {
      await expect(service.stopAndTranscribe()).rejects.toThrow('未开始录音');
    });
  });

  describe('offlinePendingCount', () => {
    it('应该返回离线待处理数量', () => {
      expect(typeof service.offlinePendingCount()).toBe('number');
    });
  });

  describe('remainingQuota', () => {
    it('应该返回剩余配额', () => {
      expect(typeof service.remainingQuota()).toBe('number');
    });
  });

  describe('processOfflineCache', () => {
    it('应该处理离线缓存', async () => {
      const request: {
        result: unknown[];
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        error: unknown;
      } = {
        result: [],
        onsuccess: null,
        onerror: null,
        error: null,
      };
      const store = {
        getAll: vi.fn(() => request),
      };
      const tx = {
        objectStore: vi.fn(() => store),
      };
      (service as unknown as { db: { transaction: (name: string, mode: string) => unknown } }).db = {
        transaction: vi.fn(() => tx),
      };

      const processing = service.processOfflineCache();
      request.onsuccess?.();

      const results = await processing;
      expect(results).toEqual([]);
    });
  });

  describe('全局事件监听器清理', () => {
    it('服务应保存 onlineHandler 引用以便清理', () => {
      // 验证 onlineHandler 在构造后不为 null（意味着可以被移除）
      const handler = (service as unknown as { onlineHandler: (() => void) | null }).onlineHandler;
      expect(handler).not.toBeNull();
      expect(typeof handler).toBe('function');
    });

    it('手动清理 onlineHandler 后应安全', () => {
      const svc = service as unknown as { onlineHandler: (() => void) | null };
      const handler = svc.onlineHandler;

      // 模拟 destroy 行为：移除监听器并置空
      if (handler) {
        window.removeEventListener('online', handler);
        svc.onlineHandler = null;
      }

      expect(svc.onlineHandler).toBeNull();
    });

    it('清理后重复移除不应抛出错误（幂等）', () => {
      const svc = service as unknown as { onlineHandler: (() => void) | null };

      // 第一次清理
      if (svc.onlineHandler) {
        window.removeEventListener('online', svc.onlineHandler);
        svc.onlineHandler = null;
      }
      // 第二次清理（幂等）
      expect(() => {
        if (svc.onlineHandler) {
          window.removeEventListener('online', svc.onlineHandler);
          svc.onlineHandler = null;
        }
      }).not.toThrow();
    });
  });
});
