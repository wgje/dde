import type { Injector } from '@angular/core';

import type { AttachmentService } from './attachment.service';

export interface UserSessionAttachmentLazyLoaderOptions {
  injector: Injector;
  isDestroyed(): boolean;
  warn(message: string, error: unknown): void;
}

export class UserSessionAttachmentLazyLoader {
  private attachmentServiceRef: AttachmentService | null = null;
  private attachmentServicePromise: Promise<AttachmentService | null> | null = null;
  private readonly destroyedAttachmentServices = new WeakSet<AttachmentService>();

  constructor(private readonly options: UserSessionAttachmentLazyLoaderOptions) {}

  destroy(): void {
    const loadedService = this.attachmentServiceRef;
    if (loadedService) {
      this.clearDestroyedService(loadedService);
      this.attachmentServiceRef = null;
      return;
    }

    const pendingService = this.attachmentServicePromise;
    if (!pendingService) return;

    void pendingService
      .then((service) => {
        this.clearDestroyedService(service);
      })
      .catch(() => {
        // 销毁阶段静默忽略
      });
  }

  async get(): Promise<AttachmentService | null> {
    if (this.options.isDestroyed()) {
      return null;
    }

    if (this.attachmentServiceRef) {
      return this.attachmentServiceRef;
    }

    if (this.attachmentServicePromise) {
      return this.attachmentServicePromise;
    }

    const servicePromise = import('./attachment.service')
      .then((module) => {
        const service = this.options.injector.get(module.AttachmentService);
        if (this.options.isDestroyed()) {
          this.clearDestroyedService(service);
          return null;
        }
        this.attachmentServiceRef = service;
        return service;
      })
      .catch((error) => {
        this.options.warn('AttachmentService 懒加载失败，降级为无附件监控', error);
        return null;
      })
      .finally(() => {
        if (this.attachmentServicePromise === servicePromise) {
          this.attachmentServicePromise = null;
        }
      });

    this.attachmentServicePromise = servicePromise;

    return this.attachmentServicePromise;
  }

  clearLoadedMonitoring(): void {
    this.attachmentServiceRef?.clearMonitoredAttachments();
  }

  private clearDestroyedService(service: AttachmentService | null): void {
    if (!service || this.destroyedAttachmentServices.has(service)) return;

    this.destroyedAttachmentServices.add(service);
    service.clearUrlRefreshCallback();
    service.clearMonitoredAttachments();
  }
}
