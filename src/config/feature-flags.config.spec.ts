/**
 * Feature Flags 安全性测试
 * 
 * 验证关键安全开关的默认值是否正确（Task 3.3 验证）
 */
import { describe, it, expect } from 'vitest';
import { FEATURE_FLAGS, isFeatureEnabled } from './feature-flags.config';

describe('Feature Flags 安全校验', () => {
  it('CONNECTION_TOMBSTONE_ENABLED 应默认启用', () => {
    expect(FEATURE_FLAGS.CONNECTION_TOMBSTONE_ENABLED).toBe(true);
  });

  it('SYNC_DURABILITY_FIRST_ENABLED 应默认启用', () => {
    expect(FEATURE_FLAGS.SYNC_DURABILITY_FIRST_ENABLED).toBe(true);
  });

  it('SYNC_STRICT_SUCCESS_ENABLED 应默认启用', () => {
    expect(FEATURE_FLAGS.SYNC_STRICT_SUCCESS_ENABLED).toBe(true);
  });

  it('LOGOUT_CLEANUP_ENABLED 应默认启用', () => {
    expect(FEATURE_FLAGS.LOGOUT_CLEANUP_ENABLED).toBe(true);
  });

  it('SESSION_EXPIRED_CHECK_ENABLED 应默认启用', () => {
    expect(FEATURE_FLAGS.SESSION_EXPIRED_CHECK_ENABLED).toBe(true);
  });

  it('OFFLINE_SNAPSHOT_IDB_ENABLED 应默认关闭（灰度开关）', () => {
    expect(FEATURE_FLAGS.OFFLINE_SNAPSHOT_IDB_ENABLED).toBe(false);
  });

  it('isFeatureEnabled 工具函数应正确返回布尔值', () => {
    expect(isFeatureEnabled('CONNECTION_TOMBSTONE_ENABLED')).toBe(true);
    expect(isFeatureEnabled('DEMO_MODE_ENABLED')).toBe(false);
  });

  it('所有关键安全开关不应被意外禁用', () => {
    const criticalFlags: (keyof typeof FEATURE_FLAGS)[] = [
      'CONNECTION_TOMBSTONE_ENABLED',
      'SYNC_DURABILITY_FIRST_ENABLED', 
      'SYNC_STRICT_SUCCESS_ENABLED',
      'LOGOUT_CLEANUP_ENABLED',
    ];

    const disabledFlags = criticalFlags.filter(key => !FEATURE_FLAGS[key]);
    expect(disabledFlags).toEqual([]);
  });
});
