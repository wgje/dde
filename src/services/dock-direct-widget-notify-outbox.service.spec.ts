import { Injector } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DockDirectWidgetNotifyOutboxService,
  type DockDirectWidgetNotifyClient,
} from './dock-direct-widget-notify-outbox.service';

describe('DockDirectWidgetNotifyOutboxService', () => {
  let service: DockDirectWidgetNotifyOutboxService;

  beforeEach(() => {
    service = Injector.create({
      providers: [
        { provide: DockDirectWidgetNotifyOutboxService, useClass: DockDirectWidgetNotifyOutboxService },
      ],
    }).get(DockDirectWidgetNotifyOutboxService);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await service.clearPendingNotificationsForTests();
  });

  it('persists only the latest focus state per session across service instances', async () => {
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000301')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000302');

    await service.enqueueLatest({
      focusSessionId: 'focus-session-1',
      focusActive: true,
      updatedAt: '2026-06-29T00:00:00.000Z',
      ownerUserId: 'owner-user-1',
    });
    await service.enqueueLatest({
      focusSessionId: 'focus-session-1',
      focusActive: false,
      updatedAt: '2026-06-29T00:00:05.000Z',
      ownerUserId: 'owner-user-1',
    });

    const restored = Injector.create({
      providers: [
        { provide: DockDirectWidgetNotifyOutboxService, useClass: DockDirectWidgetNotifyOutboxService },
      ],
    }).get(DockDirectWidgetNotifyOutboxService);

    expect(await restored.listPendingNotifications()).toEqual([
      expect.objectContaining({
        operationId: '00000000-0000-4000-8000-000000000302',
        focusSessionId: 'focus-session-1',
        focusActive: false,
        updatedAt: '2026-06-29T00:00:05.000Z',
        attemptCount: 0,
      }),
    ]);
  });

  it('flushes pending notifications and deletes them only after widget-notify succeeds', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000303');
    await service.enqueueLatest({
      focusSessionId: 'focus-session-1',
      focusActive: true,
      updatedAt: '2026-06-29T00:00:00.000Z',
      ownerUserId: 'owner-user-1',
    });
    const invoke = vi.fn().mockResolvedValue({ data: null, error: null });
    const client = { functions: { invoke } } as unknown as DockDirectWidgetNotifyClient;

    const result = await service.flushPendingNotifications(client);

    expect(result).toEqual({
      ok: true,
      sentCount: 1,
      remainingCount: 0,
      errors: [],
    });
    expect(invoke).toHaveBeenCalledWith(
      'widget-notify',
      expect.objectContaining({
        body: expect.objectContaining({
          directNotify: true,
          webhookId: 'pwa-direct-00000000-0000-4000-8000-000000000303',
          focusSessionId: 'focus-session-1',
          focusActive: true,
          updatedAt: '2026-06-29T00:00:00.000Z',
        }),
      }),
    );
    expect(await service.listPendingNotifications()).toEqual([]);
  });

  it('并发 flush 应合流为单飞，不得对同一批记录重复 invoke widget-notify', async () => {
    // flappy 网络下两次 restore 扇出可能重叠：读-发-删无锁并发会重复推送
    await service.enqueueLatest({
      focusSessionId: 'focus-session-single-flight',
      focusActive: true,
      updatedAt: '2026-06-29T00:00:00.000Z',
      ownerUserId: 'owner-user-1',
    });
    let resolveInvoke!: (value: { data: null; error: null }) => void;
    const invoke = vi.fn(() => new Promise<{ data: null; error: null }>(resolve => {
      resolveInvoke = resolve;
    }));
    const client = { functions: { invoke } } as unknown as DockDirectWidgetNotifyClient;

    const first = service.flushPendingNotifications(client);
    const second = service.flushPendingNotifications(client);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    resolveInvoke({ data: null, error: null });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(firstResult).toEqual(secondResult);
    expect(await service.listPendingNotifications()).toEqual([]);
  });

  it('keeps failed notifications pending with attempt metadata', async () => {
    await service.enqueueLatest({
      focusSessionId: 'focus-session-1',
      focusActive: true,
      updatedAt: '2026-06-29T00:00:00.000Z',
      ownerUserId: 'owner-user-1',
    });
    const invoke = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'network timeout' },
    });
    const client = { functions: { invoke } } as unknown as DockDirectWidgetNotifyClient;

    const result = await service.flushPendingNotifications(client);

    expect(result).toEqual({
      ok: false,
      sentCount: 0,
      remainingCount: 1,
      errors: ['network timeout'],
    });
    expect(await service.listPendingNotifications()).toEqual([
      expect.objectContaining({
        focusSessionId: 'focus-session-1',
        focusActive: true,
        attemptCount: 1,
        lastError: 'network timeout',
      }),
    ]);
  });

  it('drops notifications rejected by a permanent 4xx business error and preserves the envelope message', async () => {
    await service.enqueueLatest({
      focusSessionId: 'focus-session-1',
      focusActive: true,
      updatedAt: '2026-06-29T00:00:00.000Z',
      ownerUserId: 'owner-user-1',
    });
    const invoke = vi.fn().mockResolvedValue({
      data: null,
      error: {
        message: 'Edge Function returned a non-2xx status code',
        context: {
          status: 400,
          json: async () => ({ error: 'invalid widget notify payload', code: 'INVALID_PAYLOAD' }),
        },
      },
    });
    const client = { functions: { invoke } } as unknown as DockDirectWidgetNotifyClient;

    const result = await service.flushPendingNotifications(client);

    expect(result).toEqual({
      ok: false,
      sentCount: 0,
      remainingCount: 0,
      errors: ['invalid widget notify payload'],
    });
    // 永久业务拒绝的记录不得再进入下一次重连 flush
    expect(await service.listPendingNotifications()).toEqual([]);
  });

  it('keeps 401-rejected notifications pending because a session refresh can recover them', async () => {
    await service.enqueueLatest({
      focusSessionId: 'focus-session-1',
      focusActive: true,
      updatedAt: '2026-06-29T00:00:00.000Z',
      ownerUserId: 'owner-user-1',
    });
    const invoke = vi.fn().mockResolvedValue({
      data: null,
      error: {
        message: 'Edge Function returned a non-2xx status code',
        context: {
          status: 401,
          json: async () => ({ error: 'missing authorization' }),
        },
      },
    });
    const client = { functions: { invoke } } as unknown as DockDirectWidgetNotifyClient;

    const result = await service.flushPendingNotifications(client);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['missing authorization']);
    expect(await service.listPendingNotifications()).toEqual([
      expect.objectContaining({
        focusSessionId: 'focus-session-1',
        attemptCount: 1,
        lastError: 'missing authorization',
      }),
    ]);
  });

  it('drops notifications after the retry attempt cap even for transient errors', async () => {
    await service.enqueueLatest({
      focusSessionId: 'focus-session-1',
      focusActive: true,
      updatedAt: '2026-06-29T00:00:00.000Z',
      ownerUserId: 'owner-user-1',
    });
    const invoke = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'network timeout' },
    });
    const client = { functions: { invoke } } as unknown as DockDirectWidgetNotifyClient;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await service.flushPendingNotifications(client);
    }

    // 第 10 次失败达到上限后记录被移除，后续 flush 不再重放
    expect(await service.listPendingNotifications()).toEqual([]);
    const finalResult = await service.flushPendingNotifications(client);
    expect(finalResult).toEqual({
      ok: true,
      sentCount: 0,
      remainingCount: 0,
      errors: [],
    });
  });

  it('persists only the latest black-box widget notification per entry action across service instances', async () => {
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000401')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000402');

    await service.enqueueLatest({
      kind: 'black-box',
      entryId: 'black-box-entry-1',
      blackBoxAction: 'complete',
      updatedAt: '2026-06-29T00:00:00.000Z',
      ownerUserId: 'owner-user-1',
    });
    await service.enqueueLatest({
      kind: 'black-box',
      entryId: 'black-box-entry-1',
      blackBoxAction: 'complete',
      updatedAt: '2026-06-29T00:00:05.000Z',
      ownerUserId: 'owner-user-1',
    });

    const restored = Injector.create({
      providers: [
        { provide: DockDirectWidgetNotifyOutboxService, useClass: DockDirectWidgetNotifyOutboxService },
      ],
    }).get(DockDirectWidgetNotifyOutboxService);

    expect(await restored.listPendingNotifications()).toEqual([
      expect.objectContaining({
        kind: 'black-box',
        operationId: '00000000-0000-4000-8000-000000000402',
        entryId: 'black-box-entry-1',
        blackBoxAction: 'complete',
        updatedAt: '2026-06-29T00:00:05.000Z',
        attemptCount: 0,
      }),
    ]);
  });

  it('flushes pending black-box widget notifications and deletes them only after success', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000403');
    await service.enqueueLatest({
      kind: 'black-box',
      entryId: 'black-box-entry-2',
      blackBoxAction: 'read',
      updatedAt: '2026-06-29T00:00:00.000Z',
      ownerUserId: 'owner-user-1',
    });
    const invoke = vi.fn().mockResolvedValue({ data: null, error: null });
    const client = { functions: { invoke } } as unknown as DockDirectWidgetNotifyClient;

    const result = await service.flushPendingNotifications(client);

    expect(result).toEqual({
      ok: true,
      sentCount: 1,
      remainingCount: 0,
      errors: [],
    });
    expect(invoke).toHaveBeenCalledWith(
      'widget-notify',
      expect.objectContaining({
        body: expect.objectContaining({
          directNotify: true,
          webhookId: 'pwa-blackbox-00000000-0000-4000-8000-000000000403',
          table: 'black_box_entries',
          entryId: 'black-box-entry-2',
          blackBoxAction: 'read',
          updatedAt: '2026-06-29T00:00:00.000Z',
        }),
      }),
    );
    expect(await service.listPendingNotifications()).toEqual([]);
  });

  it('keeps failed black-box widget notifications pending with attempt metadata', async () => {
    await service.enqueueLatest({
      kind: 'black-box',
      entryId: 'black-box-entry-3',
      blackBoxAction: 'complete',
      updatedAt: '2026-06-29T00:00:00.000Z',
      ownerUserId: 'owner-user-1',
    });
    const invoke = vi.fn().mockRejectedValue(new Error('network suspended'));
    const client = { functions: { invoke } } as unknown as DockDirectWidgetNotifyClient;

    const result = await service.flushPendingNotifications(client);

    expect(result).toEqual({
      ok: false,
      sentCount: 0,
      remainingCount: 1,
      errors: ['network suspended'],
    });
    expect(await service.listPendingNotifications()).toEqual([
      expect.objectContaining({
        kind: 'black-box',
        entryId: 'black-box-entry-3',
        blackBoxAction: 'complete',
        attemptCount: 1,
        lastError: 'network suspended',
      }),
    ]);
  });

  it('换号后 flush 丢弃其他 owner 的记录，不以当前 JWT 重放旧账号的通知', async () => {
    // partial-wipe / 直接切号路径不走 sign-out 全量擦除：owner 戳是最后一道防线
    await service.enqueueLatest({
      focusSessionId: 'focus-session-owner-a',
      focusActive: true,
      updatedAt: '2026-06-29T00:00:00.000Z',
      ownerUserId: 'owner-user-a',
    });
    await service.enqueueLatest({
      kind: 'black-box',
      entryId: 'black-box-entry-owner-b',
      blackBoxAction: 'complete',
      updatedAt: '2026-06-29T00:00:01.000Z',
      ownerUserId: 'owner-user-b',
    });
    const invoke = vi.fn().mockResolvedValue({ data: null, error: null });
    const client = {
      functions: { invoke },
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: { session: { user: { id: 'owner-user-b' } } },
        }),
      },
    } as unknown as DockDirectWidgetNotifyClient;

    const result = await service.flushPendingNotifications(client);

    // 只有 owner-b 的记录被发送；owner-a 的记录被丢弃而不是标失败重试
    expect(result).toEqual({
      ok: true,
      sentCount: 1,
      remainingCount: 0,
      errors: [],
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      'widget-notify',
      expect.objectContaining({
        body: expect.objectContaining({ entryId: 'black-box-entry-owner-b' }),
      }),
    );
    expect(await service.listPendingNotifications()).toEqual([]);
  });

  it('会话 owner 可解析时缺 owner 戳的升级前遗留记录按不可验证归属丢弃', async () => {
    await service.enqueueLatest({
      focusSessionId: 'focus-session-legacy',
      focusActive: true,
      updatedAt: '2026-06-29T00:00:00.000Z',
      ownerUserId: 'owner-user-a',
    });
    // 模拟升级前遗留：抹掉持久化记录上的 owner 戳
    const [stamped] = await service.listPendingNotifications();
    const legacyRecord = { ...stamped } as Record<string, unknown>;
    delete legacyRecord['ownerUserId'];
    const { set } = await import('idb-keyval');
    const { createStore } = await import('idb-keyval');
    await set(
      'focus-session-legacy',
      legacyRecord,
      createStore('nanoflow-dock-direct-widget-notify-outbox', 'pending-notifications'),
    );

    const invoke = vi.fn().mockResolvedValue({ data: null, error: null });
    const client = {
      functions: { invoke },
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: { session: { user: { id: 'owner-user-a' } } },
        }),
      },
    } as unknown as DockDirectWidgetNotifyClient;

    const result = await service.flushPendingNotifications(client);

    expect(result).toEqual({
      ok: true,
      sentCount: 0,
      remainingCount: 0,
      errors: [],
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(await service.listPendingNotifications()).toEqual([]);
  });

  it('会话 owner 解析不出来时不过滤（测试桩无 auth 成员的旧行为保持不变）', async () => {
    await service.enqueueLatest({
      focusSessionId: 'focus-session-no-auth',
      focusActive: true,
      updatedAt: '2026-06-29T00:00:00.000Z',
      ownerUserId: 'owner-user-a',
    });
    const invoke = vi.fn().mockResolvedValue({ data: null, error: null });
    const client = { functions: { invoke } } as unknown as DockDirectWidgetNotifyClient;

    const result = await service.flushPendingNotifications(client);

    expect(result.sentCount).toBe(1);
    expect(await service.listPendingNotifications()).toEqual([]);
  });
});
