import { Injectable, inject } from '@angular/core';
import { LoggerService } from './logger.service';

interface NavigatorBadgeApi {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

interface FocusNotificationOptions {
  body: string;
  tag: string;
  title: string;
}

@Injectable({
  providedIn: 'root',
})
export class FocusAttentionService {
  private readonly logger = inject(LoggerService).category('FocusAttention');

  updateBadge(count: number): void {
    if (typeof navigator === 'undefined') return;

    const badgeNavigator = navigator as unknown as NavigatorBadgeApi;
    const normalizedCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    const operation = normalizedCount > 0
      ? badgeNavigator.setAppBadge?.(normalizedCount)
      : badgeNavigator.clearAppBadge?.();

    if (!operation) return;
    void operation.catch(error => {
      this.logger.debug('更新 Badge 失败', error);
    });
  }

  async notify(options: FocusNotificationOptions): Promise<void> {
    if (typeof window === 'undefined' || typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;

    try {
      if (navigator.serviceWorker?.ready) {
        const registration = await navigator.serviceWorker.ready;
        await registration.showNotification(options.title, {
          body: options.body,
          tag: options.tag,
          renotify: true,
        } as NotificationOptions);
        return;
      }
    } catch (error) {
      this.logger.warn('通过 Service Worker 发送专注通知失败', error);
    }
  }
}
