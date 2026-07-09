/**
 * SyncPulseEngineService
 *
 * 从 WorkspaceShellComponent 抽离的 EventDrivenSyncPulse「引擎句柄」。
 *
 * 职责单一：
 * - 懒加载 `EventDrivenSyncPulseService`（按需 import + 去重缓存）
 * - 暴露 `initialize()` / `destroy()` / `trigger(reason)` 三个生命周期入口
 *
 * 为什么只抽这一层：
 * - 引擎句柄是纯粹的「懒加载 + 生命周期」横切责任，仅依赖 Injector / Logger，
 *   与组件信号（focusModeIntentActivated / coreDataLoaded）零耦合，可安全单例化。
 * - 「focus-entry 派发器」（dispatchFocusEntrySyncPulseIfReady / 重试 / generation
 *   防竞态 / isSyncPulseReady）与组件共享信号、挂载意图监听器、effect 及会话处理深度
 *   交织，且被大量 `.call(context)` 单测以「组件行为」驱动，强行抽离会形成回指组件的
 *   泄漏式抽象，故按设计保留在组件内。
 */
import { Injectable, inject, Injector } from '@angular/core';
import { LoggerService } from './logger.service';

/** 同步脉冲触发时机 */
export type SyncPulseReason =
  | 'focus-entry'
  | 'manual'
  | 'focus'
  | 'visible'
  | 'pageshow'
  | 'online'
  | 'heartbeat';

/** EventDrivenSyncPulseService 的最小结构契约（避免静态导入其实现，保持懒加载） */
export type EventDrivenSyncPulseLike = {
  initialize: () => void;
  destroy: () => void;
  triggerNow: (reason: SyncPulseReason) => Promise<{
    status: 'success' | 'failed' | 'skipped';
    skipReason?: 'disabled' | 'cooldown' | 'offline' | 'hidden' | 'unauthenticated' | 'resuming' | 'compensating' | 'post-heavy-cooldown' | 'same-ticket' | 'in-flight';
    retryAfterMs?: number;
  }>;
};

@Injectable({ providedIn: 'root' })
export class SyncPulseEngineService {
  private readonly injector = inject(Injector);
  private readonly logger = inject(LoggerService).category('SyncPulse');

  private ref: EventDrivenSyncPulseLike | null = null;
  private loadPromise: Promise<EventDrivenSyncPulseLike | null> | null = null;
  private pendingLoadDestroyPromise: Promise<unknown> | null = null;
  private lifecycleGeneration = 0;
  private lifecycleClosed = false;

  /** 懒加载并初始化引擎。 */
  initialize(): void {
    this.lifecycleClosed = false;
    const generation = this.lifecycleGeneration;
    void this.getLazy()
      .then((service) => {
        if (generation === this.lifecycleGeneration) {
          try {
            service?.initialize();
          } catch (error) {
            this.warn('EventDrivenSyncPulseService 初始化失败，降级关闭 pulse', error);
          }
        }
      })
      .catch((error) => {
        this.warn('EventDrivenSyncPulseService 初始化失败，降级关闭 pulse', error);
      });
  }

  /** 销毁引擎（保留 ref 以便后续 initialize 复用，语义与历史实现一致）。 */
  destroy(): void {
    this.lifecycleClosed = true;
    this.lifecycleGeneration += 1;
    if (this.ref) {
      this.destroyRefSafely(this.ref);
      return;
    }
    if (this.loadPromise && !this.pendingLoadDestroyPromise) {
      this.pendingLoadDestroyPromise = this.loadPromise
        .then((service) => {
          if (service) {
            this.destroyRefSafely(service);
          }
        })
        .finally(() => {
          this.pendingLoadDestroyPromise = null;
        });
    }
  }

  /**
   * 触发一次同步脉冲。调用方需自行判断 `isSyncPulseReady`——本方法只负责
   * 懒加载引擎并转发 `triggerNow`，引擎不可用时返回 null。
   */
  async trigger(
    reason: SyncPulseReason,
  ): Promise<Awaited<ReturnType<EventDrivenSyncPulseLike['triggerNow']>> | null> {
    if (this.lifecycleClosed) {
      return null;
    }

    const generation = this.lifecycleGeneration;
    const service = await this.getLazy();
    if (!service || this.lifecycleClosed || generation !== this.lifecycleGeneration) {
      return null;
    }
    try {
      return await service.triggerNow(reason);
    } catch (error) {
      this.warn('EventDrivenSyncPulseService 触发失败，已跳过本次 pulse', error);
    }
    return null;
  }

  private destroyRefSafely(service: EventDrivenSyncPulseLike): void {
    try {
      service.destroy();
    } catch (error) {
      this.warn('EventDrivenSyncPulseService 销毁失败，已忽略迟到清理错误', error);
    }
  }

  private async getLazy(): Promise<EventDrivenSyncPulseLike | null> {
    if (this.ref) {
      return this.ref;
    }
    if (this.loadPromise) {
      return this.loadPromise;
    }

    this.loadPromise = import('./event-driven-sync-pulse.service')
      .then((module) => {
        const service = this.injector.get(module.EventDrivenSyncPulseService) as EventDrivenSyncPulseLike;
        this.ref = service;
        return service;
      })
      .catch((error) => {
        this.warn('EventDrivenSyncPulseService 懒加载失败，降级关闭 pulse', error);
        return null;
      })
      .finally(() => {
        this.loadPromise = null;
      });

    return this.loadPromise;
  }

  private warn(message: string, error: unknown): void {
    try {
      this.logger.warn(message, error);
    } catch {
      // Warning sinks must not re-open lazy-load, initialize, or teardown failure paths.
    }
  }
}
