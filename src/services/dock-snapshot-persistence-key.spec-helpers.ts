import { describe, expect, it } from 'vitest';
import type {
  DockSnapshotPersistenceService as DockSnapshotPersistenceServiceType,
} from './dock-snapshot-persistence.service';

interface DockSnapshotKeySpecContext {
  getService: () => DockSnapshotPersistenceServiceType;
}

export function registerDockSnapshotKeySpecs(context: DockSnapshotKeySpecContext): void {
  describe('localCacheKey', () => {
    it('should include user id in the key', () => {
      const key = context.getService().localCacheKey('user-123');
      expect(key).toBe('nanoflow.focus-session.v5.user-123');
    });

    it('should use "anonymous" for null user id', () => {
      const key = context.getService().localCacheKey(null);
      expect(key).toBe('nanoflow.focus-session.v5.anonymous');
    });

    it('should use "anonymous" for empty string user id', () => {
      // empty string is falsy -> falls through to 'anonymous'
      const key = context.getService().localCacheKey('' as unknown as string);
      expect(key).toBe('nanoflow.focus-session.v5.anonymous');
    });
  });

  describe('legacyLocalStorageKey', () => {
    it('should include user id in the key', () => {
      const key = context.getService().legacyLocalStorageKey('user-abc');
      expect(key).toBe('nanoflow.dock-snapshot.v3.user-abc');
    });

    it('should use "anonymous" for null user id', () => {
      const key = context.getService().legacyLocalStorageKey(null);
      expect(key).toBe('nanoflow.dock-snapshot.v3.anonymous');
    });
  });
}
