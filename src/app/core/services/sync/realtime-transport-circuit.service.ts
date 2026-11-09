import { Injectable, inject } from '@angular/core';

import { MOBILE_SYNC_CONFIG } from '../../../../config';
import { ToastService } from '../../../../services/toast.service';

const REALTIME_CIRCUIT_STORAGE_KEY = 'nanoflow.realtime-transport-circuit';
const REALTIME_CIRCUIT_TTL_MS = 30 * 60 * 1000;
const REALTIME_FALLBACK_TOAST_COOLDOWN_MS = 10 * 60 * 1000;

@Injectable({ providedIn: 'root' })
export class RealtimeTransportCircuitService {
  private readonly toast = inject(ToastService);

  private realtimeBackoffProjectId: string | null = null;
  private realtimeBackoffUntil = 0;
  private realtimeCircuitUntil = 0;
  private realtimeCircuitOwnerUserId: string | null = null;
  private realtimeCircuitFailures = 0;
  private realtimeCircuitLastError: string | null = null;
  private lastRealtimeFallbackToastAt = 0;

  loadState(): void {
    if (typeof window === 'undefined' || typeof window.sessionStorage === 'undefined') return;

    try {
      const stored = window.sessionStorage.getItem(REALTIME_CIRCUIT_STORAGE_KEY);
      if (!stored) return;

      const parsed = JSON.parse(stored) as {
        until?: number;
        ownerUserId?: string | null;
        failures?: number;
        lastError?: string | null;
        lastToastAt?: number;
      };

      if (typeof parsed.until !== 'number' || parsed.until <= Date.now()) {
        window.sessionStorage.removeItem(REALTIME_CIRCUIT_STORAGE_KEY);
        return;
      }

      this.realtimeCircuitUntil = parsed.until;
      this.realtimeCircuitOwnerUserId = typeof parsed.ownerUserId === 'string' ? parsed.ownerUserId : null;
      this.realtimeCircuitFailures = typeof parsed.failures === 'number' ? parsed.failures : 0;
      this.realtimeCircuitLastError = typeof parsed.lastError === 'string' ? parsed.lastError : null;
      this.lastRealtimeFallbackToastAt = typeof parsed.lastToastAt === 'number' ? parsed.lastToastAt : 0;
    } catch {
      // 存储损坏时静默回退到默认状态即可。
    }
  }

  remainingBackoffMs(projectId: string): number {
    if (this.realtimeBackoffProjectId !== projectId) return 0;
    return Math.max(0, this.realtimeBackoffUntil - Date.now());
  }

  armBackoff(projectId: string): number {
    const backoffMs = MOBILE_SYNC_CONFIG.MEDIUM_QUALITY_SYNC_DELAY;
    this.realtimeBackoffProjectId = projectId;
    this.realtimeBackoffUntil = Date.now() + backoffMs;
    return backoffMs;
  }

  clearBackoff(projectId?: string): void {
    if (projectId && this.realtimeBackoffProjectId !== projectId) return;
    this.realtimeBackoffProjectId = null;
    this.realtimeBackoffUntil = 0;
  }

  remainingCircuitMs(): number {
    const remainingMs = this.realtimeCircuitUntil - Date.now();
    if (remainingMs > 0) return remainingMs;

    if (this.hasCircuitState()) {
      this.clearCircuit();
    }
    return 0;
  }

  ensureUserScope(userId: string): void {
    if (!this.realtimeCircuitOwnerUserId || this.realtimeCircuitOwnerUserId === userId) return;
    this.clearCircuit();
  }

  armCircuit(userId: string, errorMessage: string | undefined, consecutiveErrors: number): number {
    const now = Date.now();
    this.realtimeCircuitUntil = Math.max(this.realtimeCircuitUntil, now + REALTIME_CIRCUIT_TTL_MS);
    this.realtimeCircuitOwnerUserId = userId;
    this.realtimeCircuitFailures = Math.max(this.realtimeCircuitFailures, consecutiveErrors);
    this.realtimeCircuitLastError = errorMessage ?? null;
    this.saveState();
    return this.realtimeCircuitUntil - now;
  }

  clearCircuit(): void {
    this.realtimeCircuitUntil = 0;
    this.realtimeCircuitOwnerUserId = null;
    this.realtimeCircuitFailures = 0;
    this.realtimeCircuitLastError = null;
    this.lastRealtimeFallbackToastAt = 0;

    if (typeof window === 'undefined' || typeof window.sessionStorage === 'undefined') return;

    try {
      window.sessionStorage.removeItem(REALTIME_CIRCUIT_STORAGE_KEY);
    } catch {
      // 清理失败不影响后续轮询回退。
    }
  }

  hasCircuitState(): boolean {
    return this.realtimeCircuitUntil > 0
      || this.realtimeCircuitFailures > 0
      || this.realtimeCircuitLastError !== null;
  }

  hasActiveBackoff(): boolean {
    return this.realtimeBackoffUntil > Date.now();
  }

  readonly snapshot = () => ({
    failures: this.realtimeCircuitFailures,
    lastError: this.realtimeCircuitLastError,
  });

  notifyFallback(): void {
    const now = Date.now();
    if (now - this.lastRealtimeFallbackToastAt < REALTIME_FALLBACK_TOAST_COOLDOWN_MS) return;

    this.lastRealtimeFallbackToastAt = now;
    this.saveState();
    this.toast.info('实时同步暂不可用', '已切换到定时同步模式');
  }

  private saveState(): void {
    if (typeof window === 'undefined' || typeof window.sessionStorage === 'undefined') return;

    try {
      window.sessionStorage.setItem(REALTIME_CIRCUIT_STORAGE_KEY, JSON.stringify({
        until: this.realtimeCircuitUntil,
        ownerUserId: this.realtimeCircuitOwnerUserId,
        failures: this.realtimeCircuitFailures,
        lastError: this.realtimeCircuitLastError,
        lastToastAt: this.lastRealtimeFallbackToastAt,
      }));
    } catch {
      // sessionStorage 不可写时保持内存态熔断即可。
    }
  }
}
