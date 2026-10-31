import type { Injector } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import type { AttachmentService } from './attachment.service';
import { UserSessionAttachmentLazyLoader } from './user-session-attachment-lazy-loader';

function createHarness() {
  const attachmentService = {
    onUserLogin: vi.fn(),
    clearUrlRefreshCallback: vi.fn(),
    clearMonitoredAttachments: vi.fn(),
  } as unknown as AttachmentService;
  const injector = {
    get: vi.fn(() => attachmentService),
  } as unknown as Injector;
  const loadService = vi.fn(async () => attachmentService);
  const warn = vi.fn();
  const loader = new UserSessionAttachmentLazyLoader({
    injector,
    isDestroyed: () => false,
    warn,
    loadService,
  });

  return { attachmentService, injector, loadService, loader, warn };
}

describe('UserSessionAttachmentLazyLoader', () => {
  it('arms attachment URL monitoring before returning a newly loaded service', async () => {
    const { attachmentService, loader } = createHarness();

    await expect(loader.get()).resolves.toBe(attachmentService);

    expect(attachmentService.onUserLogin).toHaveBeenCalledTimes(1);
  });

  it('re-arms the cached service when a later authenticated session requests it', async () => {
    const { attachmentService, injector, loadService, loader } = createHarness();
    await loader.get();
    vi.mocked(attachmentService.onUserLogin).mockClear();

    await expect(loader.get()).resolves.toBe(attachmentService);

    expect(loadService).toHaveBeenCalledTimes(1);
    expect(injector.get).not.toHaveBeenCalled();
    expect(attachmentService.onUserLogin).toHaveBeenCalledTimes(1);
  });

  it('keeps the attachment service available when monitor re-arming throws', async () => {
    const { attachmentService, loader, warn } = createHarness();
    const restartError = new Error('timer unavailable');
    vi.mocked(attachmentService.onUserLogin).mockImplementation(() => {
      throw restartError;
    });

    await expect(loader.get()).resolves.toBe(attachmentService);

    expect(warn).toHaveBeenCalledWith(
      'AttachmentService URL 刷新监控恢复失败，继续提供附件能力',
      restartError,
    );
  });
});
