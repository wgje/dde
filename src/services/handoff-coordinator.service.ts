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
  snapshotProjectsTrusted: boolean;
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

function resolveHandoffResult(input: HandoffDecisionInput): HandoffResult {
  const routeIntent = input.snapshot?.routeIntent ?? resolveRouteIntent(input.routeUrl, input.activeProjectId);
  const wantsSpecificProject = routeIntent.kind !== 'projects';
  const mobileDegraded = input.snapshot?.mobileDegraded === true
    || shouldDegradeMobileStartupRoute(input.routeUrl, input.isMobile);
  const mobileDegradeReason = input.snapshot?.degradeReason ?? 'mobile-default-text';

  // 【P0 秒开修复 2026-03-28】快照感知：快照中有项目时视为 hasProjects=true，
  // 避免 effect 异步时序导致 prehydrate 结果未被 signal 反映而卡在 pending。
  const effectiveHasProjects = input.hasProjects
    || (input.snapshotProjectsTrusted && (input.snapshot?.projects?.length ?? 0) > 0);

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
  // 【P1 秒开优化 2026-03-31】从 800ms 降至 300ms。
  // 快照预填充 + provisional userId 使正常路径 handoff < 10ms，
  // 300ms 仅覆盖快照完全损坏的极端降级场景。
  private readonly HANDOFF_SAFETY_TIMEOUT_MS = 300;

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

    // 【P1 秒开优化 2026-03-31】使用 microtask 即时触发 handoff，
    // 取代 rAF + setTimeout(100ms)。快照预填充使内容在构造函数阶段即可用，
    // 无需等待下一帧渲染。setTimeout(16ms) 作为 microtask 被吞掉时的兜底。
    if (typeof queueMicrotask === 'function') {
      let fired = false;
      const onceTrigger = (source: HandoffTriggerSource) => {
        if (!fired) {
          fired = true;
          trigger(source);
        }
      };
      queueMicrotask(() => onceTrigger('raf'));
      setTimeout(() => onceTrigger('timeout0'), 16);
      return;
    }

    setTimeout(() => trigger('timeout0'), 0);
  }
}
