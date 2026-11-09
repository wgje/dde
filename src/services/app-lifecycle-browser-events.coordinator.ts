import { Injectable, inject } from '@angular/core';
import { APP_LIFECYCLE_CONFIG } from '../config/app-lifecycle.config';
import { readRuntimePlatformSnapshot } from '../utils/runtime-platform';
import { RealtimePollingService } from '../core-bridge';
import { LoggerService } from './logger.service';
import {
  selectHigherPriorityResumeReason,
  shouldQueueResumeAfterCurrent,
} from './app-lifecycle-resume-queue.helpers';
import type { AppResumeReason } from './app-lifecycle-orchestrator.service';

@Injectable({ providedIn: 'root' })
export class AppLifecycleBrowserEventsCoordinator {
  private readonly logger = inject(LoggerService).category('LifecycleOrchestrator');
  private readonly realtimePolling = inject(RealtimePollingService);

  private initialized = false;
  private hiddenAt: number | null = null;
  private lastBackgroundDurationMs = 0;
  private triggerResume: ((reason: AppResumeReason) => void) | null = null;
  private lifecycleGeneration = 0;
  private capturedWindow: Pick<Window, 'addEventListener' | 'removeEventListener'> | null = null;
  private capturedDocument: Pick<Document, 'addEventListener' | 'removeEventListener'> | null = null;
  private readonly pendingResumeReasons = new Set<AppResumeReason>();

  private readonly visibilityHandler = () => this.handleVisibilityChange();
  private readonly blurHandler = () => this.handleWindowBlur();
  private readonly focusHandler = () => this.handleWindowFocus();
  private readonly pageshowHandler = (event: PageTransitionEvent) => this.handlePageShow(event);
  private readonly onlineHandler = () => this.handleWindowOnline();

  initialize(triggerResume: (reason: AppResumeReason) => void): boolean {
    if (this.initialized || typeof window === 'undefined' || typeof document === 'undefined') {
      return false;
    }

    const cleanupRegisteredListeners: Array<() => void> = [];
    this.triggerResume = triggerResume;
    this.lifecycleGeneration += 1;
    this.capturedWindow = window;
    this.capturedDocument = document;

    try {
      this.capturedDocument.addEventListener('visibilitychange', this.visibilityHandler);
      cleanupRegisteredListeners.push(() =>
        this.capturedDocument!.removeEventListener('visibilitychange', this.visibilityHandler));
      this.capturedWindow.addEventListener('blur', this.blurHandler);
      cleanupRegisteredListeners.push(() => this.capturedWindow!.removeEventListener('blur', this.blurHandler));
      this.capturedWindow.addEventListener('focus', this.focusHandler);
      cleanupRegisteredListeners.push(() => this.capturedWindow!.removeEventListener('focus', this.focusHandler));
      this.capturedWindow.addEventListener('pageshow', this.pageshowHandler as EventListener);
      cleanupRegisteredListeners.push(() =>
        this.capturedWindow!.removeEventListener('pageshow', this.pageshowHandler as EventListener));
      this.capturedWindow.addEventListener('online', this.onlineHandler);
      cleanupRegisteredListeners.push(() => this.capturedWindow!.removeEventListener('online', this.onlineHandler));
      this.initialized = true;
      this.infoSafely('Lifecycle orchestrator initialized');
      return true;
    } catch (error) {
      for (const cleanup of cleanupRegisteredListeners.reverse()) {
        this.removeBrowserListener(cleanup);
      }
      this.triggerResume = null;
      this.initialized = false;
      this.capturedWindow = null;
      this.capturedDocument = null;
      this.lifecycleGeneration += 1;
      throw error;
    }
  }

  cleanup(): void {
    if (this.capturedDocument && this.capturedWindow) {
      this.removeBrowserListener(() =>
        this.capturedDocument!.removeEventListener('visibilitychange', this.visibilityHandler));
      this.removeBrowserListener(() => this.capturedWindow!.removeEventListener('blur', this.blurHandler));
      this.removeBrowserListener(() => this.capturedWindow!.removeEventListener('focus', this.focusHandler));
      this.removeBrowserListener(() =>
        this.capturedWindow!.removeEventListener('pageshow', this.pageshowHandler as EventListener));
      this.removeBrowserListener(() => this.capturedWindow!.removeEventListener('online', this.onlineHandler));
    }
    this.hiddenAt = null;
    this.lastBackgroundDurationMs = 0;
    this.triggerResume = null;
    this.pendingResumeReasons.clear();
    this.initialized = false;
    this.capturedWindow = null;
    this.capturedDocument = null;
    this.lifecycleGeneration += 1;
  }

  getLastBackgroundDurationMs(): number {
    return this.lastBackgroundDurationMs;
  }

  private handleVisibilityChange(): void {
    if (!this.isActive()) return;
    if (document.visibilityState === 'hidden') {
      this.markWindowHidden();
      return;
    }
    if (document.visibilityState === 'visible' && this.hiddenAt) {
      this.resumeFromHiddenDuration();
    }
  }

  private handleWindowBlur(): void {
    if (!this.isActive()) return;
    if (!this.shouldUseWindowFocusResumeFallback() || this.hiddenAt !== null) return;
    this.markWindowHidden();
  }

  private handleWindowFocus(): void {
    if (!this.isActive()) return;
    if (document.visibilityState === 'hidden' || !this.hiddenAt) return;
    this.resumeFromHiddenDuration();
  }

  private handlePageShow(event: PageTransitionEvent): void {
    if (!this.isActive()) return;
    if (!event.persisted) return;
    if (document.visibilityState === 'hidden') return;
    const duration = this.hiddenAt !== null ? Date.now() - this.hiddenAt : 0;
    this.hiddenAt = null;
    this.lastBackgroundDurationMs = Math.max(duration, APP_LIFECYCLE_CONFIG.RESUME_THRESHOLD_MS);
    this.triggerResumeSafely('pageshow');
  }

  private handleWindowOnline(): void {
    if (!this.isActive()) return;
    if (document.visibilityState === 'hidden' || this.hiddenAt !== null) return;
    this.triggerResumeSafely('online');
  }

  private markWindowHidden(): void {
    if (this.hiddenAt !== null) {
      return;
    }

    this.hiddenAt = Date.now();
    const generation = this.lifecycleGeneration;
    let suspendTransport: Promise<void>;
    try {
      suspendTransport = Promise.resolve(this.realtimePolling.suspendTransport());
    } catch (error) {
      suspendTransport = Promise.reject(error);
    }

    void suspendTransport.catch(error => {
      if (!this.initialized || generation !== this.lifecycleGeneration) {
        return;
      }
      this.warnSafely('Lifecycle transport suspension failed', { error });
    });
  }

  private resumeFromHiddenDuration(): void {
    const duration = Date.now() - this.hiddenAt!;
    this.hiddenAt = null;
    this.lastBackgroundDurationMs = duration;
    this.triggerResumeSafely(this.getVisibilityResumeReason(duration));
  }

  private getVisibilityResumeReason(duration: number): AppResumeReason {
    return duration >= APP_LIFECYCLE_CONFIG.RESUME_THRESHOLD_MS
      ? 'visibility-threshold'
      : 'visibility-quick';
  }

  private shouldUseWindowFocusResumeFallback(): boolean {
    const platform = readRuntimePlatformSnapshot();
    return platform.isAndroid || platform.os === 'ios' || platform.isStandalone;
  }

  private isActive(): boolean {
    return this.initialized && this.triggerResume !== null;
  }

  private triggerResumeSafely(reason: AppResumeReason): void {
    const triggerResume = this.triggerResume;
    if (!triggerResume) {
      return;
    }
    const highestPendingReason = this.getHighestPendingResumeReason();
    if (highestPendingReason && !shouldQueueResumeAfterCurrent(highestPendingReason, reason)) {
      return;
    }

    const generation = this.lifecycleGeneration;
    this.pendingResumeReasons.add(reason);
    try {
      const result = triggerResume(reason);
      void Promise.resolve(result)
        .catch(error => {
          if (!this.initialized || generation !== this.lifecycleGeneration) {
            return;
          }
          this.warnSafely('Lifecycle resume trigger failed', { reason, error });
        })
        .finally(() => {
          if (generation === this.lifecycleGeneration) {
            this.pendingResumeReasons.delete(reason);
          }
        });
    } catch (error) {
      this.pendingResumeReasons.delete(reason);
      this.warnSafely('Lifecycle resume trigger failed', { reason, error });
    }
  }

  private getHighestPendingResumeReason(): AppResumeReason | null {
    let highestReason: AppResumeReason | null = null;
    for (const reason of this.pendingResumeReasons) {
      highestReason = selectHigherPriorityResumeReason(highestReason, reason);
    }
    return highestReason;
  }

  private removeBrowserListener(removeListener: () => void): void {
    try {
      removeListener();
    } catch (error) {
      this.warnSafely('Lifecycle browser listener cleanup failed', { error });
    }
  }

  private infoSafely(message: string): void {
    try {
      this.logger.info(message);
    } catch {
      // Diagnostic sinks must not interrupt lifecycle initialization.
    }
  }

  private warnSafely(message: string, context: Record<string, unknown>): void {
    try {
      this.logger.warn(message, context);
    } catch {
      // Diagnostic sinks must not interrupt lifecycle cleanup or resume recovery.
    }
  }
}
