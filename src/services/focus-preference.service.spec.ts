/**
 * Focus Preference 服务单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { FocusPreferenceService } from './focus-preference.service';
import { PreferenceService } from './preference.service';
import { LoggerService } from './logger.service';
import { focusPreferences } from '../app/core/state/focus-stores';
import { DEFAULT_FOCUS_PREFERENCES } from '../models/focus';

describe('FocusPreferenceService', () => {
  let service: FocusPreferenceService;
  let mockLoggerService: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    // 清除 localStorage
    localStorage.clear();
    
    // 重置状态到默认值
    focusPreferences.set({ ...DEFAULT_FOCUS_PREFERENCES });

    mockLoggerService = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn()
    };

    TestBed.configureTestingModule({
      providers: [
        FocusPreferenceService,
        { provide: PreferenceService, useValue: {} },
        { provide: LoggerService, useValue: mockLoggerService }
      ]
    });

    service = TestBed.inject(FocusPreferenceService);
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe('preferences', () => {
    it('应该返回当前偏好设置', () => {
      const prefs = service.preferences();

      expect(prefs).toBeDefined();
      expect(prefs.gateEnabled).toBe(true);
    });
  });

  describe('update', () => {
    it('应该更新偏好设置', () => {
      service.update({ gateEnabled: false });

      expect(focusPreferences().gateEnabled).toBe(false);
    });

    it('应该持久化到 localStorage', () => {
      service.update({ spotlightEnabled: false });

      const stored = localStorage.getItem('focus_preferences');
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!).spotlightEnabled).toBe(false);
    });
  });

  describe('setGateEnabled', () => {
    it('应该设置大门启用状态', () => {
      service.setGateEnabled(false);
      expect(focusPreferences().gateEnabled).toBe(false);

      service.setGateEnabled(true);
      expect(focusPreferences().gateEnabled).toBe(true);
    });
  });

  describe('setSpotlightEnabled', () => {
    it('应该设置聚光灯启用状态', () => {
      service.setSpotlightEnabled(false);
      expect(focusPreferences().spotlightEnabled).toBe(false);
    });
  });

  describe('setBlackBoxEnabled', () => {
    it('应该设置黑匣子启用状态', () => {
      service.setBlackBoxEnabled(false);
      expect(focusPreferences().blackBoxEnabled).toBe(false);
    });
  });

  describe('setMaxSnoozePerDay', () => {
    it('应该设置每日最大跳过次数', () => {
      service.setMaxSnoozePerDay(5);
      expect(focusPreferences().maxSnoozePerDay).toBe(5);
    });

    it('应该限制在有效范围内', () => {
      service.setMaxSnoozePerDay(-1);
      expect(focusPreferences().maxSnoozePerDay).toBe(0);

      service.setMaxSnoozePerDay(100);
      expect(focusPreferences().maxSnoozePerDay).toBe(10);
    });
  });

  describe('reset', () => {
    it('应该重置为默认值', () => {
      service.update({ gateEnabled: false, spotlightEnabled: false });
      service.reset();

      expect(focusPreferences().gateEnabled).toBe(DEFAULT_FOCUS_PREFERENCES.gateEnabled);
      expect(focusPreferences().spotlightEnabled).toBe(DEFAULT_FOCUS_PREFERENCES.spotlightEnabled);
    });
  });

  describe('getPreferences', () => {
    it('应该返回当前偏好', () => {
      const prefs = service.getPreferences();
      expect(prefs).toEqual(focusPreferences());
    });
  });

  describe('isGateEnabled', () => {
    it('应该返回大门是否启用', () => {
      expect(service.isGateEnabled()).toBe(true);
      
      service.setGateEnabled(false);
      expect(service.isGateEnabled()).toBe(false);
    });
  });

  describe('isSpotlightEnabled', () => {
    it('应该返回聚光灯是否启用', () => {
      expect(service.isSpotlightEnabled()).toBe(true);
      
      service.setSpotlightEnabled(false);
      expect(service.isSpotlightEnabled()).toBe(false);
    });
  });

  describe('isBlackBoxEnabled', () => {
    it('应该返回黑匣子是否启用', () => {
      // 确保默认值正确
      expect(focusPreferences().blackBoxEnabled).toBe(true);
      expect(service.isBlackBoxEnabled()).toBe(true);

      service.setBlackBoxEnabled(false);
      expect(service.isBlackBoxEnabled()).toBe(false);
    });
  });
});
