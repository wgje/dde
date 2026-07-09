export interface ResolveInvalidatedOwnerUserIdInput {
  localModeUserId: string;
  currentUserId: string | null;
  persistedSessionUserId: string | null;
  persistedOwnerHint: string | null;
}

export function resolveInvalidatedOwnerUserId({
  localModeUserId,
  currentUserId,
  persistedSessionUserId,
  persistedOwnerHint,
}: ResolveInvalidatedOwnerUserIdInput): string | null {
  if (currentUserId === localModeUserId) {
    return null;
  }

  const candidates = [
    currentUserId,
    persistedSessionUserId,
    persistedOwnerHint,
  ];

  return candidates.find(candidate => !!candidate && candidate !== localModeUserId) ?? null;
}
