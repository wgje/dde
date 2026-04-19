import { Injector, signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FocusStartupProbeService } from './focus-startup-probe.service';
import { AuthService } from './auth.service';
import { BlackBoxSyncService } from './black-box-sync.service';
import { GateService } from './gate.service';
import { LoggerService } from './logger.service';
import { gateState, resetFocusState } from '../state/focus-stores';

describe('FocusStartupProbeService', () => {
  const flushPromises = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };

  beforeEach(() => {
    resetFocusState();
  });

  it('应立即执行本地检查并更新待处理状态', async () => {
    const loadFromLocal = vi.fn().mockResolvedValue([]);
    const checkGate = vi.fn(() => gateState.set('reviewing'));
    const pullChanges = vi.fn();
    const userIdSignal = signal<string | null>('user-1');

    const injector = Injector.create({
      providers: [
        { provide: FocusStartupProbeService, useClass: FocusStartupProbeService },
        { provide: AuthService, useValue: { currentUserId: userIdSignal } },
        { provide: BlackBoxSyncService, useValue: { loadFromLocal, pullChanges } },
        { provide: GateService, useValue: { checkGate, state: gateState } },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              warn: vi.fn(),
              info: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
      ],
    });

    const service = injector.get(FocusStartupProbeService);
    service.initialize();
    await flushPromises();

    expect(loadFromLocal).toHaveBeenCalledTimes(1);
    expect(checkGate).toHaveBeenCalledTimes(1);
    expect(service.isProbeDone()).toBe(true);
    expect(service.hasPendingGateWork()).toBe(true);
    expect(pullChanges).not.toHaveBeenCalled();
  });

  it('无网络请求保证：探针不触发远端 pullChanges', async () => {
    const loadFromLocal = vi.fn().mockResolvedValue([]);
    const checkGate = vi.fn(() => gateState.set('bypassed'));
    const pullChanges = vi.fn();
    const userIdSignal = signal<string | null>('user-1');

    const injector = Injector.create({
      providers: [
        { provide: FocusStartupProbeService, useClass: FocusStartupProbeService },
        { provide: AuthService, useValue: { currentUserId: userIdSignal } },
        { provide: BlackBoxSyncService, useValue: { loadFromLocal, pullChanges } },
        { provide: GateService, useValue: { checkGate, state: gateState } },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              warn: vi.fn(),
              info: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
      ],
    });

    const service = injector.get(FocusStartupProbeService);
    service.initialize();
    await flushPromises();

    expect(pullChanges).not.toHaveBeenCalled();
    expect(service.hasPendingGateWork()).toBe(false);
  });

  it('相同用户重复 initialize 应保持结果信号稳定', async () => {
    const loadFromLocal = vi.fn().mockResolvedValue([]);
    const checkGate = vi.fn(() => gateState.set('bypassed'));
    const userIdSignal = signal<string | null>('user-1');

    const injector = Injector.create({
      providers: [
        { provide: FocusStartupProbeService, useClass: FocusStartupProbeService },
        { provide: AuthService, useValue: { currentUserId: userIdSignal } },
        { provide: BlackBoxSyncService, useValue: { loadFromLocal } },
        { provide: GateService, useValue: { checkGate, state: gateState } },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              warn: vi.fn(),
              info: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
      ],
    });

    const service = injector.get(FocusStartupProbeService);
    service.initialize();
    await flushPromises();
    service.initialize();
    await flushPromises();

    expect(loadFromLocal).toHaveBeenCalledTimes(1);
    expect(service.isProbeDone()).toBe(true);
    expect(service.hasPendingGateWork()).toBe(false);
  });

  it('resume-local 强制重探测时应绕过一次性初始化保护', async () => {
    const loadFromLocal = vi.fn().mockResolvedValue([]);
    const checkGate = vi.fn(() => gateState.set('reviewing'));
    const userIdSignal = signal<string | null>('user-1');

    const injector = Injector.create({
      providers: [
        { provide: FocusStartupProbeService, useClass: FocusStartupProbeService },
        { provide: AuthService, useValue: { currentUserId: userIdSignal } },
        { provide: BlackBoxSyncService, useValue: { loadFromLocal } },
        { provide: GateService, useValue: { checkGate, state: gateState } },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              warn: vi.fn(),
              info: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
      ],
    });

    const service = injector.get(FocusStartupProbeService);
    service.initialize();
    await flushPromises();

    await service.recheckGate({ source: 'resume-local' });

    expect(loadFromLocal).toHaveBeenCalledTimes(2);
    expect(checkGate).toHaveBeenCalledTimes(2);
    expect(service.hasPendingGateWork()).toBe(true);
  });

  it('resume-remote 重探测应直接复核 gate 而不重复读取本地缓存', async () => {
    const loadFromLocal = vi.fn().mockResolvedValue([]);
    const checkGate = vi.fn(() => gateState.set('reviewing'));
    const userIdSignal = signal<string | null>('user-1');

    const injector = Injector.create({
      providers: [
        { provide: FocusStartupProbeService, useClass: FocusStartupProbeService },
        { provide: AuthService, useValue: { currentUserId: userIdSignal } },
        { provide: BlackBoxSyncService, useValue: { loadFromLocal } },
        { provide: GateService, useValue: { checkGate, state: gateState } },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              warn: vi.fn(),
              info: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
      ],
    });

    const service = injector.get(FocusStartupProbeService);
    await service.recheckGate({ source: 'resume-remote', reloadLocal: false });

    expect(loadFromLocal).not.toHaveBeenCalled();
    expect(checkGate).toHaveBeenCalledTimes(1);
    expect(service.hasPendingGateWork()).toBe(true);
  });

  it('恢复时 auth 信号短暂为空，force recheck 仍应沿用已初始化用户完成 gate 复核', async () => {
    const loadFromLocal = vi.fn().mockResolvedValue([]);
    const checkGate = vi.fn(() => gateState.set('reviewing'));
    const userIdSignal = signal<string | null>('user-1');

    const injector = Injector.create({
      providers: [
        { provide: FocusStartupProbeService, useClass: FocusStartupProbeService },
        { provide: AuthService, useValue: { currentUserId: userIdSignal } },
        { provide: BlackBoxSyncService, useValue: { loadFromLocal } },
        { provide: GateService, useValue: { checkGate, state: gateState } },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              warn: vi.fn(),
              info: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
      ],
    });

    const service = injector.get(FocusStartupProbeService);
    service.initialize();
    await flushPromises();

    userIdSignal.set(null);
    await service.recheckGate({ source: 'resume-local' });

    expect(loadFromLocal).toHaveBeenCalledTimes(2);
    expect(checkGate).toHaveBeenCalledTimes(2);
    expect(service.hasPendingGateWork()).toBe(true);
  });

  it('首次恢复时若 currentUserId 尚未回填，应回退到持久化 session hint 完成 gate 复核', async () => {
    const loadFromLocal = vi.fn().mockResolvedValue([]);
    const checkGate = vi.fn(() => gateState.set('reviewing'));
    const userIdSignal = signal<string | null>(null);

    const injector = Injector.create({
      providers: [
        { provide: FocusStartupProbeService, useClass: FocusStartupProbeService },
        {
          provide: AuthService,
          useValue: {
            currentUserId: userIdSignal,
            peekPersistedSessionIdentity: () => ({ userId: 'user-1' }),
            peekPersistedOwnerHint: () => 'user-1',
          },
        },
        { provide: BlackBoxSyncService, useValue: { loadFromLocal } },
        { provide: GateService, useValue: { checkGate, state: gateState } },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              warn: vi.fn(),
              info: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
      ],
    });

    const service = injector.get(FocusStartupProbeService);
    await service.recheckGate({ source: 'resume-local' });

    expect(loadFromLocal).toHaveBeenCalledTimes(1);
    expect(checkGate).toHaveBeenCalledTimes(1);
    expect(service.hasPendingGateWork()).toBe(true);
  });
});
