import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { LoggerService } from './logger.service';
import { PARKING_CONFIG } from '../config/parking.config';

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
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private storageListener: ((event: StorageEvent) => void) | null = null;

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
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
    if (this.storageListener && typeof window !== 'undefined') {
      window.removeEventListener('storage', this.storageListener);
      this.storageListener = null;
    }
  }

  tryTakeover(): boolean {
    this.writeLease({
      tabId: this.tabId,
      updatedAt: Date.now(),
      expiresAt: Date.now() + PARKING_CONFIG.FOCUS_CONSOLE_LEASE_MS,
    });
    this.broadcast('takeover-request');
    this.refreshLeaseState();
    return this.isLeader();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      this.nowTick.set(Date.now());
      this.refreshLeaseState();
      if (this.isLeader()) {
        this.broadcast('lease-updated');
      }
    }, PARKING_CONFIG.FOCUS_CONSOLE_HEARTBEAT_MS);
  }

  private handleChannelMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const message = raw as Partial<FocusDockChannelMessage>;
    if (!message.type || !message.tabId) return;
    if (message.tabId === this.tabId) return;

    if (message.type === 'lease-updated' || message.type === 'takeover-request') {
      this.refreshLeaseState();
    }
  }

  private refreshLeaseState(): void {
    const now = Date.now();
    const lease = this.readLease();

    if (!lease || lease.expiresAt <= now) {
      const nextLease: FocusDockLease = {
        tabId: this.tabId,
        updatedAt: now,
        expiresAt: now + PARKING_CONFIG.FOCUS_CONSOLE_LEASE_MS,
      };
      this.writeLease(nextLease);
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
      this.writeLease(renewedLease);
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

  private writeLease(lease: FocusDockLease): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(PARKING_CONFIG.FOCUS_CONSOLE_LEADER_LEASE_KEY, JSON.stringify(lease));
    } catch (error) {
      this.logger.warn('FocusDockLeader write lease failed', error);
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
