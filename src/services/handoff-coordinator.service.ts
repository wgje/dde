import { Injectable, inject, signal } from '@angular/core';
import type { LaunchSnapshot } from './launch-snapshot.service';
import { BootStageService } from './boot-stage.service';
import { resolveRouteIntent } from '../utils/route-intent';
import { pushStartupTrace } from '../utils/startup-trace';

export type HandoffResultKind =
  | 'pending'
  | 'full'
  | 'degraded-to-text'
  | 'degraded-to-project'
  | 'login-required'
  | 'empty-workspace';

export interface HandoffResult {
  kind: HandoffResultKind;
  degradeReason: string | null;
}

export interface HandoffDecisionInput {
  routeUrl: string;
  isMobile: boolean;
  hasProjects: boolean;
  activeProjectId: string | null;
  authConfigured: boolean;
  authRuntimeState: 'idle' | 'pending' | 'ready' | 'failed';
  isCheckingSession: boolean;
  showLoginRequired: boolean;
  bootstrapFailed: boolean;
  snapshot: LaunchSnapshot | null;
}

export type HandoffTriggerSource = 'raf' | 'timeout100' | 'timeout0' | 'safety8s';

function applyNonBlockingLoginFallback(
  input: HandoffDecisionInput,
  result: HandoffResult
): HandoffResult {
  if (!(input.authConfigured && input.showLoginRequired && input.hasProjects)) {
    return result;
  }

  if (result.kind === 'full' && result.degradeReason === null) {
    return { kind: 'full', degradeReason: 'login-required-nonblocking' };
  }

  return result;
}

export function shouldDegradeMobileStartupRoute(routeUrl: string, isMobile: boolean): boolean {
  if (!isMobile) {
    return false;
  }

  return routeUrl.endsWith('/flow') || routeUrl.includes('/task/');
}

export function resolveHandoffResult(input: HandoffDecisionInput): HandoffResult {
  const routeIntent = input.snapshot?.routeIntent ?? resolveRouteIntent(input.routeUrl, input.activeProjectId);
  const wantsSpecificProject = routeIntent.kind !== 'projects';
  const mobileDegraded = input.snapshot?.mobileDegraded === true
    || shouldDegradeMobileStartupRoute(input.routeUrl, input.isMobile);
  const mobileDegradeReason = input.snapshot?.degradeReason ?? 'mobile-default-text';

  // 【P0 秒开修复 2026-03-28】快照感知：快照中有项目时视为 hasProjects=true，
  // 避免 effect 异步时序导致 prehydrate 结果未被 signal 反映而卡在 pending。
  const effectiveHasProjects = input.hasProjects
    || (input.snapshot?.projects?.length ?? 0) > 0;

  if (input.bootstrapFailed) {
    return { kind: 'full', degradeReason: 'bootstrap-failed' };
  }

  if (input.authConfigured && input.showLoginRequired && !effectiveHasProjects) {
    return { kind: 'login-required', degradeReason: null };
  }

  if (
    input.authConfigured &&
    !effectiveHasProjects &&
    (input.isCheckingSession || input.authRuntimeState === 'idle' || input.authRuntimeState === 'pending')
  ) {
    return { kind: 'pending', degradeReason: null };
  }

  if (!effectiveHasProjects) {
    return applyNonBlockingLoginFallback(input, { kind: 'empty-workspace', degradeReason: null });
  }

  if (wantsSpecificProject && routeIntent.projectId && !input.activeProjectId) {
    return applyNonBlockingLoginFallback(input, { kind: 'degraded-to-project', degradeReason: 'project-unavailable' });
  }

  if (mobileDegraded) {
    return applyNonBlockingLoginFallback(input, { kind: 'degraded-to-text', degradeReason: mobileDegradeReason });
  }

  return applyNonBlockingLoginFallback(input, { kind: 'full', degradeReason: null });
}

@Injectable({
  providedIn: 'root',
})
export class HandoffCoordinatorService {
  private readonly bootStage = inject(BootStageService);
  private readonly resultState = signal<HandoffResult>({ kind: 'pending', degradeReason: null });
  private readonly handoffTriggerSourceState = signal<HandoffTriggerSource | null>(null);
  private layoutStable = false;
  private handoffScheduled = false;
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;
  private safetyTriggered = false;

  /** 最大等待时间（ms），超时后强制 handoff 防止永久卡在 launch-shell */
  // 【P0 秒开优化 2026-03-28】从 3s 降至 1.5s
  // P0-1 快照感知修复后，正常路径 handoff < 100ms 完成。
  // 1.5s 足够覆盖极端异常（快照损坏 + 缓存丢失 + 网络超时）。
  private readonly HANDOFF_SAFETY_TIMEOUT_MS = 1500;

  readonly result = this.resultState.asReadonly();
  readonly handoffTriggerSource = this.handoffTriggerSourceState.asReadonly();

  markLayoutStable(): void {
    this.layoutStable = true;
    this.scheduleHandoffIfReady();
    this.startSafetyTimer();
  }

  /**
   * 安全超时：layoutStable 后若 handoff 在 8s 内仍未触发（result 一直 pending），
   * 强制将 result 设为 'full'（降级）并执行 handoff。
   * 防止任何状态机死锁导致用户永久卡在启动壳。
   */
  private startSafetyTimer(): void {
    if (this.safetyTimer || this.handoffScheduled) {
      return;
    }
    this.safetyTimer = setTimeout(() => {
      if (this.handoffScheduled) {
        return;
      }
      // 强制降级 handoff — 比永远卡住好
      this.safetyTriggered = true;
      this.resultState.set({ kind: 'full', degradeReason: 'handoff-safety-timeout' });
      pushStartupTrace('handoff.safety_timeout', {
        layoutStable: this.layoutStable,
        resultKind: this.resultState().kind,
        degradeReason: this.resultState().degradeReason,
      });
      this.scheduleHandoffIfReady();
    }, this.HANDOFF_SAFETY_TIMEOUT_MS);
  }

  resolve(input: HandoffDecisionInput): HandoffResult {
    const next = resolveHandoffResult(input);
    this.resultState.set(next);
    pushStartupTrace('handoff.resolve', {
      routeUrl: input.routeUrl,
      hasProjects: input.hasProjects,
      activeProjectId: input.activeProjectId,
      authRuntimeState: input.authRuntimeState,
      isCheckingSession: input.isCheckingSession,
      showLoginRequired: input.showLoginRequired,
      bootstrapFailed: input.bootstrapFailed,
      resultKind: next.kind,
      degradeReason: next.degradeReason,
      hidden: typeof document !== 'undefined' ? document.hidden : null,
      online: typeof navigator !== 'undefined' ? navigator.onLine : null,
    });
    this.scheduleHandoffIfReady();
    return next;
  }

  private scheduleHandoffIfReady(): void {
    if (!this.layoutStable || this.handoffScheduled || this.resultState().kind === 'pending') {
      return;
    }

    this.handoffScheduled = true;
    const trigger = (source: HandoffTriggerSource) => {
      this.handoffTriggerSourceState.set(source);
      pushStartupTrace('handoff.trigger', {
        source,
        resultKind: this.resultState().kind,
        degradeReason: this.resultState().degradeReason,
      });
      this.bootStage.markWorkspaceHandoffReady();
    };

    if (this.safetyTriggered) {
      setTimeout(() => trigger('safety8s'), 0);
      return;
    }

    // 【Bug 修复 2026-03-26】rAF 在隐藏标签页（包括 PWA 后台启动）中被浏览器节流/暂停，
    // 导致 handoff 永不触发，用户卡在 launch-shell。
    // 改为 rAF + setTimeout 双保险：谁先触发谁执行，另一个忽略。
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      let fired = false;
      const onceTrigger = (source: HandoffTriggerSource) => {
        if (!fired) {
          fired = true;
          trigger(source);
        }
      };
      window.requestAnimationFrame(() => onceTrigger('raf'));
      setTimeout(() => onceTrigger('timeout100'), 100);
      return;
    }

    setTimeout(() => trigger('timeout0'), 0);
  }
}
