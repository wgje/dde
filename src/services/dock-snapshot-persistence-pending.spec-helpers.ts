import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DockSnapshotPersistenceService as DockSnapshotPersistenceServiceType,
} from './dock-snapshot-persistence.service';
import type { DockSnapshot } from '../models/parking-dock';

interface DockSnapshotPendingPersistSpecContext {
  getService: () => DockSnapshotPersistenceServiceType;
  makeMinimalSnapshot: (overrides?: Record<string, unknown>) => Record<string, unknown>;
  mockSet: () => ReturnType<typeof vi.fn>;
}

async function callNormalizeNullableNumber(value: unknown): Promise<number | null> {
  const { normalizeNullableNumber } = await import('./dock-snapshot-persistence.service');
  return normalizeNullableNumber(value);
}

export function registerDockSnapshotPendingPersistSpecs(
  context: DockSnapshotPendingPersistSpecContext,
): void {
  describe('cancelPendingPersist', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should not throw when called without pending persist', () => {
      expect(() => context.getService().cancelPendingPersist()).not.toThrow();
    });

    it('should shadow a scheduled snapshot to localStorage before canceling the debounced IDB write', () => {
      const service = context.getService();
      // Schedule a persist, then cancel it
      const snapshotFn = vi.fn(() =>
        context.makeMinimalSnapshot({
          focusMode: false,
          session: {
            firstDragIntervened: false,
            focusBlurOn: false,
            focusScrimOn: false,
            mainTaskId: null,
            comboSelectIds: [],
            backupIds: [],
          },
          savedAt: '2025-01-15T11:00:00.000Z',
        }) as unknown as DockSnapshot,
      );
      service.scheduleLocalPersist(snapshotFn, 'user-1', () => 0);

      // Cancel before the debounce fires
      service.cancelPendingPersist();

      // Advance past debounce interval
      vi.advanceTimersByTime(1000);

      expect(snapshotFn).toHaveBeenCalledTimes(1);
      expect(context.mockSet()).not.toHaveBeenCalled();
      expect(
        JSON.parse(localStorage.getItem(service.legacyLocalStorageKey('user-1')) ?? '{}'),
      ).toMatchObject({
        focusMode: false,
        savedAt: '2025-01-15T11:00:00.000Z',
      });
    });

    it('should be idempotent', () => {
      const service = context.getService();
      service.cancelPendingPersist();
      service.cancelPendingPersist();
      // no throw
    });

    it('discardPendingPersist should drop scheduled snapshot without shadow persist', async () => {
      const service = context.getService();
      const snapshotFn = vi.fn(() =>
        context.makeMinimalSnapshot({
          savedAt: '2025-01-15T12:00:00.000Z',
        }) as unknown as DockSnapshot,
      );
      service.scheduleLocalPersist(snapshotFn, 'user-1', () => 0);

      await service.discardPendingPersist();
      vi.advanceTimersByTime(1000);

      expect(snapshotFn).not.toHaveBeenCalled();
      expect(context.mockSet()).not.toHaveBeenCalled();
      expect(localStorage.getItem(service.legacyLocalStorageKey('user-1'))).toBeNull();
    });
  });
}

export function registerNormalizeNullableNumberSpecs(): void {
  describe('normalizeNullableNumber', () => {
    it('should return null for null', async () => {
      await expect(callNormalizeNullableNumber(null)).resolves.toBeNull();
    });

    it('should return null for undefined', async () => {
      await expect(callNormalizeNullableNumber(undefined)).resolves.toBeNull();
    });

    it('should return null for empty string', async () => {
      await expect(callNormalizeNullableNumber('')).resolves.toBeNull();
    });

    it('should return null for NaN', async () => {
      await expect(callNormalizeNullableNumber(NaN)).resolves.toBeNull();
    });

    it('should return null for Infinity', async () => {
      await expect(callNormalizeNullableNumber(Infinity)).resolves.toBeNull();
    });

    it('should return null for -Infinity', async () => {
      await expect(callNormalizeNullableNumber(-Infinity)).resolves.toBeNull();
    });

    it('should return null for non-numeric string', async () => {
      await expect(callNormalizeNullableNumber('abc')).resolves.toBeNull();
    });

    it('should return number for numeric value', async () => {
      await expect(callNormalizeNullableNumber(42)).resolves.toBe(42);
    });

    it('should return number for zero', async () => {
      await expect(callNormalizeNullableNumber(0)).resolves.toBe(0);
    });

    it('should return number for negative value', async () => {
      await expect(callNormalizeNullableNumber(-10)).resolves.toBe(-10);
    });

    it('should parse numeric string to number', async () => {
      await expect(callNormalizeNullableNumber('123')).resolves.toBe(123);
    });

    it('should parse float string to number', async () => {
      await expect(callNormalizeNullableNumber('3.14')).resolves.toBe(3.14);
    });
  });
}
