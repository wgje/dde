import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { environment } from '../environments/environment';
import { success } from '../utils/result';
import { LoggerService } from './logger.service';
import { SupabaseClientService } from './supabase-client.service';
import {
  WidgetBindingOutboxStore,
  type WidgetBindingOutboxOperation,
} from './widget-binding-outbox.store';
import { WidgetBindingService } from './widget-binding.service';

function createFunctionsHttpError(body: Record<string, unknown>, message = 'Edge Function returned a non-2xx status code') {
  return {
    message,
    context: {
      json: vi.fn().mockResolvedValue(body),
    },
  };
}

type WidgetBindingOutboxMocks = {
  enqueueRevokeAll: Mock<WidgetBindingOutboxStore['enqueueRevokeAll']>;
  readPending: Mock<WidgetBindingOutboxStore['readPending']>;
  delete: Mock<WidgetBindingOutboxStore['delete']>;
  markAttempt: Mock<WidgetBindingOutboxStore['markAttempt']>;
};

function setup(options?: {
  isConfigured?: boolean;
  clientAsyncResult?: unknown;
  outbox?: Partial<WidgetBindingOutboxMocks>;
}) {
  const logger = {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };

  const invoke = vi.fn();
  const clientAsyncResult = options && 'clientAsyncResult' in options
    ? options.clientAsyncResult
    : {
        functions: {
          invoke,
        },
      };
  const clientAsync = vi.fn().mockResolvedValue(clientAsyncResult);
  const defaultOperation: WidgetBindingOutboxOperation = {
    operationId: '00000000-0000-4000-8000-000000000201',
    type: 'revoke-all',
    createdAt: '2026-06-29T00:00:00.000Z',
    updatedAt: '2026-06-29T00:00:00.000Z',
    attemptCount: 0,
  };
  const outbox: WidgetBindingOutboxMocks = {
    enqueueRevokeAll: vi.fn<WidgetBindingOutboxStore['enqueueRevokeAll']>().mockResolvedValue(defaultOperation),
    readPending: vi.fn<WidgetBindingOutboxStore['readPending']>().mockResolvedValue([defaultOperation]),
    delete: vi.fn<WidgetBindingOutboxStore['delete']>().mockResolvedValue(undefined),
    markAttempt: vi.fn<WidgetBindingOutboxStore['markAttempt']>().mockResolvedValue(undefined),
    ...options?.outbox,
  };

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
      {
        provide: WidgetBindingOutboxStore,
        useValue: outbox,
      },
    ],
  });

  return {
    service: runInInjectionContext(injector, () => injector.get(WidgetBindingService)),
    invoke,
    clientAsync,
    logger,
    outbox,
    defaultOperation,
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

  it('应先持久化 revoke-all outbox，再调用 widget-register 并在成功后删除队列项', async () => {
    const events: string[] = [];
    const operation: WidgetBindingOutboxOperation = {
      operationId: '00000000-0000-4000-8000-000000000202',
      type: 'revoke-all',
      createdAt: '2026-06-29T00:00:00.000Z',
      updatedAt: '2026-06-29T00:00:00.000Z',
      attemptCount: 0,
    };
    const { service, invoke, outbox } = setup({
      outbox: {
        enqueueRevokeAll: vi.fn<WidgetBindingOutboxStore['enqueueRevokeAll']>().mockImplementation(async () => {
          events.push('enqueue');
          return operation;
        }),
        readPending: vi.fn<WidgetBindingOutboxStore['readPending']>().mockResolvedValue([operation]),
        delete: vi.fn<WidgetBindingOutboxStore['delete']>().mockImplementation(async () => {
          events.push('delete');
        }),
      },
    });
    invoke.mockImplementationOnce(async (_name, options) => {
      events.push('invoke');
      return {
        data: { revokedCount: 3 },
        error: null,
      };
    });

    const result = await service.revokeAllBindings();

    expect(invoke).toHaveBeenCalledWith('widget-register', {
      body: {
        action: 'revoke-all',
        operationId: '00000000-0000-4000-8000-000000000202',
      },
    });
    expect(events).toEqual(['enqueue', 'invoke', 'delete']);
    expect(outbox.delete).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000202');
    expect(result).toEqual({
      ok: true,
      value: {
        revokedCount: 3,
        syncStatus: 'synced',
        operationId: '00000000-0000-4000-8000-000000000202',
      },
    });
  });

  it('Edge Function 调用失败时应保留 revoke-all outbox 并返回 queued 结果', async () => {
    const { service, invoke, logger, outbox, defaultOperation } = setup();
    invoke.mockResolvedValueOnce({
      data: null,
      error: { message: 'Function not found' },
    });

    const result = await service.revokeAllBindings();

    expect(result).toEqual({
      ok: true,
      value: {
        revokedCount: 0,
        syncStatus: 'queued',
        operationId: defaultOperation.operationId,
      },
    });
    expect(outbox.delete).not.toHaveBeenCalled();
    // 瞬态失败必须递增尝试计数，否则永久失败封顶永远不会触发
    expect(outbox.markAttempt).toHaveBeenCalledWith(defaultOperation.operationId);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('4xx 业务拒绝时应放弃 revoke-all 重试并返回真实失败而非 queued', async () => {
    const { service, invoke, outbox, defaultOperation } = setup();
    outbox.readPending
      .mockResolvedValueOnce([defaultOperation])
      .mockResolvedValueOnce([]);
    invoke.mockResolvedValueOnce({
      data: null,
      error: {
        message: 'Edge Function returned a non-2xx status code',
        context: {
          status: 400,
          json: vi.fn().mockResolvedValue({ error: 'revoke-all 参数无效' }),
        },
      },
    });

    const result = await service.revokeAllBindings();

    expect(outbox.delete).toHaveBeenCalledWith(defaultOperation.operationId);
    expect(outbox.markAttempt).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('revoke-all 参数无效');
    }
  });

  it('达到重试封顶后应放弃 revoke-all 并返回失败', async () => {
    const { service, invoke, outbox, defaultOperation } = setup();
    const cappedOperation = { ...defaultOperation, attemptCount: 11 };
    outbox.readPending
      .mockResolvedValueOnce([cappedOperation])
      .mockResolvedValueOnce([]);
    invoke.mockResolvedValueOnce({
      data: null,
      error: { message: 'Function not found' },
    });

    const result = await service.revokeAllBindings();

    expect(outbox.delete).toHaveBeenCalledWith(cappedOperation.operationId);
    expect(result.ok).toBe(false);
  });

  it('Supabase 客户端未就绪时也应保留 revoke-all outbox 并避免阻塞登出', async () => {
    const { service, invoke, outbox, defaultOperation } = setup({ clientAsyncResult: null });

    const result = await service.revokeAllBindings();

    expect(outbox.enqueueRevokeAll).toHaveBeenCalled();
    expect(outbox.delete).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      value: {
        revokedCount: 0,
        syncStatus: 'queued',
        operationId: defaultOperation.operationId,
      },
    });
  });

  it('Widget register 失败时应优先使用 FunctionsHttpError body 中的业务消息', async () => {
    const { service, invoke } = setup();
    invoke.mockResolvedValueOnce({
      data: null,
      error: createFunctionsHttpError({ error: '设备密钥无效，请重新绑定小组件' }),
    });

    const result = await service.registerDevice({
      deviceId: '22222222-2222-4222-8222-222222222222',
      installationId: '11111111-1111-4111-8111-111111111111',
      deviceSecret: 'stale-device-key',
      platform: 'android-widget',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('设备密钥无效，请重新绑定小组件');
    }
  });

  it('Android bootstrap 注册时应仅提交原生宿主所需字段', async () => {
    const { service, invoke } = setup();

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

  it('已有绑定 generation 时应透传 expectedBindingGeneration 防止旧注册覆盖新绑定', async () => {
    const { service, invoke } = setup();
    invoke.mockResolvedValueOnce({
      data: {
        deviceId: '22222222-2222-4222-8222-222222222222',
        bindingGeneration: 4,
        expiresAt: '2026-04-20T00:00:00.000Z',
        widgetToken: 'android-token',
        instance: null,
      },
      error: null,
    });
    const params = {
      deviceId: '22222222-2222-4222-8222-222222222222',
      installationId: '11111111-1111-4111-8111-111111111111',
      deviceSecret: 'super-secret-device-key',
      platform: 'android-widget',
      expectedBindingGeneration: 3,
    } as Parameters<WidgetBindingService['registerDevice']>[0] & {
      expectedBindingGeneration: number;
    };

    await service.registerDevice(params);

    expect(invoke).toHaveBeenCalledWith('widget-register', {
      body: expect.objectContaining({
        action: 'register',
        expectedBindingGeneration: 3,
      }),
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
      const encodedSupabaseUrl = encodeURIComponent(environment.supabaseUrl);
      expect(result.value.callbackUrl).toBe(
        `nanoflow-widget://bootstrap?widgetToken=android-token&widgetInstallationId=11111111-1111-4111-8111-111111111111&widgetDeviceId=22222222-2222-4222-8222-222222222222&widgetSupabaseUrl=${encodedSupabaseUrl}&bindingGeneration=4&expiresAt=2026-04-20T00%3A00%3A00.000Z&widgetInstanceId=55555555-5555-4555-8555-555555555555&widgetHostInstanceId=42&widgetBootstrapNonce=44444444-4444-4444-8444-444444444444`,
      );
      expect(result.value.callbackIntentUrl).toBe(
        `intent://bootstrap?widgetToken=android-token&widgetInstallationId=11111111-1111-4111-8111-111111111111&widgetDeviceId=22222222-2222-4222-8222-222222222222&widgetSupabaseUrl=${encodedSupabaseUrl}&bindingGeneration=4&expiresAt=2026-04-20T00%3A00%3A00.000Z&widgetInstanceId=55555555-5555-4555-8555-555555555555&widgetHostInstanceId=42&widgetBootstrapNonce=44444444-4444-4444-8444-444444444444#Intent;scheme=nanoflow-widget;package=app.nanoflow.twa;end`,
      );
    }
  });

});
