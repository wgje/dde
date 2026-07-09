import {
  BACKUP_CONFIG,
  buildTableCounts,
  type BackupBlackBoxEntry,
  type BackupConnection,
  type BackupCoverage,
  type BackupData,
  type BackupFocusSession,
  type BackupLocalState,
  type BackupProject,
  type BackupRoutineCompletion,
  type BackupRoutineTask,
  type BackupTask,
  type BackupTranscriptionUsage,
  type BackupUserPreferences,
} from '../../supabase/functions/_shared/backup-utils';

type BackupPayloadBase = Pick<BackupData, 'projects' | 'tasks' | 'connections'>;

type BackupRemoteState = {
  focusSessions: BackupFocusSession[];
  transcriptionUsage: BackupTranscriptionUsage[];
  routineTasks: BackupRoutineTask[];
  routineCompletions: BackupRoutineCompletion[];
};

type CreateLocalDisasterBackupPayloadOptions = {
  payloadBase: BackupPayloadBase;
  userPreferences: BackupUserPreferences[];
  blackBoxEntries: BackupBlackBoxEntry[];
  remoteState: BackupRemoteState;
  localState: BackupLocalState;
  coverage: BackupCoverage;
  calculateChecksum: (json: string) => Promise<string>;
};

export async function createLocalDisasterBackupPayload(
  options: CreateLocalDisasterBackupPayloadOptions
): Promise<BackupData> {
  const provisionalPayload: BackupData = {
    version: BACKUP_CONFIG.VERSION,
    payloadVersion: BACKUP_CONFIG.VERSION,
    type: 'full',
    createdAt: new Date().toISOString(),
    checksum: '',
    tableCounts: {
      projects: 0,
      tasks: 0,
      connections: 0,
      userPreferences: 0,
      blackBoxEntries: 0,
      focusSessions: 0,
      transcriptionUsage: 0,
      routineTasks: 0,
      routineCompletions: 0,
    },
    coverage: options.coverage,
    ...options.payloadBase,
    userPreferences: options.userPreferences,
    blackBoxEntries: options.blackBoxEntries,
    focusSessions: options.remoteState.focusSessions,
    transcriptionUsage: options.remoteState.transcriptionUsage,
    routineTasks: options.remoteState.routineTasks,
    routineCompletions: options.remoteState.routineCompletions,
    localState: options.localState,
  };

  const tableCounts = buildTableCounts(provisionalPayload);
  const checksumPayload = {
    ...provisionalPayload,
    tableCounts,
    checksum: '',
  };
  const checksum = await options.calculateChecksum(JSON.stringify(checksumPayload));

  return {
    ...provisionalPayload,
    tableCounts,
    checksum,
  };
}

export type {
  BackupConnection,
  BackupPayloadBase,
  BackupProject,
  BackupRemoteState,
  BackupTask,
};
