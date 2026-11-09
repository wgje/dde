import type { Task } from '../models';
import type { supabaseErrorToError } from '../utils/supabase-error';
import {
  shouldSkipRemoteProjectUpdate,
  shouldSkipRemoteTaskUpdate,
} from './remote-change-handler.helpers';
import type {
  RemoteTaskChangePayload,
  RemoteTaskUpdateContext,
} from './remote-change-handler.types';
import type { RemoteProjectDeleteSessionContext } from './remote-project-delete-deferral.controller';

interface RemoteProjectSessionContextSource {
  currentUserId(): string | null | undefined;
  getCurrentSessionGeneration(): number;
}

export function evaluateRemoteProjectUpdateGuard(
  isEditing: boolean,
  hasPendingLocalChanges: boolean,
  now: number,
  lastPersistAt: number,
): { shouldSkip: boolean; logContext: Record<string, unknown> | null } {
  const guardMs = 2000;
  const decision = shouldSkipRemoteProjectUpdate({
    isEditing,
    hasPendingLocalChanges,
    now,
    lastPersistAt,
    guardMs,
  });

  return {
    shouldSkip: decision.shouldSkip,
    logContext: decision.shouldSkip
      ? {
          isEditing,
          hasPendingLocalChanges,
          timeSinceLastPersist: decision.timeSinceLastPersist,
          inEditGuard: decision.inEditGuard,
          threshold: guardMs,
        }
      : null,
  };
}

export function captureRemoteProjectSessionContext(
  source: RemoteProjectSessionContextSource,
): RemoteProjectDeleteSessionContext | null {
  const userId = source.currentUserId();
  if (!userId) return null;
  return { userId, sessionGeneration: source.getCurrentSessionGeneration() };
}

export function createStaleRemoteProjectSessionLogContext(
  context: RemoteProjectDeleteSessionContext,
  projectId: string,
  stage: string,
  source: RemoteProjectSessionContextSource,
): Record<string, unknown> {
  return {
    projectId,
    stage,
    expectedUserId: context.userId,
    expectedSessionGeneration: context.sessionGeneration,
    currentUserId: source.currentUserId(),
    currentSessionGeneration: source.getCurrentSessionGeneration(),
  };
}

export function createRemoteTaskUpdateContext(input: {
  eventType: RemoteTaskChangePayload['eventType'];
  taskId: string;
  targetProjectId: string;
  ownerUserId: string;
  sessionGeneration: number;
  permissionDeniedTaskSnapshot: Task | null;
  currentProjectId: string | null;
  requestId: number;
}): RemoteTaskUpdateContext {
  return {
    ...input,
  };
}

export function shouldSkipRemoteTaskChange(
  payload: RemoteTaskChangePayload,
  now: number,
  lastPersistAt: number,
): boolean {
  // Match the sync debounce delay so this device's realtime echo cannot overwrite local state.
  const ECHO_PROTECTION_WINDOW = 3000;
  const inEchoGuard = shouldSkipRemoteTaskUpdate({
    now,
    lastPersistAt,
    echoProtectionMs: ECHO_PROTECTION_WINDOW,
  });

  // DELETE does not load a remote project, but still observes echo protection.
  if (payload.eventType === 'DELETE') {
    return inEchoGuard;
  }

  // INSERT/UPDATE field protection remains in the downstream merge path.
  return inEchoGuard;
}

export function isPermissionDeniedRemoteTaskError(
  supabaseError: ReturnType<typeof supabaseErrorToError>,
): boolean {
  return supabaseError.errorType === 'PermissionError'
    || supabaseError.code === '403'
    || supabaseError.code === 403
    || supabaseError.code === '401'
    || supabaseError.code === 401
    || supabaseError.code === '42501'
    || supabaseError.code === 42501
    || supabaseError.status === '403'
    || supabaseError.status === 403
    || supabaseError.status === '401'
    || supabaseError.status === 401;
}
