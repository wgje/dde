import type { Injector } from '@angular/core';

import type { AttachmentService } from './attachment.service';

export interface UserSessionAttachmentLazyLoaderOptions {
  injector: Injector;
  isDestroyed(): boolean;
  warn(message: string, error: unknown): void;
  loadService?: () => Promise<AttachmentService>;
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
      this.armServiceMonitoring(this.attachmentServiceRef);
      return this.attachmentServiceRef;
    }

    if (this.attachmentServicePromise) {
      return this.attachmentServicePromise;
    }

    const servicePromise = this.loadService()
      .then((service) => {
        if (this.options.isDestroyed()) {
          this.clearDestroyedService(service);
          return null;
        }
        this.armServiceMonitoring(service);
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

  private armServiceMonitoring(service: AttachmentService): void {
    try {
      service.onUserLogin();
    } catch (error) {
      this.options.warn(
        'AttachmentService URL 刷新监控恢复失败，继续提供附件能力',
        error,
      );
    }
  }

  private loadService(): Promise<AttachmentService> {
    if (this.options.loadService) {
      return this.options.loadService();
    }

    return import('./attachment.service')
      .then(module => this.options.injector.get(module.AttachmentService));
  }

  private clearDestroyedService(service: AttachmentService | null): void {
    if (!service || this.destroyedAttachmentServices.has(service)) return;

    this.destroyedAttachmentServices.add(service);
    service.clearUrlRefreshCallback();
    service.clearMonitoredAttachments();
  }
}
