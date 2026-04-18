import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { success } from '../utils/result';
import { LoggerService } from './logger.service';
import { SupabaseClientService } from './supabase-client.service';
import { WidgetBindingService } from './widget-binding.service';

function setup(options?: {
  isConfigured?: boolean;
  clientAsyncResult?: unknown;
}) {
  const logger = {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };

  const invoke = vi.fn();
  const clientAsync = vi.fn().mockResolvedValue(options?.clientAsyncResult ?? {
    functions: {
      invoke,
    },
  });

  const injector = Injector.create({
    providers: [
      { provide: WidgetBindingService, useClass: WidgetBindingService },
      {
        provide: LoggerService,
        useValue: {
          category: vi.fn(() => logger),
        },
      },
      {
        provide: SupabaseClientService,
        useValue: {
          isConfigured: options?.isConfigured ?? true,
          clientAsync,
        },
      },
    ],
  });

  return {
    service: runInInjectionContext(injector, () => injector.get(WidgetBindingService)),
    invoke,
    clientAsync,
    logger,
  };
}

describe('WidgetBindingService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Supabase 未配置时应直接跳过远端吊销', async () => {
    const { service, clientAsync } = setup({ isConfigured: false });

    await expect(service.revokeAllBindings()).resolves.toEqual({
      ok: true,
      value: { revokedCount: 0 },
    });
    expect(clientAsync).not.toHaveBeenCalled();
  });

  it('应调用 widget-register revoke-all 并返回吊销数量', async () => {
    const { service, invoke } = setup();
    invoke.mockResolvedValueOnce({
      data: { revokedCount: 3 },
      error: null,
    });

    const result = await service.revokeAllBindings();

    expect(invoke).toHaveBeenCalledWith('widget-register', {
      body: { action: 'revoke-all' },
    });
    expect(result).toEqual({
      ok: true,
      value: { revokedCount: 3 },
    });
  });

  it('Edge Function 调用失败时应返回失败结果', async () => {
    const { service, invoke, logger } = setup();
    invoke.mockResolvedValueOnce({
      data: null,
      error: { message: 'Function not found' },
    });

    const result = await service.revokeAllBindings();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('OPERATION_FAILED');
      expect(result.error.message).toContain('资源不存在');
    }
    expect(logger.warn).toHaveBeenCalled();
  });

  it('Android bootstrap 注册时不应写入共享 widget-runtime IndexedDB', async () => {
    const { service, invoke } = setup();
    const writeWidgetTokenToDb = vi.spyOn(service as never, 'writeWidgetTokenToDb' as never).mockResolvedValue(undefined);
    const writeWidgetConfigToDb = vi.spyOn(service as never, 'writeWidgetConfigToDb' as never).mockResolvedValue(undefined);
    const notifySwRefresh = vi.spyOn(service as never, 'notifySwRefresh' as never).mockImplementation(() => {});

    invoke.mockResolvedValueOnce({
      data: {
        deviceId: '22222222-2222-4222-8222-222222222222',
        bindingGeneration: 2,
        expiresAt: '2026-04-20T00:00:00.000Z',
        widgetToken: 'android-token',
        instance: { id: '33333333-3333-4333-8333-333333333333' },
      },
      error: null,
    });

    const result = await service.registerDevice({
      deviceId: '22222222-2222-4222-8222-222222222222',
      installationId: '11111111-1111-4111-8111-111111111111',
      deviceSecret: 'super-secret-device-key',
      platform: 'android-widget',
      pushToken: 'fcm-token',
      instance: {
        id: '33333333-3333-4333-8333-333333333333',
        hostInstanceId: '42',
        sizeBucket: '4x2',
      },
      persistRuntimeBinding: false,
    });

    expect(invoke).toHaveBeenCalledWith('widget-register', {
      body: {
        action: 'register',
        deviceId: '22222222-2222-4222-8222-222222222222',
        installationId: '11111111-1111-4111-8111-111111111111',
        deviceSecret: 'super-secret-device-key',
        platform: 'android-widget',
        pushToken: 'fcm-token',
        instance: {
          id: '33333333-3333-4333-8333-333333333333',
          hostInstanceId: '42',
          sizeBucket: '4x2',
        },
      },
    });
    expect(writeWidgetTokenToDb).not.toHaveBeenCalled();
    expect(writeWidgetConfigToDb).not.toHaveBeenCalled();
    expect(notifySwRefresh).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      value: {
        deviceId: '22222222-2222-4222-8222-222222222222',
        bindingGeneration: 2,
        expiresAt: '2026-04-20T00:00:00.000Z',
        widgetToken: 'android-token',
        instanceId: '33333333-3333-4333-8333-333333333333',
      },
    });
  });

  it('应构造 Android bootstrap 回调 URL 并保持 native host 所需字段', async () => {
    const { service } = setup();
    const registerDevice = vi.spyOn(service, 'registerDevice').mockResolvedValue(success({
      deviceId: '22222222-2222-4222-8222-222222222222',
      bindingGeneration: 4,
      expiresAt: '2026-04-20T00:00:00.000Z',
      widgetToken: 'android-token',
      instanceId: '55555555-5555-4555-8555-555555555555',
    }));

    const result = await service.completeAndroidBootstrap({
      callbackUri: 'nanoflow-widget://bootstrap',
      installationId: '11111111-1111-4111-8111-111111111111',
      deviceId: '22222222-2222-4222-8222-222222222222',
      deviceSecret: 'super-secret-device-key',
      clientVersion: 'android-widget/0.1.0',
      instanceId: '33333333-3333-4333-8333-333333333333',
      hostInstanceId: '42',
      sizeBucket: '4x2',
      bootstrapNonce: '44444444-4444-4444-8444-444444444444',
      pendingPushToken: 'fcm-token',
    });

    expect(registerDevice).toHaveBeenCalledWith({
      deviceId: '22222222-2222-4222-8222-222222222222',
      installationId: '11111111-1111-4111-8111-111111111111',
      deviceSecret: 'super-secret-device-key',
      platform: 'android-widget',
      pushToken: 'fcm-token',
      clientVersion: 'android-widget/0.1.0',
      clientSurface: 'android-host',
      instance: {
        id: '33333333-3333-4333-8333-333333333333',
        hostInstanceId: '42',
        sizeBucket: '4x2',
      },
      persistRuntimeBinding: false,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.callbackUrl).toBe(
        'nanoflow-widget://bootstrap#widgetToken=android-token&widgetInstallationId=11111111-1111-4111-8111-111111111111&widgetDeviceId=22222222-2222-4222-8222-222222222222&widgetSupabaseUrl=YOUR_SUPABASE_URL&bindingGeneration=4&expiresAt=2026-04-20T00%3A00%3A00.000Z&widgetInstanceId=55555555-5555-4555-8555-555555555555&widgetHostInstanceId=42&widgetBootstrapNonce=44444444-4444-4444-8444-444444444444',
      );
      expect(result.value.callbackIntentUrl).toBe(
        'intent://bootstrap?widgetToken=android-token&widgetInstallationId=11111111-1111-4111-8111-111111111111&widgetDeviceId=22222222-2222-4222-8222-222222222222&widgetSupabaseUrl=YOUR_SUPABASE_URL&bindingGeneration=4&expiresAt=2026-04-20T00%3A00%3A00.000Z&widgetInstanceId=55555555-5555-4555-8555-555555555555&widgetHostInstanceId=42&widgetBootstrapNonce=44444444-4444-4444-8444-444444444444#Intent;scheme=nanoflow-widget;end',
      );
    }
  });

  it('应同步 Windows pending instance 并回写共享运行时绑定', async () => {
    const { service } = setup();
    const registerDevice = vi.spyOn(service, 'registerDevice').mockResolvedValue(success({
      deviceId: '22222222-2222-4222-8222-222222222222',
      bindingGeneration: 3,
      expiresAt: '2026-04-20T00:00:00.000Z',
      widgetToken: 'windows-token',
      instanceId: '33333333-3333-4333-8333-333333333333',
    }));
    const readPendingWidgetInstanceStateFromDb = vi
      .spyOn(service as never, 'readPendingWidgetInstanceStateFromDb' as never)
      .mockResolvedValue({
        instances: {
          'widget-host-42': {
            hostInstanceId: 'widget-host-42',
            sizeBucket: 'default',
            observedAt: '2026-04-16T00:00:00.000Z',
          },
        },
      });
    const readWidgetConfigFromDb = vi
      .spyOn(service as never, 'readWidgetConfigFromDb' as never)
      .mockResolvedValue({
        supabaseUrl: 'YOUR_SUPABASE_URL',
        deviceId: '22222222-2222-4222-8222-222222222222',
        installationId: '11111111-1111-4111-8111-111111111111',
        deviceSecret: 'super-secret-device-key',
        clientVersion: 'stale-version',
        clientSurface: 'windows-pwa',
        instanceBindings: {},
      });
    const writeWidgetTokenToDb = vi.spyOn(service as never, 'writeWidgetTokenToDb' as never).mockResolvedValue(undefined);
    const writeWidgetConfigToDb = vi.spyOn(service as never, 'writeWidgetConfigToDb' as never).mockResolvedValue(undefined);
    const notifySwRefresh = vi.spyOn(service as never, 'notifySwRefresh' as never).mockImplementation(() => {});

    const result = await service.syncWindowsPwaBindings();

    expect(readPendingWidgetInstanceStateFromDb).toHaveBeenCalledTimes(1);
    expect(readWidgetConfigFromDb).toHaveBeenCalledTimes(1);
    expect(registerDevice).toHaveBeenCalledWith({
      deviceId: '22222222-2222-4222-8222-222222222222',
      installationId: '11111111-1111-4111-8111-111111111111',
      deviceSecret: 'super-secret-device-key',
      platform: 'windows-pwa',
      clientVersion: expect.any(String),
      clientSurface: 'windows-pwa',
      instance: {
        id: expect.any(String),
        hostInstanceId: 'widget-host-42',
        sizeBucket: 'default',
      },
      persistRuntimeBinding: false,
    });
    expect(writeWidgetTokenToDb).toHaveBeenCalledWith('windows-token');
    expect(writeWidgetConfigToDb).toHaveBeenCalledWith(expect.objectContaining({
      supabaseUrl: 'YOUR_SUPABASE_URL',
      deviceId: '22222222-2222-4222-8222-222222222222',
      installationId: '11111111-1111-4111-8111-111111111111',
      deviceSecret: 'super-secret-device-key',
      clientSurface: 'windows-pwa',
      instanceBindings: {
        'widget-host-42': {
          instanceId: '33333333-3333-4333-8333-333333333333',
          hostInstanceId: 'widget-host-42',
          sizeBucket: 'default',
          observedAt: '2026-04-16T00:00:00.000Z',
        },
      },
    }));
    expect(notifySwRefresh).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: true,
      value: { registeredCount: 1 },
    });
  });
  it('获取不到 Web Lock 时应跳过本轮 Windows 同步', async () => {
    const { service } = setup();
    const request = vi.fn(async (_name: string, _options: { ifAvailable?: boolean }, callback: (lock: object | null) => Promise<unknown>) => callback(null));
    vi.stubGlobal('navigator', {
      locks: {
        request,
      },
    });

    try {
      const readPendingWidgetInstanceStateFromDb = vi.spyOn(service as never, 'readPendingWidgetInstanceStateFromDb' as never);

      const result = await service.syncWindowsPwaBindings();

      expect(request).toHaveBeenCalledTimes(1);
      expect(readPendingWidgetInstanceStateFromDb).not.toHaveBeenCalled();
      expect(result).toEqual({
        ok: true,
        value: { registeredCount: 0 },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('没有 Windows pending instance 时应跳过同步', async () => {
    const { service } = setup();
    vi.spyOn(service as never, 'readPendingWidgetInstanceStateFromDb' as never).mockResolvedValue({
      instances: {},
    });
    vi.spyOn(service as never, 'readWidgetConfigFromDb' as never).mockResolvedValue(null);
    const registerDevice = vi.spyOn(service, 'registerDevice');

    const result = await service.syncWindowsPwaBindings();

    expect(registerDevice).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      value: { registeredCount: 0 },
    });
  });

  it('Windows 绑定未变化且 clientVersion 未漂移时不应重复 register', async () => {
    const { service } = setup();
    const currentVersion = (service as never)['resolveWidgetClientVersion' as never]() as string;
    vi.spyOn(service as never, 'readPendingWidgetInstanceStateFromDb' as never).mockResolvedValue({
      instances: {
        'widget-host-42': {
          hostInstanceId: 'widget-host-42',
          sizeBucket: 'default',
          observedAt: '2026-04-16T00:00:00.000Z',
        },
      },
    });
    vi.spyOn(service as never, 'readWidgetConfigFromDb' as never).mockResolvedValue({
      supabaseUrl: 'YOUR_SUPABASE_URL',
      deviceId: '22222222-2222-4222-8222-222222222222',
      installationId: '11111111-1111-4111-8111-111111111111',
      deviceSecret: 'super-secret-device-key',
      clientVersion: currentVersion,
      clientSurface: 'windows-pwa',
      instanceBindings: {
        'widget-host-42': {
          instanceId: '33333333-3333-4333-8333-333333333333',
          hostInstanceId: 'widget-host-42',
          sizeBucket: 'default',
          observedAt: '2026-04-16T00:00:00.000Z',
        },
      },
    });
    const registerDevice = vi.spyOn(service, 'registerDevice');
    const writeWidgetConfigToDb = vi.spyOn(service as never, 'writeWidgetConfigToDb' as never).mockResolvedValue(undefined);

    const result = await service.syncWindowsPwaBindings();

    expect(registerDevice).not.toHaveBeenCalled();
    expect(writeWidgetConfigToDb).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      value: { registeredCount: 0 },
    });
  });

  it('没有活跃 Windows instance 时应上报实例卸载并清理本地绑定', async () => {
    const { service } = setup();
    vi.spyOn(service as never, 'readPendingWidgetInstanceStateFromDb' as never).mockResolvedValue({
      instances: {},
    });
    vi.spyOn(service as never, 'readWidgetConfigFromDb' as never).mockResolvedValue({
      supabaseUrl: 'YOUR_SUPABASE_URL',
      deviceId: '22222222-2222-4222-8222-222222222222',
      installationId: '11111111-1111-4111-8111-111111111111',
      deviceSecret: 'super-secret-device-key',
      clientVersion: 'current',
      clientSurface: 'windows-pwa',
      instanceBindings: {
        'widget-host-42': {
          instanceId: '33333333-3333-4333-8333-333333333333',
          hostInstanceId: 'widget-host-42',
          sizeBucket: 'default',
          observedAt: '2026-04-16T00:00:00.000Z',
        },
      },
    });
    const uninstallWidgetInstance = vi.spyOn(service as never, 'uninstallWidgetInstance' as never).mockResolvedValue({
      ok: true,
      value: true,
    });
    const clearWidgetTokenFromDb = vi.spyOn(service as never, 'clearWidgetTokenFromDb' as never).mockResolvedValue(undefined);

    const result = await service.syncWindowsPwaBindings();

    expect(uninstallWidgetInstance).toHaveBeenCalledWith({
      deviceId: '22222222-2222-4222-8222-222222222222',
      installationId: '11111111-1111-4111-8111-111111111111',
      platform: 'windows-pwa',
      instance: {
        instanceId: '33333333-3333-4333-8333-333333333333',
        hostInstanceId: 'widget-host-42',
        sizeBucket: 'default',
        observedAt: '2026-04-16T00:00:00.000Z',
      },
    });
    expect(clearWidgetTokenFromDb).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: true,
      value: { registeredCount: 0 },
    });
  });

  it('服务端未确认实例卸载时不应删除本地绑定或清理凭证', async () => {
    const { service, logger } = setup();
    vi.spyOn(service as never, 'readPendingWidgetInstanceStateFromDb' as never).mockResolvedValue({
      instances: {},
    });
    vi.spyOn(service as never, 'readWidgetConfigFromDb' as never).mockResolvedValue({
      supabaseUrl: 'YOUR_SUPABASE_URL',
      deviceId: '22222222-2222-4222-8222-222222222222',
      installationId: '11111111-1111-4111-8111-111111111111',
      deviceSecret: 'super-secret-device-key',
      clientVersion: 'current',
      clientSurface: 'windows-pwa',
      instanceBindings: {
        'widget-host-42': {
          instanceId: '33333333-3333-4333-8333-333333333333',
          hostInstanceId: 'widget-host-42',
          sizeBucket: 'default',
          observedAt: '2026-04-16T00:00:00.000Z',
        },
      },
    });
    const uninstallWidgetInstance = vi.spyOn(service as never, 'uninstallWidgetInstance' as never).mockResolvedValue({
      ok: true,
      value: false,
    });
    const clearWidgetTokenFromDb = vi.spyOn(service as never, 'clearWidgetTokenFromDb' as never).mockResolvedValue(undefined);
    const writeWidgetConfigToDb = vi.spyOn(service as never, 'writeWidgetConfigToDb' as never).mockResolvedValue(undefined);

    const result = await service.syncWindowsPwaBindings();

    expect(uninstallWidgetInstance).toHaveBeenCalledTimes(1);
    expect(clearWidgetTokenFromDb).not.toHaveBeenCalled();
    expect(writeWidgetConfigToDb).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Windows Widget 实例卸载未获服务端确认', {
      hostInstanceId: 'widget-host-42',
      instanceId: '33333333-3333-4333-8333-333333333333',
    });
    expect(result).toEqual({
      ok: true,
      value: { registeredCount: 0 },
    });
  });
});

