import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { LoggerService } from './logger.service';
import { PARKING_CONFIG } from '../config/parking.config';
import { IntervalHandle } from '../utils/timer-handle';

interface FocusDockLease {
  tabId: string;
  expiresAt: number;
  updatedAt: number;
}

interface FocusDockChannelMessage {
  type: 'lease-updated' | 'takeover-request';
  tabId: string;
  sentAt: number;
}

@Injectable({
  providedIn: 'root',
})
export class FocusDockLeaderService implements OnDestroy {
  private readonly logger = inject(LoggerService).category('FocusDockLeader');
  private readonly tabId = crypto.randomUUID();
  private readonly nowTick = signal(Date.now());
  private readonly activeLeaderTabId = signal<string | null>(null);
  private readonly leaseExpiresAt = signal(0);
  private readonly leaderState = signal(false);
  private channel: BroadcastChannel | null = null;
  private readonly heartbeatTimer = new IntervalHandle();
  private storageListener: ((event: StorageEvent) => void) | null = null;
  private destroyed = false;

  readonly isLeader = computed(() => this.leaderState());
  readonly isFollower = computed(() => !this.leaderState());
  readonly leaderTabId = computed(() => this.activeLeaderTabId());
  readonly isReadOnlyFollower = computed(() => {
    this.nowTick();
    return this.isFollower() && this.activeLeaderTabId() !== null && this.leaseExpiresAt() > Date.now();
  });

  constructor() {
    if (!PARKING_CONFIG.FOCUS_CONSOLE_V2_ENABLED) {
      this.leaderState.set(true);
      this.activeLeaderTabId.set(this.tabId);
      return;
    }

    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel(PARKING_CONFIG.FOCUS_CONSOLE_LEADER_CHANNEL);
        this.channel.onmessage = event => this.handleChannelMessage(event.data);
      } catch (error) {
        this.logger.warn('FocusDockLeader BroadcastChannel unavailable', error);
      }
    }

    if (typeof window !== 'undefined') {
      this.storageListener = event => {
        if (event.key !== PARKING_CONFIG.FOCUS_CONSOLE_LEADER_LEASE_KEY) return;
        this.refreshLeaseState();
      };
      window.addEventListener('storage', this.storageListener);
    }

    this.refreshLeaseState();
    this.startHeartbeat();
  }

  ngOnDestroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.heartbeatTimer.stop();
    this.releaseOwnedLease();
    this.leaderState.set(false);
    this.activeLeaderTabId.set(null);
    this.leaseExpiresAt.set(0);
    const channel = this.channel;
    this.channel = null;
    if (channel) {
      try {
        channel.close();
      } catch (error) {
        this.warnCleanupFailure('FocusDockLeader channel cleanup failed', error);
      }
    }

    const storageListener = this.storageListener;
    this.storageListener = null;
    if (storageListener && typeof window !== 'undefined') {
      try {
        window.removeEventListener('storage', storageListener);
      } catch (error) {
        this.warnCleanupFailure('FocusDockLeader storage listener cleanup failed', error);
      }
    }
  }

  private releaseOwnedLease(): void {
    const lease = this.readLease();
    if (lease?.tabId !== this.tabId || typeof localStorage === 'undefined') {
      return;
    }

    try {
      localStorage.removeItem(PARKING_CONFIG.FOCUS_CONSOLE_LEADER_LEASE_KEY);
    } catch (error) {
      this.warnCleanupFailure('FocusDockLeader lease cleanup failed', error);
    }
  }

  private warnCleanupFailure(message: string, error: unknown): void {
    try {
      this.logger.warn(message, error);
    } catch {
      // Cleanup warning sinks must not interrupt leader teardown.
    }
  }

  tryTakeover(): boolean {
    if (this.destroyed) {
      return false;
    }

    const lease: FocusDockLease = {
      tabId: this.tabId,
      updatedAt: Date.now(),
      expiresAt: Date.now() + PARKING_CONFIG.FOCUS_CONSOLE_LEASE_MS,
    };
    if (!this.writeLease(lease) || !this.isStoredLease(lease)) {
      this.applyObservedLeaseState(Date.now());
      return false;
    }
    this.broadcast('takeover-request');
    this.refreshLeaseState();
    return this.isLeader();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer.active) return;
    this.heartbeatTimer.start(() => {
      this.nowTick.set(Date.now());
      this.refreshLeaseState();
      if (this.isLeader()) {
        this.broadcast('lease-updated');
      }
    }, PARKING_CONFIG.FOCUS_CONSOLE_HEARTBEAT_MS);
  }

  private handleChannelMessage(raw: unknown): void {
    if (this.destroyed) return;
    if (!raw || typeof raw !== 'object') return;
    const message = raw as Partial<FocusDockChannelMessage>;
    if (!message.type || !message.tabId) return;
    if (message.tabId === this.tabId) return;

    if (message.type === 'lease-updated' || message.type === 'takeover-request') {
      this.refreshLeaseState();
    }
  }

  private refreshLeaseState(): void {
    if (this.destroyed) return;
    const now = Date.now();
    const lease = this.readLease();

    if (!lease || lease.expiresAt <= now) {
      const nextLease: FocusDockLease = {
        tabId: this.tabId,
        updatedAt: now,
        expiresAt: now + PARKING_CONFIG.FOCUS_CONSOLE_LEASE_MS,
      };
      if (!this.writeLease(nextLease) || !this.isStoredLease(nextLease)) {
        this.applyObservedLeaseState(now);
        return;
      }
      this.leaderState.set(true);
      this.activeLeaderTabId.set(this.tabId);
      this.leaseExpiresAt.set(nextLease.expiresAt);
      return;
    }

    if (lease.tabId === this.tabId) {
      const renewedLease: FocusDockLease = {
        ...lease,
        updatedAt: now,
        expiresAt: now + PARKING_CONFIG.FOCUS_CONSOLE_LEASE_MS,
      };
      if (!this.writeLease(renewedLease)) {
        this.leaderState.set(true);
        this.activeLeaderTabId.set(this.tabId);
        this.leaseExpiresAt.set(lease.expiresAt);
        return;
      }
      if (!this.isStoredLease(renewedLease)) {
        this.applyObservedLeaseState(now);
        return;
      }
      this.leaderState.set(true);
      this.activeLeaderTabId.set(this.tabId);
      this.leaseExpiresAt.set(renewedLease.expiresAt);
      return;
    }

    this.leaderState.set(false);
    this.activeLeaderTabId.set(lease.tabId);
    this.leaseExpiresAt.set(lease.expiresAt);

    // 租约已过期加上容忍窗口仍无心跳 → 原 Leader 已死，接管
    const staleDeadline = lease.updatedAt + PARKING_CONFIG.FOCUS_CONSOLE_LEASE_MS + PARKING_CONFIG.FOCUS_CONSOLE_FOLLOWER_STALE_MS;
    if (staleDeadline < now) {
      this.tryTakeover();
    }
  }

  private applyObservedLeaseState(now: number): void {
    const lease = this.readLease();
    if (lease && lease.expiresAt > now) {
      this.leaderState.set(lease.tabId === this.tabId);
      this.activeLeaderTabId.set(lease.tabId);
      this.leaseExpiresAt.set(lease.expiresAt);
      return;
    }

    this.leaderState.set(false);
    this.activeLeaderTabId.set(null);
    this.leaseExpiresAt.set(0);
  }

  private isStoredLease(expected: FocusDockLease): boolean {
    const lease = this.readLease();
    return lease?.tabId === expected.tabId &&
      lease.expiresAt === expected.expiresAt &&
      lease.updatedAt === expected.updatedAt;
  }

  private readLease(): FocusDockLease | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(PARKING_CONFIG.FOCUS_CONSOLE_LEADER_LEASE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<FocusDockLease>;
      if (
        typeof parsed.tabId !== 'string' ||
        !Number.isFinite(parsed.expiresAt) ||
        !Number.isFinite(parsed.updatedAt)
      ) {
        return null;
      }
      return {
        tabId: parsed.tabId,
        expiresAt: Number(parsed.expiresAt),
        updatedAt: Number(parsed.updatedAt),
      };
    } catch {
      // eslint-disable-next-line no-restricted-syntax -- localStorage 解析失败时安全降级
      return null;
    }
  }

  private writeLease(lease: FocusDockLease): boolean {
    if (typeof localStorage === 'undefined') return false;
    try {
      localStorage.setItem(PARKING_CONFIG.FOCUS_CONSOLE_LEADER_LEASE_KEY, JSON.stringify(lease));
      return true;
    } catch (error) {
      this.logger.warn('FocusDockLeader write lease failed', error);
      return false;
    }
  }

  private broadcast(type: FocusDockChannelMessage['type']): void {
    if (!this.channel) return;
    try {
      this.channel.postMessage({
        type,
        tabId: this.tabId,
        sentAt: Date.now(),
      } satisfies FocusDockChannelMessage);
    } catch (error) {
      this.logger.warn('FocusDockLeader broadcast failed', error);
    }
  }
}
