import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';

import { LoggerService } from './logger.service';
import { SessionRuntimeResetRegistry } from './session-runtime-reset.service';

describe('SessionRuntimeResetRegistry', () => {
  const logger = {
    warn: vi.fn(),
  };

  beforeEach(() => {
    logger.warn.mockReset();
    TestBed.configureTestingModule({
      providers: [
        SessionRuntimeResetRegistry,
        { provide: LoggerService, useValue: logger },
      ],
    });
  });

  it('每次 resetAll 都调用仍在注册的回调', () => {
    const registry = TestBed.inject(SessionRuntimeResetRegistry);
    const reset = vi.fn();
    registry.register('runtime-a', reset);

    const ownerChange = registry.resetAll('owner-change');
    const clearLocalData = registry.resetAll('clear-local-data');

    expect(reset).toHaveBeenNthCalledWith(1, 'owner-change');
    expect(reset).toHaveBeenNthCalledWith(2, 'clear-local-data');
    expect(ownerChange).toEqual({
      ok: true,
      reason: 'owner-change',
      attemptedOwners: ['runtime-a'],
      failures: [],
    });
    expect(clearLocalData).toEqual({
      ok: true,
      reason: 'clear-local-data',
      attemptedOwners: ['runtime-a'],
      failures: [],
    });
  });

  it('注销后不再调用对应回调', () => {
    const registry = TestBed.inject(SessionRuntimeResetRegistry);
    const reset = vi.fn();
    const unregister = registry.register('runtime-a', reset);

    unregister();
    unregister();
    registry.resetAll('owner-change');

    expect(reset).not.toHaveBeenCalled();
  });

  it('单个回调抛错时隔离异常并继续重置其他运行时', () => {
    const registry = TestBed.inject(SessionRuntimeResetRegistry);
    const resetError = new Error('reset failed');
    const laterReset = vi.fn();
    registry.register('broken-runtime', () => {
      throw resetError;
    });
    registry.register('healthy-runtime', laterReset);

    const result = registry.resetAll('owner-change');

    expect(laterReset).toHaveBeenCalledWith('owner-change');
    expect(result).toEqual({
      ok: false,
      reason: 'owner-change',
      attemptedOwners: ['broken-runtime', 'healthy-runtime'],
      failures: [{ owner: 'broken-runtime', error: resetError }],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'SessionRuntimeResetRegistry',
      '会话运行时重置失败，继续处理其他运行时',
      expect.objectContaining({ owner: 'broken-runtime', reason: 'owner-change' }),
    );
  });
});
