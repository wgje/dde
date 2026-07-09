export type LocalPersistRoute = 'missing-user' | 'existing-conflict' | 'local-only' | 'remote';

export interface LocalPersistRouteInput {
  hasUserId: boolean;
  hasExistingConflict: boolean;
  syncSource: 'local-only' | 'synced' | undefined;
}

export type RemotePersistRoute = 'success' | 'conflict' | 'validation-failure' | 'partial-failure';

export interface RemotePersistRouteInput {
  success: boolean;
  conflict?: boolean;
  validationWarnings?: readonly string[];
}

export function classifyLocalPersistRoute(input: LocalPersistRouteInput): LocalPersistRoute {
  if (!input.hasUserId) {
    return 'missing-user';
  }

  if (input.hasExistingConflict) {
    return 'existing-conflict';
  }

  return input.syncSource === 'local-only' ? 'local-only' : 'remote';
}

export function classifyRemotePersistRoute(input: RemotePersistRouteInput): RemotePersistRoute {
  if (input.success) {
    return 'success';
  }

  if (input.conflict) {
    return 'conflict';
  }

  return input.validationWarnings && input.validationWarnings.length > 0
    ? 'validation-failure'
    : 'partial-failure';
}
