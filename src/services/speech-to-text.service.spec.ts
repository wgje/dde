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
import { signal } from '@angular/core';
import { isRecording, isTranscribing } from '../app/core/state/focus-stores';

describe('SpeechToTextService', () => {
  let service: SpeechToTextService;
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
  let mockNetworkAwareness: {
    isOnline: ReturnType<typeof signal<boolean>>;
    networkQuality: ReturnType<typeof signal<string>>;
  };

  beforeEach(() => {
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
        { provide: NetworkAwarenessService, useValue: mockNetworkAwareness }
      ]
    });

    service = TestBed.inject(SpeechToTextService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  describe('startRecording', () => {
    it('浏览器不支持时应该抛出错误', async () => {
      // Mock navigator.mediaDevices 为 undefined
      const originalMediaDevices = navigator.mediaDevices;
      Object.defineProperty(navigator, 'mediaDevices', {
        value: undefined,
        configurable: true
      });

      await expect(service.startRecording()).rejects.toThrow();

      // 恢复
      Object.defineProperty(navigator, 'mediaDevices', {
        value: originalMediaDevices,
        configurable: true
      });
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
      const results = await service.processOfflineCache();
      expect(Array.isArray(results)).toBe(true);
    });
  });
});
