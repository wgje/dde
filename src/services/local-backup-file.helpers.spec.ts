import { describe, expect, it } from 'vitest';

import {
  buildLocalBackupFilename,
  createLocalBackupTimestamp,
  getOldLocalBackupFilesToDelete,
  parseLocalBackupTimestampFromFilename,
} from './local-backup-file.helpers';

describe('local-backup-file.helpers', () => {
  it('builds a backup filename from a stable timestamp', () => {
    expect(buildLocalBackupFilename('2026-06-09_12-30-45'))
      .toBe('nanoflow-backup-2026-06-09_12-30-45.json');
  });

  it('formats local backup timestamps using filename-safe separators', () => {
    const date = new Date(2026, 5, 9, 12, 30, 45);

    expect(createLocalBackupTimestamp(date)).toBe('2026-06-09_12-30-45');
  });

  it('parses timestamps only from valid local backup filenames', () => {
    const expected = new Date(2026, 5, 9, 12, 30, 45).getTime();

    expect(parseLocalBackupTimestampFromFilename('nanoflow-backup-2026-06-09_12-30-45.json'))
      .toBe(expected);
    expect(parseLocalBackupTimestampFromFilename('notes-2026-06-09_12-30-45.json'))
      .toBeNull();
    expect(parseLocalBackupTimestampFromFilename('nanoflow-backup-invalid.json'))
      .toBeNull();
  });

  it('sorts backup files by newest first and returns files beyond the retention limit', () => {
    const files = [
      { name: 'old.json', timestamp: 100 },
      { name: 'new.json', timestamp: 300 },
      { name: 'middle.json', timestamp: 200 },
    ];

    expect(getOldLocalBackupFilesToDelete(files, 2)).toEqual([
      { name: 'old.json', timestamp: 100 },
    ]);
    expect(files).toEqual([
      { name: 'old.json', timestamp: 100 },
      { name: 'new.json', timestamp: 300 },
      { name: 'middle.json', timestamp: 200 },
    ]);
  });
});
