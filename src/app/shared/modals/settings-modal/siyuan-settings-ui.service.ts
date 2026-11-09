import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';

import { AUTH_CONFIG } from '../../../../config/auth.config';
import { SIYUAN_CONFIG } from '../../../../config/siyuan.config';
import { LoggerService } from '../../../../services/logger.service';
import { SessionRuntimeResetRegistry } from '../../../../services/session-runtime-reset.service';
import { UserSessionService } from '../../../../services/user-session.service';
import { ExternalSourceCacheService } from '../../../core/external-sources/external-source-cache.service';
import type { SiyuanRuntimeMode } from '../../../core/external-sources/external-source.model';
import { isTrustedSiyuanDirectBaseUrl } from '../../../core/external-sources/siyuan/siyuan-direct-provider';
import { SiyuanPreviewService } from '../../../core/external-sources/siyuan/siyuan-preview.service';
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
} from '../settings-modal-siyuan-view.helpers';

type SiyuanRequestContext = {
  ownerUserId: string;
  requestId: number;
  sessionGeneration: number;
};

type SiyuanExtensionConfigProbe = Awaited<
  ReturnType<SiyuanPreviewService['probeExtensionConfigStatus']>
>;

@Injectable()
export class SiyuanSettingsUIService {
  private readonly cache = inject(ExternalSourceCacheService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly logger = inject(LoggerService);
  private readonly preview = inject(SiyuanPreviewService);
  private readonly runtimeReset = inject(SessionRuntimeResetRegistry);
  private readonly userSession = inject(UserSessionService);

  readonly runtimeMode = signal<SiyuanRuntimeMode>('extension-relay');
  readonly baseUrl = signal<string>(SIYUAN_CONFIG.DEFAULT_BASE_URL);
  readonly tokenMask = signal('');
  readonly connectionStatus = signal('');
  readonly extensionStatus = signal<SiyuanExtensionStatusView | null | undefined>(undefined);
  readonly isSavingToExtension = signal(false);
  readonly defaultBaseUrl = SIYUAN_CONFIG.DEFAULT_BASE_URL;
  readonly extensionSupported = computed(() => resolveSiyuanExtensionSupported(this.extensionStatus()));
  readonly extensionStatusMessage = computed(() => formatSiyuanExtensionStatusMessage(
    this.extensionStatus(),
    SIYUAN_CONFIG.DEFAULT_BASE_URL,
  ));
  readonly extensionStatusClass = computed(() => formatSiyuanExtensionStatusClass(this.extensionStatus()));
  readonly tokenLabel = computed(() => formatSiyuanTokenLabel(this.runtimeMode()));
  readonly tokenPlaceholder = computed(() => formatSiyuanTokenPlaceholder(this.runtimeMode()));

  private readonly pendingToken = signal('');
  private destroyed = false;
  private requestId = 0;
  private sessionGeneration = 0;

  constructor() {
    const unregisterReset = this.runtimeReset.register(
      'SiyuanSettingsUIService',
      () => this.invalidateSession(),
    );
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.invalidateSession();
      unregisterReset();
    });
  }

  async loadConfig(): Promise<void> {
    await this.loadConfigForContext(this.captureRequest());
  }

  async updateRuntimeMode(event: Event): Promise<void> {
    const rawValue = (event.target as HTMLSelectElement | null)?.value;
    if (rawValue !== 'extension-relay' && rawValue !== 'direct' && rawValue !== 'cache-only') return;
    const context = this.captureRequest();
    const value: SiyuanRuntimeMode = rawValue;
    const config = await this.cache.loadConfig(context.ownerUserId);
    if (!this.isCurrent(context)) return;

    const nextConfig = value === 'extension-relay'
      ? { ...config, runtimeMode: value, token: undefined }
      : { ...config, runtimeMode: value };
    await this.cache.saveConfig(nextConfig);
    if (!this.isCurrent(context)) return;

    this.runtimeMode.set(value);
    this.connectionStatus.set('');
    this.pendingToken.set('');
    this.tokenMask.set(value === 'extension-relay' ? '' : (nextConfig.token ? SIYUAN_TOKEN_MASK : ''));
    if (value === 'extension-relay') {
      await this.refreshExtensionStatus(context);
    } else if (this.isCurrent(context)) {
      this.extensionStatus.set(undefined);
    }
  }

  async updateBaseUrl(event: Event): Promise<void> {
    const context = this.captureRequest();
    const value = (event.target as HTMLInputElement | null)?.value.trim()
      || SIYUAN_CONFIG.DEFAULT_BASE_URL;
    if (!isTrustedSiyuanDirectBaseUrl(value, this.currentPageLocation())) {
      await this.resetUntrustedBaseUrl(context);
      return;
    }

    const config = await this.cache.loadConfig(context.ownerUserId);
    if (!this.isCurrent(context)) return;
    await this.cache.saveConfig({ ...config, baseUrl: value });
    if (!this.isCurrent(context)) return;
    this.baseUrl.set(value);
    this.connectionStatus.set('');
  }

  async updateToken(event: Event): Promise<void> {
    const value = (event.target as HTMLInputElement | null)?.value.trim() ?? '';
    if (value === SIYUAN_TOKEN_MASK) return;
    const context = this.captureRequest();
    if (this.runtimeMode() === 'extension-relay') {
      this.pendingToken.set(value);
      this.tokenMask.set(value ? SIYUAN_TOKEN_MASK : '');
      return;
    }

    const config = await this.cache.loadConfig(context.ownerUserId);
    if (!this.isCurrent(context)) return;
    await this.cache.saveConfig({ ...config, token: value || undefined });
    if (this.isCurrent(context)) this.tokenMask.set(value ? SIYUAN_TOKEN_MASK : '');
  }

  async saveConfigToExtension(): Promise<void> {
    if (this.runtimeMode() !== 'extension-relay' || this.isSavingToExtension()) return;
    const context = this.captureRequest();
    const baseUrl = this.baseUrl();
    if (!isTrustedSiyuanDirectBaseUrl(baseUrl, this.currentPageLocation())) {
      this.connectionStatus.set('仅支持本机思源地址 http://127.0.0.1:6806 或 http://localhost:6806');
      return;
    }

    this.isSavingToExtension.set(true);
    const pendingToken = this.pendingToken();
    const tokenForExtension = pendingToken.length > 0 ? pendingToken : undefined;
    try {
      const result = await this.preview.pushExtensionConfig({ baseUrl, token: tokenForExtension });
      if (!this.isCurrent(context)) return;
      if (result.ok) {
        this.connectionStatus.set('已写入扩展，可点击"测试连接"验证');
        this.pendingToken.set('');
        this.tokenMask.set('');
        await this.refreshExtensionStatus(context);
        return;
      }
      this.connectionStatus.set(formatSiyuanPushConfigError(result.errorCode));
    } catch (error) {
      if (!this.isCurrent(context)) return;
      this.logger.warn('SettingsModal', '写入扩展配置失败', {
        message: error instanceof Error ? error.message : 'unknown',
      });
      this.connectionStatus.set('写入扩展失败，请稍后重试');
    } finally {
      if (this.isSessionCurrent(context)) this.isSavingToExtension.set(false);
    }
  }

  onConfigSubmit(event: Event): void {
    event.preventDefault();
  }

  async testConnection(): Promise<void> {
    const context = this.captureRequest();
    this.connectionStatus.set('正在检测思源连接…');
    try {
      const result = await this.preview.diagnoseConnection();
      if (!this.isCurrent(context)) return;
      if (result.ok) {
        await this.applySuccessfulDiagnosis(context, result.mode);
        return;
      }
      if (result.mode === 'extension-relay' && result.errorCode === 'extension-unavailable') {
        this.extensionStatus.set(null);
      }
      this.connectionStatus.set(formatSiyuanDiagnosisMessage(result.errorCode));
    } catch (error) {
      if (!this.isCurrent(context)) return;
      this.logger.warn('SettingsModal', '思源连接诊断失败', {
        message: error instanceof Error ? error.message : 'unknown',
      });
      this.connectionStatus.set('检测失败，请稍后重试');
    }
  }

  async clearPreviewCache(): Promise<void> {
    const context = this.captureRequest();
    await this.cache.clearPreviewCache();
    if (this.isCurrent(context)) {
      this.connectionStatus.set('已清除当前账号的本机思源缓存');
    }
  }

  async forgetConfig(): Promise<void> {
    const context = this.captureRequest();
    if (this.runtimeMode() === 'extension-relay') {
      try {
        await this.preview.pushExtensionConfig({
          baseUrl: this.baseUrl() || SIYUAN_CONFIG.DEFAULT_BASE_URL,
          token: '',
        });
      } catch (error) {
        if (!this.isCurrent(context)) return;
        this.logger.warn('SettingsModal', '通知扩展清除 token 失败，继续清除本机授权', {
          message: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
    if (!this.isCurrent(context)) return;
    await this.cache.forgetConfig();
    if (!this.isCurrent(context)) return;
    await this.loadConfigForContext(context);
    if (this.isCurrent(context)) this.connectionStatus.set('已忘记本机思源授权');
  }

  private async loadConfigForContext(context: SiyuanRequestContext): Promise<void> {
    const config = await this.cache.loadConfig(context.ownerUserId);
    if (!this.isCurrent(context)) return;
    this.runtimeMode.set(config.runtimeMode);
    this.baseUrl.set(config.baseUrl || SIYUAN_CONFIG.DEFAULT_BASE_URL);
    this.tokenMask.set(config.runtimeMode === 'extension-relay'
      ? ''
      : (config.token ? SIYUAN_TOKEN_MASK : ''));
    this.pendingToken.set('');
    if (config.runtimeMode === 'extension-relay') {
      await this.refreshExtensionStatus(context);
    } else if (this.isCurrent(context)) {
      this.extensionStatus.set(undefined);
    }
  }

  private async refreshExtensionStatus(
    context: SiyuanRequestContext,
    options: { connectionVerified?: boolean } = {},
  ): Promise<SiyuanExtensionStatusView | null> {
    try {
      const probe = await this.preview.probeExtensionConfigStatus();
      if (!this.isCurrent(context)) return null;
      return this.applyExtensionProbe(probe, options);
    } catch (error) {
      if (!this.isCurrent(context)) return null;
      this.logger.warn('SettingsModal', '读取扩展配置状态失败', {
        message: error instanceof Error ? error.message : 'unknown',
      });
      const errorStatus = this.createExtensionReadErrorStatus();
      this.extensionStatus.set(errorStatus);
      return errorStatus;
    }
  }

  private applyExtensionProbe(
    probe: SiyuanExtensionConfigProbe,
    options: { connectionVerified?: boolean },
  ): SiyuanExtensionStatusView | null {
    if (probe.kind === 'ok') {
      this.extensionStatus.set(probe.status);
      if (probe.status.baseUrl) this.baseUrl.set(probe.status.baseUrl);
      return probe.status;
    }
    if (probe.kind === 'unsupported') {
      const status: SiyuanExtensionStatusView = {
        baseUrl: this.baseUrl() || SIYUAN_CONFIG.DEFAULT_BASE_URL,
        hasToken: options.connectionVerified === true,
        configChannelAvailable: false,
        connectionVerified: options.connectionVerified === true,
      };
      this.extensionStatus.set(status);
      return status;
    }
    if (probe.kind === 'unavailable') {
      this.extensionStatus.set(null);
      return null;
    }

    const errorStatus = this.createExtensionReadErrorStatus();
    this.logger.warn('SettingsModal', '读取扩展配置状态失败', { code: probe.errorCode });
    this.extensionStatus.set(errorStatus);
    return errorStatus;
  }

  private async applySuccessfulDiagnosis(
    context: SiyuanRequestContext,
    mode: SiyuanRuntimeMode,
  ): Promise<void> {
    if (mode === 'extension-relay') {
      const status = await this.refreshExtensionStatus(context, { connectionVerified: true });
      if (!this.isCurrent(context)) return;
      if (status?.readError) {
        this.connectionStatus.set('思源预览通道可用，但读取扩展配置状态失败，请稍后重试');
        return;
      }
      if (status?.configChannelAvailable === false && status.connectionVerified) {
        this.connectionStatus.set('思源预览通道可用；当前配置由扩展 Options 管理');
        return;
      }
      if (status === null) {
        this.connectionStatus.set('思源预览通道可用，但扩展配置状态已失效，请刷新页面后重试');
        return;
      }
    }
    this.connectionStatus.set(mode === 'cache-only' ? '当前为仅缓存与深链模式' : '思源预览通道可用');
  }

  private async resetUntrustedBaseUrl(context: SiyuanRequestContext): Promise<void> {
    const config = await this.cache.loadConfig(context.ownerUserId);
    if (!this.isCurrent(context)) return;
    await this.cache.saveConfig({
      ...config,
      baseUrl: SIYUAN_CONFIG.DEFAULT_BASE_URL,
      token: undefined,
    });
    if (!this.isCurrent(context)) return;
    this.baseUrl.set(SIYUAN_CONFIG.DEFAULT_BASE_URL);
    this.tokenMask.set('');
    this.pendingToken.set('');
    this.connectionStatus.set('仅支持本机思源地址 http://127.0.0.1:6806 或 http://localhost:6806，已重置授权');
  }

  private captureRequest(): SiyuanRequestContext {
    return {
      ownerUserId: this.currentOwnerUserId(),
      requestId: ++this.requestId,
      sessionGeneration: this.sessionGeneration,
    };
  }

  private isCurrent(context: SiyuanRequestContext): boolean {
    return this.isSessionCurrent(context) && context.requestId === this.requestId;
  }

  private isSessionCurrent(context: SiyuanRequestContext): boolean {
    return !this.destroyed
      && context.sessionGeneration === this.sessionGeneration
      && context.ownerUserId === this.currentOwnerUserId();
  }

  private currentOwnerUserId(): string {
    return this.userSession.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  private currentPageLocation(): Location | null {
    return typeof window === 'undefined' ? null : window.location;
  }

  private createExtensionReadErrorStatus(): SiyuanExtensionStatusView {
    return {
      baseUrl: this.baseUrl() || SIYUAN_CONFIG.DEFAULT_BASE_URL,
      hasToken: false,
      readError: true,
    };
  }

  private invalidateSession(): void {
    this.sessionGeneration += 1;
    this.requestId += 1;
    this.runtimeMode.set('extension-relay');
    this.baseUrl.set(SIYUAN_CONFIG.DEFAULT_BASE_URL);
    this.tokenMask.set('');
    this.pendingToken.set('');
    this.connectionStatus.set('');
    this.extensionStatus.set(undefined);
    this.isSavingToExtension.set(false);
  }
}
