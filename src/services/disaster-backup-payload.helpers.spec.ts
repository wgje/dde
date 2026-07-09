import { describe, expect, it, vi } from 'vitest';
import type {
  BackupBlackBoxEntry,
  BackupLocalState,
  BackupProject,
  BackupUserPreferences,
} from '../../supabase/functions/_shared/backup-utils';
import { createLocalDisasterBackupPayload } from './disaster-backup-payload.helpers';

describe('disaster backup payload helpers', () => {
  it('assembles a full local backup payload with table counts and checksum', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-09T00:00:00.000Z'));

    const project: BackupProject = {
      id: 'project-1',
      userId: 'user-1',
      name: 'Inbox',
    };
    const userPreference: BackupUserPreferences = {
      id: 'pref-1',
      userId: 'user-1',
    };
    const blackBoxEntry: BackupBlackBoxEntry = {
      id: 'entry-1',
      userId: 'user-1',
      content: 'note',
    };
    const localState: BackupLocalState = {
      retryQueue: [{ id: 'retry-1' }],
    };

    const payload = await createLocalDisasterBackupPayload({
      payloadBase: {
        projects: [project],
        tasks: [],
        connections: [],
      },
      userPreferences: [userPreference],
      blackBoxEntries: [blackBoxEntry],
      remoteState: {
        focusSessions: [],
        transcriptionUsage: [],
        routineTasks: [],
        routineCompletions: [],
      },
      localState,
      coverage: {
        includesProjectData: true,
        includesCloudUserState: true,
        includesLocalState: true,
      },
      calculateChecksum: vi.fn(async (json: string) => {
        expect(JSON.parse(json)).toMatchObject({
          checksum: '',
          tableCounts: {
            projects: 1,
            blackBoxEntries: 1,
            userPreferences: 1,
          },
        });
        return 'checksum-1';
      }),
    });

    expect(payload).toMatchObject({
      version: '2.0.0',
      payloadVersion: '2.0.0',
      type: 'full',
      createdAt: '2026-06-09T00:00:00.000Z',
      checksum: 'checksum-1',
      coverage: {
        includesProjectData: true,
        includesCloudUserState: true,
        includesLocalState: true,
      },
      tableCounts: {
        projects: 1,
        tasks: 0,
        connections: 0,
        userPreferences: 1,
        blackBoxEntries: 1,
        focusSessions: 0,
        transcriptionUsage: 0,
        routineTasks: 0,
        routineCompletions: 0,
      },
    });
    expect(payload.projects).toEqual([project]);
    expect(payload.blackBoxEntries).toEqual([blackBoxEntry]);
    expect(payload.localState).toBe(localState);

    vi.useRealTimers();
  });
});
