import { Injectable, inject, signal } from '@angular/core';
import type { LaunchSnapshot } from './launch-snapshot.service';
import { BootStageService } from './boot-stage.service';
import { resolveRouteIntent } from '../utils/route-intent';

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

  if (input.bootstrapFailed) {
    return { kind: 'full', degradeReason: 'bootstrap-failed' };
  }

  if (input.authConfigured && input.showLoginRequired) {
    return { kind: 'login-required', degradeReason: null };
  }

  if (
    input.authConfigured &&
    !input.hasProjects &&
    (input.isCheckingSession || input.authRuntimeState === 'idle' || input.authRuntimeState === 'pending')
  ) {
    return { kind: 'pending', degradeReason: null };
  }

  if (!input.hasProjects) {
    return { kind: 'empty-workspace', degradeReason: null };
  }

  if (wantsSpecificProject && routeIntent.projectId && !input.activeProjectId) {
    return { kind: 'degraded-to-project', degradeReason: 'project-unavailable' };
  }

  if (mobileDegraded) {
    return { kind: 'degraded-to-text', degradeReason: mobileDegradeReason };
  }

  return { kind: 'full', degradeReason: null };
}

@Injectable({
  providedIn: 'root',
})
export class HandoffCoordinatorService {
  private readonly bootStage = inject(BootStageService);
  private readonly resultState = signal<HandoffResult>({ kind: 'pending', degradeReason: null });
  private layoutStable = false;
  private handoffScheduled = false;
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;

  /** 最大等待时间（ms），超时后强制 handoff 防止永久卡在 launch-shell */
  private readonly HANDOFF_SAFETY_TIMEOUT_MS = 8000;

  readonly result = this.resultState.asReadonly();

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
      this.resultState.set({ kind: 'full', degradeReason: 'handoff-safety-timeout' });
      this.scheduleHandoffIfReady();
    }, this.HANDOFF_SAFETY_TIMEOUT_MS);
  }

  resolve(input: HandoffDecisionInput): HandoffResult {
    const next = resolveHandoffResult(input);
    this.resultState.set(next);
    this.scheduleHandoffIfReady();
    return next;
  }

  private scheduleHandoffIfReady(): void {
    if (!this.layoutStable || this.handoffScheduled || this.resultState().kind === 'pending') {
      return;
    }

    this.handoffScheduled = true;
    const trigger = () => this.bootStage.markWorkspaceHandoffReady();

    // 【Bug 修复 2026-03-26】rAF 在隐藏标签页（包括 PWA 后台启动）中被浏览器节流/暂停，
    // 导致 handoff 永不触发，用户卡在 launch-shell。
    // 改为 rAF + setTimeout 双保险：谁先触发谁执行，另一个忽略。
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      let fired = false;
      const onceTrigger = () => {
        if (!fired) {
          fired = true;
          trigger();
        }
      };
      window.requestAnimationFrame(onceTrigger);
      setTimeout(onceTrigger, 100);
      return;
    }

    setTimeout(trigger, 0);
  }
}
