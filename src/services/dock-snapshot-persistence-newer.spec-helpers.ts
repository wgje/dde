import { describe, expect, it } from 'vitest';

import type { DockSnapshotPersistenceService } from './dock-snapshot-persistence.service';
import type { DockSnapshot } from '../models/parking-dock';

interface DockSnapshotNewerSpecContext {
  getService: () => DockSnapshotPersistenceService;
}

export function registerDockSnapshotNewerSpecs(context: DockSnapshotNewerSpecContext): void {
  describe('isSnapshotNewer', () => {
    it('should return true when incoming is newer than current', () => {
      const incoming = { savedAt: '2025-01-15T12:00:00.000Z' } as DockSnapshot;
      const current = { savedAt: '2025-01-15T10:00:00.000Z' } as DockSnapshot;
      expect(context.getService().isSnapshotNewer(incoming, current)).toBe(true);
    });

    it('should return false when incoming is older than current', () => {
      const incoming = { savedAt: '2025-01-15T08:00:00.000Z' } as DockSnapshot;
      const current = { savedAt: '2025-01-15T10:00:00.000Z' } as DockSnapshot;
      expect(context.getService().isSnapshotNewer(incoming, current)).toBe(false);
    });

    it('should return false when timestamps are equal', () => {
      const incoming = { savedAt: '2025-01-15T10:00:00.000Z' } as DockSnapshot;
      const current = { savedAt: '2025-01-15T10:00:00.000Z' } as DockSnapshot;
      expect(context.getService().isSnapshotNewer(incoming, current)).toBe(false);
    });

    it('should return false when incoming savedAt is invalid', () => {
      const incoming = { savedAt: 'not-a-date' } as DockSnapshot;
      const current = { savedAt: '2025-01-15T10:00:00.000Z' } as DockSnapshot;
      expect(context.getService().isSnapshotNewer(incoming, current)).toBe(false);
    });

    it('should return true when current savedAt is invalid', () => {
      const incoming = { savedAt: '2025-01-15T10:00:00.000Z' } as DockSnapshot;
      const current = { savedAt: 'garbage' } as DockSnapshot;
      expect(context.getService().isSnapshotNewer(incoming, current)).toBe(true);
    });

    it('should return false when both savedAt are invalid', () => {
      const incoming = { savedAt: 'bad1' } as DockSnapshot;
      const current = { savedAt: 'bad2' } as DockSnapshot;
      expect(context.getService().isSnapshotNewer(incoming, current)).toBe(false);
    });
  });
}
