import {
  CONFLICT_FALLBACK_KEY_PREFIX,
  LEGACY_UNKNOWN_OWNER_USER_ID,
  isConflictRecordVisible,
  type ConflictRecord,
} from './conflict-storage.helpers';

export function listConflictFallbackKeys(
  keyPrefix = CONFLICT_FALLBACK_KEY_PREFIX,
): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(keyPrefix)) {
      keys.push(key);
    }
  }
  return keys;
}

export function getConflictFallbackKeysForOwner(
  ownerUserId: string,
  keyPrefix = CONFLICT_FALLBACK_KEY_PREFIX,
): string[] {
  if (ownerUserId === LEGACY_UNKNOWN_OWNER_USER_ID) {
    return listConflictFallbackKeys(keyPrefix).filter(key => {
      if (!key.startsWith(keyPrefix)) return false;
      return !key.slice(keyPrefix.length).includes('.');
    });
  }

  const scopedPrefix = `${keyPrefix}${ownerUserId}.`;
  return listConflictFallbackKeys(keyPrefix).filter(key => key.startsWith(scopedPrefix));
}

export function getAllVisibleConflictFallbackRecords(
  currentOwnerUserId: string,
  keyPrefix = CONFLICT_FALLBACK_KEY_PREFIX,
): ConflictRecord[] {
  const records: ConflictRecord[] = [];
  const currentPrefix = `${keyPrefix}${currentOwnerUserId}.`;
  for (const key of listConflictFallbackKeys(keyPrefix)) {
    if (!key.startsWith(currentPrefix)) continue;
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    const record = JSON.parse(raw) as ConflictRecord;
    if (isConflictRecordVisible(record, currentOwnerUserId)) {
      records.push(record);
    }
  }
  return records;
}

export function hasConflictFallbackForOwner(
  ownerUserId: string,
  keyPrefix = CONFLICT_FALLBACK_KEY_PREFIX,
): boolean {
  const currentPrefix = `${keyPrefix}${ownerUserId}.`;
  return listConflictFallbackKeys(keyPrefix).some(key => key.startsWith(currentPrefix));
}

export function countConflictFallbackForOwner(
  ownerUserId: string,
  keyPrefix = CONFLICT_FALLBACK_KEY_PREFIX,
): number {
  const currentPrefix = `${keyPrefix}${ownerUserId}.`;
  return listConflictFallbackKeys(keyPrefix).filter(key => key.startsWith(currentPrefix)).length;
}
