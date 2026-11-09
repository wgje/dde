import { describe, expect, it, vi } from 'vitest';
import { addLifecycleBreadcrumb } from './app-lifecycle-breadcrumb.helpers';

describe('app lifecycle breadcrumb helpers', () => {
  it('isolates breadcrumb sink failures from lifecycle recovery logic', () => {
    const error = new Error('breadcrumb failed');
    const sentryLazyLoader = {
      addBreadcrumb: vi.fn(() => {
        throw error;
      }),
    };
    const warn = vi.fn();

    expect(() => addLifecycleBreadcrumb({
      sentryLazyLoader,
      logger: { warn },
      message: 'recovery.step',
      reason: 'visibility-quick',
      extra: { step: 'network-refresh' },
    })).not.toThrow();
    expect(warn).toHaveBeenCalledWith('Lifecycle breadcrumb failed', {
      message: 'recovery.step',
      reason: 'visibility-quick',
      error,
    });
  });
});
