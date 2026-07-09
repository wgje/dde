import { SIYUAN_ERROR_MESSAGES } from '../../../config/siyuan.config';
import type { SiyuanRuntimeMode } from '../../core/external-sources/external-source.model';

export interface SiyuanExtensionStatusView {
  baseUrl?: string;
  hasToken: boolean;
  configChannelAvailable?: boolean;
  connectionVerified?: boolean;
  readError?: boolean;
}

export const SIYUAN_TOKEN_MASK = '••••••••';

export function resolveSiyuanExtensionSupported(status: SiyuanExtensionStatusView | null | undefined): boolean {
  return status !== undefined && status !== null && status.configChannelAvailable !== false;
}

export function formatSiyuanExtensionStatusMessage(
  status: SiyuanExtensionStatusView | null | undefined,
  defaultBaseUrl: string,
): string {
  if (status === undefined) return '正在读取扩展状态…';
  if (status === null) return '扩展未安装或版本过旧，请安装/更新扩展后刷新页面';
  if (status.configChannelAvailable === false) {
    if (status.connectionVerified) return '扩展预览通道已连通，当前配置由扩展 Options 管理；页面保存配置需更新扩展后刷新页面';
    return '当前扩展版本不支持页面配置读写；请在扩展 Options 中配置，或更新扩展后刷新页面';
  }
  if (status.readError === true) return '扩展连接可用，但读取配置状态失败；可直接保存到扩展后重试';
  if (!status.hasToken) return '扩展已就绪，但尚未配置思源 Token，请在下方填写后点击"保存到扩展"';
  const baseUrl = status.baseUrl ?? defaultBaseUrl;
  return `扩展已配置：${baseUrl}（Token 已写入扩展，页面不留存）`;
}

export function formatSiyuanExtensionStatusClass(status: SiyuanExtensionStatusView | null | undefined): string {
  if (status === undefined) return 'bg-slate-50 dark:bg-stone-700 text-slate-500 dark:text-stone-300';
  if (status === null) return 'bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-300';
  if (status.configChannelAvailable === false) return 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300';
  if (status.readError === true) return 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300';
  if (!status.hasToken) return 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300';
  return 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300';
}

export function formatSiyuanTokenLabel(mode: SiyuanRuntimeMode): string {
  if (mode === 'extension-relay') return '本机 Token（保存后写入扩展，页面不留存）';
  if (mode === 'direct') return '本机 Token（直连模式必填）';
  return '本机 Token（仅缓存模式不需要）';
}

export function formatSiyuanTokenPlaceholder(mode: SiyuanRuntimeMode): string {
  if (mode === 'extension-relay') return '填写后点击下方"保存到扩展"';
  if (mode === 'direct') return '思源 API Token';
  return '当前模式无需 Token';
}

export function formatSiyuanPushConfigError(code: string | undefined): string {
  if (code === 'extension-unavailable') return '扩展未安装或未启用，请先安装扩展并刷新页面';
  if (code === 'token-invalid') return 'Token 校验失败，请检查后重试';
  if (code === 'runtime-not-supported') return '当前扩展版本不支持页面配置，请更新扩展或在扩展 Options 页中配置';
  return SIYUAN_ERROR_MESSAGES[code ?? 'unknown'] ?? SIYUAN_ERROR_MESSAGES.unknown;
}

export function formatSiyuanDiagnosisMessage(errorCode?: string): string {
  if (errorCode === 'extension-unavailable') return '扩展未安装或未注入当前页面，请刷新后重试';
  return SIYUAN_ERROR_MESSAGES[errorCode ?? 'unknown'] ?? SIYUAN_ERROR_MESSAGES.unknown;
}
