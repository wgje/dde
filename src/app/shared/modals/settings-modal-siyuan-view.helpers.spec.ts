import { describe, expect, it } from 'vitest';

import {
  formatSiyuanDiagnosisMessage,
  formatSiyuanExtensionStatusClass,
  formatSiyuanExtensionStatusMessage,
  formatSiyuanPushConfigError,
  formatSiyuanTokenLabel,
  formatSiyuanTokenPlaceholder,
  resolveSiyuanExtensionSupported,
  SIYUAN_TOKEN_MASK,
  type SiyuanExtensionStatusView,
} from './settings-modal-siyuan-view.helpers';

const DEFAULT_BASE_URL = 'http://127.0.0.1:6806';

describe('settings-modal-siyuan-view helpers', () => {
  it('keeps extension support false until the page config channel is available', () => {
    expect(resolveSiyuanExtensionSupported(undefined)).toBe(false);
    expect(resolveSiyuanExtensionSupported(null)).toBe(false);
    expect(resolveSiyuanExtensionSupported({ hasToken: true, configChannelAvailable: false })).toBe(false);
    expect(resolveSiyuanExtensionSupported({ hasToken: true, readError: true })).toBe(true);
  });

  it('formats extension status messages for every relay state', () => {
    const readyStatus: SiyuanExtensionStatusView = {
      baseUrl: 'http://localhost:6806',
      hasToken: true,
    };

    expect(formatSiyuanExtensionStatusMessage(undefined, DEFAULT_BASE_URL)).toBe('正在读取扩展状态…');
    expect(formatSiyuanExtensionStatusMessage(null, DEFAULT_BASE_URL)).toContain('扩展未安装或版本过旧');
    expect(formatSiyuanExtensionStatusMessage({
      hasToken: false,
      configChannelAvailable: false,
    }, DEFAULT_BASE_URL)).toContain('当前扩展版本不支持页面配置读写');
    expect(formatSiyuanExtensionStatusMessage({
      hasToken: true,
      configChannelAvailable: false,
      connectionVerified: true,
    }, DEFAULT_BASE_URL)).toContain('扩展预览通道已连通');
    expect(formatSiyuanExtensionStatusMessage({
      hasToken: false,
      readError: true,
    }, DEFAULT_BASE_URL)).toContain('读取配置状态失败');
    expect(formatSiyuanExtensionStatusMessage({ hasToken: false }, DEFAULT_BASE_URL)).toContain('尚未配置思源 Token');
    expect(formatSiyuanExtensionStatusMessage(readyStatus, DEFAULT_BASE_URL)).toContain('http://localhost:6806');
    expect(formatSiyuanExtensionStatusMessage({ hasToken: true }, DEFAULT_BASE_URL)).toContain(DEFAULT_BASE_URL);
  });

  it('formats extension status classes by severity', () => {
    expect(formatSiyuanExtensionStatusClass(undefined)).toContain('text-slate-500');
    expect(formatSiyuanExtensionStatusClass(null)).toContain('text-rose-700');
    expect(formatSiyuanExtensionStatusClass({ hasToken: true, configChannelAvailable: false })).toContain('text-amber-700');
    expect(formatSiyuanExtensionStatusClass({ hasToken: false, readError: true })).toContain('text-amber-700');
    expect(formatSiyuanExtensionStatusClass({ hasToken: false })).toContain('text-amber-700');
    expect(formatSiyuanExtensionStatusClass({ hasToken: true })).toContain('text-emerald-700');
  });

  it('formats token labels, placeholders, and mask consistently with runtime mode', () => {
    expect(SIYUAN_TOKEN_MASK).toBe('••••••••');
    expect(formatSiyuanTokenLabel('extension-relay')).toContain('保存后写入扩展');
    expect(formatSiyuanTokenLabel('direct')).toContain('直连模式必填');
    expect(formatSiyuanTokenLabel('cache-only')).toContain('仅缓存模式不需要');
    expect(formatSiyuanTokenPlaceholder('extension-relay')).toContain('保存到扩展');
    expect(formatSiyuanTokenPlaceholder('direct')).toBe('思源 API Token');
    expect(formatSiyuanTokenPlaceholder('cache-only')).toBe('当前模式无需 Token');
  });

  it('formats push-config and diagnosis failures with settings-specific copy', () => {
    expect(formatSiyuanPushConfigError('extension-unavailable')).toContain('扩展未安装或未启用');
    expect(formatSiyuanPushConfigError('token-invalid')).toContain('Token 校验失败');
    expect(formatSiyuanPushConfigError('runtime-not-supported')).toContain('页面配置');
    expect(formatSiyuanPushConfigError('kernel-unreachable')).toBe('未连接到思源，请确认思源已启动');
    expect(formatSiyuanPushConfigError(undefined)).toBe('预览失败，可稍后重试');

    expect(formatSiyuanDiagnosisMessage('extension-unavailable')).toContain('扩展未安装或未注入当前页面');
    expect(formatSiyuanDiagnosisMessage('token-invalid')).toBe('思源授权失效，请重新配置');
    expect(formatSiyuanDiagnosisMessage(undefined)).toBe('预览失败，可稍后重试');
  });
});
