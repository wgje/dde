import type { AppResumeReason } from './app-lifecycle-orchestrator.types';

export type AppLifecycleBreadcrumbMessage =
  | 'lifecycle.resume.start'
  | 'lifecycle.resume.reason'
  | 'lifecycle.resume.success'
  | 'lifecycle.resume.fail'
  | 'recovery.step'
  | 'lifecycle.version-reload.activate-ok'
  | 'lifecycle.version-reload.activate-failed';

export interface AppLifecycleBreadcrumbSink {
  addBreadcrumb(breadcrumb: {
    category: 'lifecycle';
    message: AppLifecycleBreadcrumbMessage;
    level: 'info';
    data: Record<string, unknown>;
  }): void;
}

export interface AppLifecycleBreadcrumbLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export class AppLifecycleBreadcrumbsController {
  constructor(
    private readonly sentryLazyLoader: AppLifecycleBreadcrumbSink,
    private readonly logger?: AppLifecycleBreadcrumbLogger,
  ) {}

  recordStep(step: string, reason: AppResumeReason): void {
    recordLifecycleRecoveryStep({
      sentryLazyLoader: this.sentryLazyLoader,
      logger: this.logger,
      step,
      reason,
    });
  }

  add(
    message: AppLifecycleBreadcrumbMessage,
    reason: AppResumeReason | 'manual',
    extra?: Record<string, unknown>,
  ): void {
    addLifecycleBreadcrumb({
      sentryLazyLoader: this.sentryLazyLoader,
      logger: this.logger,
      message,
      reason,
      extra,
    });
  }
}

export function recordLifecycleRecoveryStep(options: {
  sentryLazyLoader: AppLifecycleBreadcrumbSink;
  logger?: AppLifecycleBreadcrumbLogger;
  step: string;
  reason: AppResumeReason;
}): void {
  addLifecycleBreadcrumb({
    sentryLazyLoader: options.sentryLazyLoader,
    logger: options.logger,
    message: 'recovery.step',
    reason: options.reason,
    extra: { step: options.step },
  });
}

export function addLifecycleBreadcrumb(options: {
  sentryLazyLoader: AppLifecycleBreadcrumbSink;
  logger?: AppLifecycleBreadcrumbLogger;
  message: AppLifecycleBreadcrumbMessage;
  reason: AppResumeReason | 'manual';
  extra?: Record<string, unknown>;
}): void {
  try {
    options.sentryLazyLoader.addBreadcrumb({
      category: 'lifecycle',
      message: options.message,
      level: 'info',
      data: {
        reason: options.reason,
        ...options.extra,
      },
    });
  } catch (error) {
    options.logger?.warn('Lifecycle breadcrumb failed', {
      message: options.message,
      reason: options.reason,
      error,
    });
  }
}
