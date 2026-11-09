import type { Project } from '../../../models';
import type { StartupEntryIntent } from '../../../utils/startup-entry-intent';
import {
  resolveStartupProjectFallbackId,
  shouldNavigateRootStartupToTextProject,
} from './workspace-shell-startup-route.helpers';

export interface WorkspaceShellMobileRootStartupNavigationControllerOptions {
  isMobile: () => boolean;
  activeProjectId: () => string | null;
  projects: () => readonly Pick<Project, 'id'>[];
  startupLaunchSnapshot: () => {
    activeProjectId: string | null;
    currentProject?: Pick<Project, 'id'> | null;
  } | null;
  routeUrl: () => string;
  startupEntryIntent: () => Pick<StartupEntryIntent, 'intent'> | null;
  navigateToTextProject: (projectId: string) => Promise<unknown> | unknown;
  warn: (message: string, error: unknown) => void;
}

interface MobileRootNavigationStateReceipt {
  readonly applied: boolean;
  readonly destroyed: boolean;
  readonly generation: number;
  readonly inFlight: boolean;
  readonly inFlightGeneration: number | null;
  readonly inFlightProjectId: string | null;
  readonly requestedProjectId: string | null;
}

export class WorkspaceShellMobileRootStartupNavigationController {
  private destroyed = false;
  private rootStartupTextNavigationApplied = false;
  private rootStartupTextNavigationInFlight = false;
  private rootStartupTextNavigationGeneration = 0;
  private rootStartupTextNavigationRequestedProjectId: string | null = null;
  private rootStartupTextNavigationInFlightGeneration: number | null = null;
  private rootStartupTextNavigationInFlightProjectId: string | null = null;

  constructor(private readonly options: WorkspaceShellMobileRootStartupNavigationControllerOptions) {}

  resolveStartupProjectFallbackId(projects = this.options.projects()): string | null {
    return resolveStartupProjectFallbackId({
      projects,
      startupLaunchSnapshot: this.options.startupLaunchSnapshot(),
    });
  }

  resolveMobileRootStartupProjectId(): string | null {
    if (!this.options.isMobile()) {
      return null;
    }

    const activeProjectId = this.options.activeProjectId();
    if (activeProjectId) {
      return activeProjectId;
    }

    return this.resolveStartupProjectFallbackId();
  }

  shouldNavigateRootStartupToTextProject(): boolean {
    if (this.destroyed) {
      return false;
    }

    return shouldNavigateRootStartupToTextProject({
      routeUrl: this.options.routeUrl(),
      isMobile: this.options.isMobile(),
      rootStartupTextNavigationApplied: this.rootStartupTextNavigationApplied,
      startupEntryIntent: this.options.startupEntryIntent(),
    });
  }

  navigateRootStartupToTextProject(projectId: string): void {
    if (this.destroyed) {
      return;
    }

    const admissionReceipt = this.captureNavigationStateReceipt();
    if (!this.shouldNavigateRootStartupToTextProject()) {
      return;
    }
    if (!this.isNavigationStateReceiptCurrent(admissionReceipt)) {
      return;
    }

    if (this.rootStartupTextNavigationInFlight) {
      this.noteRequestedProject(projectId);
      return;
    }

    const generation = this.beginNavigationAttempt(projectId);
    this.navigateAdmittedRequest(generation, projectId);
  }

  private navigateAdmittedRequest(generation: number, projectId: string): void {
    if (this.destroyed) {
      return;
    }

    this.rootStartupTextNavigationInFlight = true;
    this.rootStartupTextNavigationInFlightGeneration = generation;
    this.rootStartupTextNavigationInFlightProjectId = projectId;
    try {
      void Promise.resolve(this.options.navigateToTextProject(projectId))
        .then((result: unknown) => {
          if (
            this.isCurrentNavigationAttempt(generation, projectId)
            && this.isConfirmedNavigationResult(result)
          ) {
            const shouldApply = this.shouldNavigateRootStartupToTextProject();
            if (shouldApply && this.isCurrentNavigationAttempt(generation, projectId)) {
              this.rootStartupTextNavigationApplied = true;
            }
          }
        })
        .catch((error: unknown) => {
          if (this.isInFlightNavigationAttempt(generation, projectId)) {
            this.warn('Mobile root startup navigation failed', error);
          }
        })
        .finally(() => {
          this.settleNavigationAttempt(generation, projectId);
      });
    } catch (error) {
      if (!this.isInFlightNavigationAttempt(generation, projectId)) {
        return;
      }

      this.warn('Mobile root startup navigation failed', error);
      this.settleNavigationAttempt(generation, projectId);
    }
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.rootStartupTextNavigationGeneration += 1;
    this.rootStartupTextNavigationRequestedProjectId = null;
    this.rootStartupTextNavigationInFlight = false;
    this.rootStartupTextNavigationInFlightGeneration = null;
    this.rootStartupTextNavigationInFlightProjectId = null;
  }

  private beginNavigationAttempt(projectId: string): number {
    const generation = this.rootStartupTextNavigationGeneration + 1;
    this.rootStartupTextNavigationGeneration = generation;
    this.rootStartupTextNavigationRequestedProjectId = projectId;
    return generation;
  }

  private noteRequestedProject(projectId: string): void {
    if (this.rootStartupTextNavigationRequestedProjectId === projectId) {
      return;
    }

    this.rootStartupTextNavigationRequestedProjectId = projectId;
    this.rootStartupTextNavigationGeneration += 1;
  }

  private isCurrentNavigationAttempt(generation: number, projectId: string): boolean {
    return this.rootStartupTextNavigationRequestedProjectId === projectId
      && this.isInFlightNavigationAttempt(generation, projectId);
  }

  private isInFlightNavigationAttempt(generation: number, projectId: string): boolean {
    return this.rootStartupTextNavigationInFlight
      && this.rootStartupTextNavigationInFlightGeneration === generation
      && this.rootStartupTextNavigationInFlightProjectId === projectId;
  }

  private settleNavigationAttempt(generation: number, projectId: string): void {
    if (!this.isInFlightNavigationAttempt(generation, projectId)) {
      return;
    }

    this.rootStartupTextNavigationInFlight = false;
    this.rootStartupTextNavigationInFlightGeneration = null;
    this.rootStartupTextNavigationInFlightProjectId = null;

    if (this.rootStartupTextNavigationGeneration === generation) {
      return;
    }

    const requestedReceipt = this.captureNavigationStateReceipt();
    const requestedProjectId = requestedReceipt.requestedProjectId;
    if (requestedProjectId === null) {
      return;
    }
    if (!this.shouldNavigateRootStartupToTextProject()) {
      return;
    }
    if (!this.isNavigationStateReceiptCurrent(requestedReceipt)) {
      return;
    }

    this.navigateAdmittedRequest(
      requestedReceipt.generation,
      requestedProjectId,
    );
  }

  private captureNavigationStateReceipt(): MobileRootNavigationStateReceipt {
    return {
      applied: this.rootStartupTextNavigationApplied,
      destroyed: this.destroyed,
      generation: this.rootStartupTextNavigationGeneration,
      inFlight: this.rootStartupTextNavigationInFlight,
      inFlightGeneration: this.rootStartupTextNavigationInFlightGeneration,
      inFlightProjectId: this.rootStartupTextNavigationInFlightProjectId,
      requestedProjectId: this.rootStartupTextNavigationRequestedProjectId,
    };
  }

  private isNavigationStateReceiptCurrent(receipt: MobileRootNavigationStateReceipt): boolean {
    return this.rootStartupTextNavigationApplied === receipt.applied
      && this.destroyed === receipt.destroyed
      && this.rootStartupTextNavigationGeneration === receipt.generation
      && this.rootStartupTextNavigationInFlight === receipt.inFlight
      && this.rootStartupTextNavigationInFlightGeneration === receipt.inFlightGeneration
      && this.rootStartupTextNavigationInFlightProjectId === receipt.inFlightProjectId
      && this.rootStartupTextNavigationRequestedProjectId === receipt.requestedProjectId;
  }

  private isConfirmedNavigationResult(result: unknown): boolean {
    return result === undefined || result === true;
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning sinks must not block root startup navigation retries.
    }
  }
}
