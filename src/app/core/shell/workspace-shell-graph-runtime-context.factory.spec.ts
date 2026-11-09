import { Injector, runInInjectionContext } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import { LoggerService } from '../../../services/logger.service';
import {
  createWorkspaceShellGraphRuntimeContext,
} from './workspace-shell-graph-runtime-context.factory';

describe('createWorkspaceShellGraphRuntimeContext', () => {
  it('creates shell logger, warning sink, and runtime destroyed delegates', () => {
    const loggerCategory = { warn: vi.fn() };
    const loggerService = {
      category: vi.fn(() => loggerCategory),
    } as unknown as Pick<LoggerService, 'category'>;
    const injector = Injector.create({
      providers: [{ provide: LoggerService, useValue: loggerService }],
    });
    const error = new Error('runtime warning');

    const context = runInInjectionContext(
      injector,
      () => createWorkspaceShellGraphRuntimeContext(),
    );

    expect(context.logger).toBe(loggerCategory);
    expect(loggerService.category).toHaveBeenCalledWith('App');
    expect(context.runtime()).toBe(false);

    context.warn('runtime message', error);
    context.markDestroyed();

    expect(loggerCategory.warn).toHaveBeenCalledWith('runtime message', error);
    expect(context.runtime()).toBe(true);
  });
});
