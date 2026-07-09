import type { Session } from '@supabase/supabase-js';

export interface SessionValidationSnapshot {
  valid: boolean;
  userId?: string;
  at: number;
}

export interface SessionValidationResult {
  valid: boolean;
  userId?: string;
  deferred?: boolean;
  reason?: 'client-unready';
}

export interface SessionRefreshResult {
  refreshed: boolean;
  session?: Session;
  reason?: 'client-unready' | 'refresh-failed' | 'no-session';
}

export type ResumeSessionResult = {
  ok: boolean;
  refreshed: boolean;
  deferred: boolean;
  reason?: 'client-unready' | 'no-session' | 'refresh-failed';
};
