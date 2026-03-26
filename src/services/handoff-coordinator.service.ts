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

  readonly result = this.resultState.asReadonly();

  markLayoutStable(): void {
    this.layoutStable = true;
    this.scheduleHandoffIfReady();
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

    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => trigger());
      return;
    }

    setTimeout(trigger, 0);
  }
}
