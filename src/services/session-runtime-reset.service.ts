import { Injectable, inject } from '@angular/core';

import { LoggerService } from './logger.service';

export type SessionRuntimeResetReason = 'owner-change' | 'clear-local-data';

type SessionRuntimeResetCallback = (reason: SessionRuntimeResetReason) => void;

export interface SessionRuntimeResetFailure {
  owner: string;
  error: unknown;
}

export interface SessionRuntimeResetResult {
  ok: boolean;
  reason: SessionRuntimeResetReason;
  attemptedOwners: string[];
  failures: SessionRuntimeResetFailure[];
}

interface SessionRuntimeResetRegistration {
  owner: string;
  reset: SessionRuntimeResetCallback;
}

@Injectable({ providedIn: 'root' })
export class SessionRuntimeResetRegistry {
  private readonly logger = inject(LoggerService);
  private readonly registrations = new Set<SessionRuntimeResetRegistration>();

  register(owner: string, reset: SessionRuntimeResetCallback): () => void {
    const registration = { owner, reset };
    this.registrations.add(registration);

    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      this.registrations.delete(registration);
    };
  }

  resetAll(reason: SessionRuntimeResetReason): SessionRuntimeResetResult {
    const attemptedOwners: string[] = [];
    const failures: SessionRuntimeResetFailure[] = [];
    for (const registration of Array.from(this.registrations)) {
      attemptedOwners.push(registration.owner);
      try {
        registration.reset(reason);
      } catch (error) {
        failures.push({ owner: registration.owner, error });
        this.logger.warn(
          'SessionRuntimeResetRegistry',
          '会话运行时重置失败，继续处理其他运行时',
          { owner: registration.owner, reason, error },
        );
      }
    }
    return {
      ok: failures.length === 0,
      reason,
      attemptedOwners,
      failures,
    };
  }
}
